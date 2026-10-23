import { git, type GitResult } from "./vcs.ts";

/**
 * Keeping a clone of an Overleaf project current. Overleaf's Git bridge has one branch and co-authors keep editing
 * in the browser, so before omp edits (omp/extension.ts calls `ternlatex pull`) the clone is rebased onto Overleaf's
 * latest. It never pushes, never merges into files with uncommitted edits, and undoes a rebase that conflicts.
 */

/** Overleaf Cloud (`https://git.overleaf.com/<id>`) or Server Pro (`https://<host>/git/<id>`); ids are 24 hex digits. */
export function isOverleafUrl(url: string): boolean {
  return /^(https?:\/\/)?([^/@]+@)?git\.overleaf\.com\/[0-9a-f]{24}\/?(\.git)?$/i.test(url) || /^https?:\/\/([^/@]+@)?[^/]+\/git\/[0-9a-f]{24}\/?(\.git)?$/i.test(url);
}

export interface PullResult {
  /** The branch tracks an Overleaf remote; nothing else happens otherwise. */
  overleaf: boolean;
  /** Commits pulled from Overleaf (0: already current). */
  pulled: number;
  /** Files those commits changed, repository-relative. */
  files: string[];
  /** Why the clone was not brought up to date (left exactly as it was). */
  problem?: string;
}

// git() never prompts (GIT_TERMINAL_PROMPT=0): an expired token fails the fetch instead of hanging the agent.
const FETCH_TIMEOUT_MS = 60_000;

function lines(r: GitResult): string[] {
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function failure(r: GitResult): string {
  return r.spawnError ?? (r.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${r.code}`);
}

/** Rebases DIR's branch onto its Overleaf upstream when that is behind; see the module comment. */
export async function pullOverleaf(dir: string): Promise<PullResult> {
  const none: PullResult = { overleaf: false, pulled: 0, files: [] };
  const upstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) return none;
  const remote = upstream.stdout.trim().split("/")[0];
  // The configured URL: `remote get-url` would expand a url.<base>.insteadOf rewrite.
  const url = await git(dir, ["config", "--get", `remote.${remote}.url`]);
  if (url.code !== 0 || !isOverleafUrl(url.stdout.trim())) return none;

  const fetched = await git(dir, ["fetch", "--quiet", remote], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) return { overleaf: true, pulled: 0, files: [], problem: `could not fetch from Overleaf: ${failure(fetched)}` };
  const behind = Number((await git(dir, ["rev-list", "--count", "HEAD..@{u}"])).stdout.trim()) || 0;
  if (!behind) return { overleaf: true, pulled: 0, files: [] };
  const files = lines(await git(dir, ["diff", "--name-only", "HEAD...@{u}"]));

  // Uncommitted edits to a file Overleaf also changed would need a merge by hand; leave the clone alone then.
  const dirty = lines(await git(dir, ["diff", "--name-only", "HEAD"]));
  const clash = dirty.filter((f) => files.includes(f));
  if (clash.length) {
    return { overleaf: true, pulled: 0, files, problem: `Overleaf has ${behind} new commit(s) changing ${clash.join(", ")}, which also has uncommitted edits here; commit them, then pull and resolve` };
  }
  // Local commits are replayed on top of Overleaf's; uncommitted edits to other files are stashed and restored.
  const rebased = await git(dir, ["rebase", "--autostash", "--quiet", "@{u}"]);
  if (rebased.code !== 0) {
    await git(dir, ["rebase", "--abort"]);
    return { overleaf: true, pulled: 0, files, problem: `rebasing onto Overleaf's ${behind} new commit(s) conflicts with local commits (undone): ${failure(rebased)}` };
  }
  return { overleaf: true, pulled: behind, files };
}
