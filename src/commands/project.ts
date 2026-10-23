import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REVIEW_SETUP } from "../changes.ts";
import { CONFIG_FILE, UsageError } from "../config.ts";
import { git, initialCommit } from "../vcs.ts";

// style/ternlatex-review.tex is regenerated from ternlatex.toml before every build.
const IGNORED = ["build/", REVIEW_SETUP];

/** Appends the LINES missing from the ignore file FILE (creating it), after HEADER when it adds any. */
function appendIgnores(file: string, lines: string[], header?: string): string[] {
  const have = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const missing = lines.filter((l) => !have.includes(l));
  if (!missing.length) return [];
  mkdirSync(dirname(file), { recursive: true });
  const lead = have.length && have.at(-1) !== "" ? "\n" : "";
  appendFileSync(file, lead + [...(header ? [header] : []), ...missing].join("\n") + "\n");
  return missing;
}

/** Makes DIR a git repo (unless it already is in one), keeps build output out of it, and makes the first commit if there is none. */
export async function ensureGit(dir: string): Promise<void> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.spawnError) {
    console.warn(`${inside.spawnError}\nskipping repository setup (omp edits will not be reviewable as diffs)`);
    return;
  }
  if (inside.code !== 0) await git(dir, ["init", "-q"]);
  appendIgnores(join(dir, ".gitignore"), IGNORED);
  await initialCommit(dir);
}

/**
 * Sets up the repository of an adopted project. One that already has commits (a clone: of an Overleaf project, a
 * co-author's repo) is left exactly as it is: ternlatex's own files (ternlatex.toml, the outdir, the review setup) go
 * into the clone's local `.git/info/exclude`, never into `.gitignore` or a commit, so nothing of ternlatex is ever
 * pushed. Checkpoints already live on a ref of their own that a push leaves behind. Anything else gets ensureGit.
 * Returns whether the repository was left alone.
 */
export async function adoptGit(dir: string, outdir: string): Promise<boolean> {
  const head = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.spawnError || head.code !== 0) {
    await ensureGit(dir);
    return false;
  }
  // Exclude patterns are relative to the repository root; DIR may be a folder inside it.
  const prefix = (await git(dir, ["rev-parse", "--show-prefix"])).stdout.trim();
  const exclude = resolve(dir, (await git(dir, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim());
  const own = [CONFIG_FILE, `${outdir.replace(/^\.\/|\/+$/g, "")}/`, REVIEW_SETUP].map((p) => `/${prefix}${p}`);
  const added = appendIgnores(exclude, own, "# ternlatex's files, kept out of this repository (never committed or pushed)");
  if (added.length) console.log(`kept out of git (in .git/info/exclude, not pushed): ${added.map((p) => p.slice(1 + prefix.length)).join(", ")}`);
  return true;
}

/** Parses `FILE:LINE` (FILE relative to the current directory) into an absolute path and line. */
export function parseLocation(spec: string): { file: string; line: number } {
  const m = /^(.+):(\d+)$/.exec(spec);
  if (!m) throw new UsageError(`expected FILE:LINE, got "${spec}"`);
  const file = resolve(m[1]);
  if (!existsSync(file)) throw new UsageError(`${m[1]} does not exist`);
  return { file, line: Number(m[2]) };
}
