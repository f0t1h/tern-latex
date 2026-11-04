import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Status } from "./builder.ts";
import { reviewer, scanChanges } from "./changes.ts";
import { type Config, docPaths, posix } from "./config.ts";
import { parseDeps } from "./engine.ts";
import { git, type GitResult } from "./vcs.ts";

/**
 * Keeping a clone of an Overleaf project in step with Overleaf. Overleaf's Git bridge has one branch and co-authors
 * keep editing in the browser, so the clone is rebased onto Overleaf's latest: before omp edits (omp/extension.ts
 * calls `ternlatex pull`), and in the background while `dev` runs (OverleafSync). It never merges into files with
 * uncommitted (or, in Tern, unsaved) edits, and undoes a rebase that conflicts. Pushing is asked for
 * (`ternlatex push`, the viewer): it pushes only the user's own edits, from a build that works.
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
  /** The problem is that Overleaf could not be reached (network, an expired token). */
  offline?: boolean;
  /** The problem is that these files changed on both sides: here (commits or uncommitted edits) and on Overleaf. */
  conflicts?: string[];
}

// git() never prompts (GIT_TERMINAL_PROMPT=0): an expired token fails the fetch instead of hanging the agent.
const FETCH_TIMEOUT_MS = 60_000;

function lines(r: GitResult): string[] {
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function failure(r: GitResult): string {
  return r.spawnError ?? (r.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${r.code}`);
}

/** The branch's Overleaf upstream (remote and branch), or null when it tracks no Overleaf remote. */
async function overleafRemote(dir: string): Promise<{ remote: string; branch: string } | null> {
  const upstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) return null;
  const [remote, ...rest] = upstream.stdout.trim().split("/");
  // The configured URL: `remote get-url` would expand a url.<base>.insteadOf rewrite.
  const url = await git(dir, ["config", "--get", `remote.${remote}.url`]);
  return url.code === 0 && isOverleafUrl(url.stdout.trim()) ? { remote, branch: rest.join("/") } : null;
}

/** Rebases DIR's branch onto its Overleaf upstream when that is behind; see the module comment. */
export async function pullOverleaf(dir: string): Promise<PullResult> {
  const none: PullResult = { overleaf: false, pulled: 0, files: [] };
  const upstream = await overleafRemote(dir);
  if (upstream === null) return none;

  const fetched = await git(dir, ["fetch", "--quiet", upstream.remote], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) return { overleaf: true, pulled: 0, files: [], problem: `could not fetch from Overleaf: ${failure(fetched)}`, offline: true };
  const behind = Number((await git(dir, ["rev-list", "--count", "HEAD..@{u}"])).stdout.trim()) || 0;
  if (!behind) return { overleaf: true, pulled: 0, files: [] };
  const files = lines(await git(dir, ["diff", "--name-only", "HEAD...@{u}"]));

  // Uncommitted edits to a file Overleaf also changed would need a merge by hand; leave the clone alone then.
  const dirty = lines(await git(dir, ["diff", "--name-only", "HEAD"]));
  const clash = dirty.filter((f) => files.includes(f));
  if (clash.length) {
    return { overleaf: true, pulled: 0, files, conflicts: clash, problem: `Overleaf has ${behind} new commit(s) changing ${clash.join(", ")}, which also has uncommitted edits here; commit them, then pull and resolve` };
  }
  // Local commits are replayed on top of Overleaf's; uncommitted edits to other files are stashed and restored.
  const rebased = await git(dir, ["rebase", "--autostash", "--quiet", "@{u}"]);
  if (rebased.code !== 0) {
    const conflicted = lines(await git(dir, ["diff", "--name-only", "--diff-filter=U"]));
    await git(dir, ["rebase", "--abort"]);
    const where = conflicted.length ? `in ${conflicted.join(", ")}` : `(${failure(rebased)})`;
    return {
      overleaf: true,
      pulled: 0,
      files,
      conflicts: conflicted.length ? conflicted : files,
      problem: `your commits conflict with Overleaf's ${behind} new commit(s) ${where}; nothing was pulled and your commits are kept: merge them with \`git pull --rebase\`, or ask omp to`,
    };
  }
  return { overleaf: true, pulled: behind, files };
}

/** Where the clone stands against Overleaf, as the viewer shows it. */
export interface OverleafState {
  /** Commits Overleaf has that the clone hasn't, and the other way round. */
  behind: number;
  ahead: number;
  /** Files Overleaf's new commits change. */
  incoming: string[];
  /** Files with edits not committed yet (git's view; Tern's unsaved buffers come on top). */
  edited: string[];
  /** Why the last background pull didn't happen, or failed. */
  problem?: string;
  /** Overleaf could not be reached at the last check: the numbers are from the last fetch that worked. */
  offline: boolean;
  /** Files changed both here and on Overleaf, so no pull happened (a merge needs the user). */
  conflicts: string[];
  /** The last background pull: how many commits, which files. */
  pulled?: { commits: number; files: string[] };
  /** Co-authors with commits on Overleaf in the last RECENT_DAYS, most recent first (the user left out). */
  people: Collaborator[];
  checkedAt: string;
}

/** Someone whose edits reached Overleaf lately, from its commits' authors. */
export interface Collaborator {
  name: string;
  email: string;
  /** Their latest commit's author date, ISO. */
  lastAt: string;
  commits: number;
  /** Files their commits changed, the most recent first (up to RECENT_FILES). */
  files: string[];
  /** Where their latest commit changed a .tex file, if it did and the file is still here. */
  edit?: LastEdit;
}

/** A co-author's latest edit: a line of the working copy (their line, moved by the edits made since) and its text. */
export interface LastEdit {
  file: string;
  line: number;
  /** The text they wrote there, one line, shortened; "deleted: …" when they only removed text. */
  snippet: string;
}

const RECENT_DAYS = 7;
const RECENT_FILES = 6;
const RECENT_PEOPLE = 8;
const SNIPPET_CHARS = 100;

/**
 * Co-authors from Overleaf's commits of the last week. Overleaf writes a commit per version of its history, under
 * the account that edited, so its newest commit says when and where someone last edited there. The user (git's
 * user.email, else user.name) is left out.
 */
export async function collaborators(dir: string, rev = "@{u}"): Promise<Collaborator[]> {
  const log = await git(dir, ["log", rev, `--since=${RECENT_DAYS}.days.ago`, "--format=%x1e%H%x1f%an%x1f%ae%x1f%aI", "--name-only"]);
  if (log.code !== 0) return [];
  const myEmail = (await git(dir, ["config", "user.email"])).stdout.trim().toLowerCase();
  const myName = (await git(dir, ["config", "user.name"])).stdout.trim().toLowerCase();
  const people = new Map<string, Collaborator>();
  const latest = new Map<Collaborator, string>();
  for (const record of log.stdout.split("\x1e").slice(1)) {
    const [head, ...rest] = record.split("\n");
    const [sha = "", name = "", email = "", date = ""] = head.split("\x1f");
    if (myEmail ? email.toLowerCase() === myEmail : name.toLowerCase() === myName) continue;
    const key = (email || name).toLowerCase();
    // git log runs newest first: the first record of a person is their latest.
    let p = people.get(key);
    if (!p) {
      p = { name, email, lastAt: new Date(date).toISOString(), commits: 0, files: [] };
      people.set(key, p);
      latest.set(p, sha);
    }
    p.commits++;
    for (const f of rest.map((l) => l.trim()).filter(Boolean)) if (p.files.length < RECENT_FILES && !p.files.includes(f)) p.files.push(f);
  }
  const recent = [...people.values()].slice(0, RECENT_PEOPLE);
  for (const p of recent) {
    const edit = await lastEdit(dir, latest.get(p) ?? "");
    if (edit) p.edit = edit;
  }
  return recent;
}

/** One hunk of a `git diff -U0 --no-prefix`: OLD lines oldStart… replaced by NEW lines newStart…, 1-based. */
export interface DiffHunk {
  file: string;
  /** The file is gone on the new side. */
  deleted: boolean;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  added: string[];
  removed: string[];
}

/** The hunks of a zero-context diff (`git diff -U0 --no-prefix` or `git show`), in order. */
export function diffHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let file = "";
  let deleted = false;
  let hunk: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      hunk = null;
      file = "";
      deleted = false;
    } else if (!hunk && line.startsWith("+++ ")) {
      deleted = line === "+++ /dev/null";
      if (!deleted) file = line.slice(4).replace(/\t$/, "");
    } else if (!hunk && line.startsWith("--- ") && line !== "--- /dev/null") {
      file ||= line.slice(4).replace(/\t$/, "");
    } else if (line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || !file) continue;
      hunk = { file, deleted, oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], added: [], removed: [] };
      out.push(hunk);
    } else if (hunk && line.startsWith("+")) hunk.added.push(line.slice(1));
    else if (hunk && line.startsWith("-")) hunk.removed.push(line.slice(1));
  }
  return out;
}

/**
 * The place a commit's diff points at: its largest hunk in a .tex file (the last of equals), at the first line it
 * wrote, or the line after text it only removed.
 */
export function editOf(hunks: DiffHunk[]): LastEdit | null {
  let best: DiffHunk | null = null;
  for (const h of hunks) {
    if (h.deleted || !h.file.endsWith(".tex")) continue;
    if (!best || h.added.length + h.removed.length >= best.added.length + best.removed.length) best = h;
  }
  if (!best) return null;
  const text = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ").trim();
  const wrote = text(best.added);
  const snippet = wrote || `deleted: ${text(best.removed)}`;
  return {
    file: best.file,
    line: Math.max(1, best.newCount ? best.newStart : best.newStart + 1),
    snippet: snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet,
  };
}

/**
 * Where LINE of a file's old side is on its new side, through one file's hunks of a zero-context diff: moved by
 * the lines added and removed above it; a line that changed itself goes to where its hunk now starts.
 */
export function mapLine(hunks: DiffHunk[], line: number): number {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      // Lines inserted after old line oldStart.
      if (line <= h.oldStart) break;
      delta += h.newCount;
      continue;
    }
    if (line < h.oldStart) break;
    if (line < h.oldStart + h.oldCount) return Math.max(1, h.newCount ? h.newStart : h.newStart + 1);
    delta += h.newCount - h.oldCount;
  }
  return line + delta;
}

const DIFF = ["-c", "core.quotePath=false", "diff", "-U0", "--no-prefix", "--no-color", "--no-ext-diff"];

/** Where commit SHA last edited a .tex file, as a line of the working copy now; null when there is no such place. */
async function lastEdit(dir: string, sha: string): Promise<LastEdit | null> {
  if (!sha) return null;
  const show = await git(dir, ["-c", "core.quotePath=false", "show", "-U0", "--no-prefix", "--no-color", "--no-ext-diff", "--format=", sha, "--", "*.tex"]);
  const edit = show.code === 0 ? editOf(diffHunks(show.stdout)) : null;
  if (!edit || !existsSync(join(dir, edit.file))) return null;
  // From their commit to the working copy: the edits since (theirs, others', the user's unsaved-to-git ones).
  const since = await git(dir, [...DIFF, sha, "--", edit.file]);
  if (since.code !== 0) return null;
  return { ...edit, line: mapLine(diffHunks(since.stdout), edit.line) };
}

/** DIR's position against Overleaf, after fetching it; null when DIR is no Overleaf clone. */
export async function overleafState(dir: string): Promise<OverleafState | null> {
  const upstream = await overleafRemote(dir);
  if (upstream === null) return null;
  const checkedAt = new Date().toISOString();
  const fetched = await git(dir, ["fetch", "--quiet", upstream.remote], { timeoutMs: FETCH_TIMEOUT_MS });
  const edited = lines(await git(dir, ["diff", "--name-only", "HEAD"]));
  const count = async (range: string) => Number((await git(dir, ["rev-list", "--count", range])).stdout.trim()) || 0;
  const behind = await count("HEAD..@{u}");
  const ahead = await count("@{u}..HEAD");
  const incoming = behind ? lines(await git(dir, ["diff", "--name-only", "HEAD...@{u}"])) : [];
  const state: OverleafState = { behind, ahead, incoming, edited, offline: false, conflicts: [], people: await collaborators(dir), checkedAt };
  return fetched.code === 0 ? state : { ...state, offline: true, problem: `could not reach Overleaf: ${failure(fetched)}` };
}

/** Review authors that aren't people: their marks are suggestions for the user, not edits to share. */
const MACHINE_AUTHORS: Record<string, string> = { omp: "omp", proof: "the proofreader", dictation: "dictation" };

export interface PushOptions {
  /** The commit message for the edits not committed yet; a default names the files. */
  message?: string;
  /** Builds every document (the dev server's builder, or a fresh one). */
  build: () => Promise<Status[]>;
}

export interface PushResult {
  /** Commits pushed to Overleaf. */
  pushed: number;
  /** Files the commit this push made holds (none when everything was committed already). */
  committed: string[];
  /** Commits pulled from Overleaf first. */
  pulled: number;
  /** Why nothing was pushed. */
  problem?: string;
}

/**
 * Pushes the clone's edits to Overleaf: refuses while omp, the proofreader or dictation still have marks in the
 * sources (so co-authors only ever get the user's own edits: accepting a suggestion makes it the user's) and
 * while a document fails to build (a partial PDF too); commits the edited tracked files and the untracked ones
 * a build reads (a new figure); rebases onto Overleaf's latest, builds again when that brought anything, pushes.
 */
export async function pushOverleaf(cfg: Config, o: PushOptions): Promise<PushResult> {
  const result = (problem?: string, more: Partial<PushResult> = {}): PushResult => ({ pushed: 0, committed: [], pulled: 0, ...more, ...(problem ? { problem } : {}) });
  const upstream = await overleafRemote(cfg.dir);
  if (upstream === null) return result("this project is no Overleaf clone (its branch tracks no git.overleaf.com remote)");

  const machine = scanChanges(cfg).filter((c) => c.author !== undefined && Object.hasOwn(MACHINE_AUTHORS, c.author));
  if (machine.length) {
    const who = [...new Set(machine.map((c) => MACHINE_AUTHORS[c.author ?? ""]))].join(", ");
    const where = machine.slice(0, 5).map((c) => `${c.file}:${c.line}`).join(", ");
    return result(`${machine.length} suggestion(s) by ${who} are still in the sources (${where}${machine.length > 5 ? ", …" : ""}): accept or reject them in ✎ Review first, so only your own edits go to Overleaf`);
  }
  const broken = async () => {
    const bad = (await o.build()).filter((s) => s.ok !== true);
    return bad.length ? `${bad.map((s) => s.doc).join(", ")} ${bad.some((s) => s.partial) ? "builds only partially" : "fails to build"}: fix that before pushing` : null;
  };
  const before = await broken();
  if (before) return result(before);

  // The edited tracked files, and the untracked files a build reads (a figure added here).
  const add = await git(cfg.dir, ["add", "-u"]);
  if (add.code !== 0) return result(`git add failed: ${failure(add)}`);
  for (const file of readFiles(cfg)) {
    const tracked = await git(cfg.dir, ["ls-files", "--error-unmatch", "--", file]);
    const ignored = await git(cfg.dir, ["check-ignore", "-q", "--", file]);
    if (tracked.code !== 0 && ignored.code !== 0) await git(cfg.dir, ["add", "--", file]);
  }
  const committed = lines(await git(cfg.dir, ["diff", "--cached", "--name-only"]));
  if (committed.length) {
    const message = o.message?.trim() || `Edits by ${reviewer(cfg).name}: ${committed.slice(0, 4).join(", ")}${committed.length > 4 ? ", …" : ""}`;
    const commit = await git(cfg.dir, ["commit", "--quiet", "-m", message]);
    if (commit.code !== 0) return result(`commit failed: ${failure(commit)}`);
  }

  let pulled = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const pull = await pullOverleaf(cfg.dir);
    if (pull.problem) return result(pull.problem, { committed, pulled });
    pulled += pull.pulled;
    if (pull.pulled) {
      const after = await broken();
      if (after) return result(`after pulling Overleaf's ${pull.pulled} new commit(s), ${after}`, { committed, pulled });
    }
    const ahead = Number((await git(cfg.dir, ["rev-list", "--count", "@{u}..HEAD"])).stdout.trim()) || 0;
    if (!ahead) return result(undefined, { committed, pulled });
    const push = await git(cfg.dir, ["push", "--quiet", upstream.remote, `HEAD:${upstream.branch}`], { timeoutMs: FETCH_TIMEOUT_MS });
    if (push.code === 0) return result(undefined, { pushed: ahead, committed, pulled });
    // Overleaf moved on meanwhile: pull its new commits and try once more.
    if (!/fetch first|non-fast-forward|rejected/i.test(push.stderr)) return result(`could not push to Overleaf: ${failure(push)}`, { committed, pulled });
  }
  return result("Overleaf kept changing while pushing; try again", { committed, pulled });
}

/** Project files the documents' last builds read (Tectonic's dependency lists), project-relative. */
function readFiles(cfg: Config): string[] {
  const out = new Set<string>();
  for (const doc of cfg.docs) {
    const p = docPaths(cfg, doc);
    if (!existsSync(p.deps)) continue;
    for (const f of parseDeps(readFileSync(p.deps, "utf8"), cfg.dir, relative(cfg.dir, p.staging))) out.add(posix(f));
  }
  return [...out];
}

/** Files open in Tern with unsaved edits, project-relative with `/` (none outside Tern). */
export type UnsavedFiles = () => Promise<string[]>;

export async function isOverleafClone(dir: string): Promise<boolean> {
  return (await overleafRemote(dir)) !== null;
}

const SYNC_MS = 60_000;

/**
 * Keeps a clone in step with Overleaf while `dev` runs: fetches every minute and rebases onto Overleaf's new
 * commits when none touches a file with edits here (uncommitted, or unsaved in Tern); otherwise it says so and
 * leaves the clone alone. Listeners get every new state (the viewer's Overleaf button).
 */
export class OverleafSync {
  #state: OverleafState | null = null;
  #timer?: NodeJS.Timeout;
  #running: Promise<OverleafState | null> | null = null;
  readonly #listeners = new Set<(s: OverleafState) => void>();
  readonly #cfg: Config;
  readonly #unsaved: UnsavedFiles;

  constructor(cfg: Config, unsaved: UnsavedFiles) {
    this.#cfg = cfg;
    this.#unsaved = unsaved;
  }

  get state(): OverleafState | null {
    return this.#state;
  }

  start(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), SYNC_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  onState(fn: (s: OverleafState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Fetches, and pulls when that is safe; one check at a time. */
  check(): Promise<OverleafState | null> {
    this.#running ??= this.#check().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #check(): Promise<OverleafState | null> {
    const dir = this.#cfg.dir;
    let state = await overleafState(dir);
    if (state && state.behind && !state.problem) {
      const unsaved = await this.#unsaved().catch((): string[] => []);
      const busy = state.incoming.filter((f) => unsaved.includes(f) || state?.edited.includes(f));
      if (busy.length) {
        state = { ...state, conflicts: busy, problem: `Overleaf changed ${busy.join(", ")}, which you're editing here: save and push your edits (or undo them), then pull` };
      } else {
        const pull = await pullOverleaf(dir);
        state = pull.problem
          ? { ...state, problem: pull.problem, offline: pull.offline === true, conflicts: pull.conflicts ?? [] }
          : { ...((await overleafState(dir)) ?? state), pulled: { commits: pull.pulled, files: pull.files } };
      }
    }
    if (state) this.#publish(state);
    return state;
  }

  /** Records a state another step (a push) produced. */
  #publish(state: OverleafState): void {
    this.#state = state;
    for (const fn of this.#listeners) fn(state);
  }

  /** Pushes (pushOverleaf), then checks again so the viewer shows the new standing. */
  async push(o: PushOptions): Promise<PushResult> {
    await this.#running;
    const r = await pushOverleaf(this.#cfg, o);
    await this.check();
    return r;
  }
}
