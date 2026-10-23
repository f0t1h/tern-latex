import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Config } from "./config.ts";
import { resolveTool } from "./tools.ts";

/** Where checkpoints live: outside refs/heads, so branches, HEAD and the stash never see them. */
export const CHECKPOINT_REF = "refs/ternlatex/checkpoints";

/** Used when the user has no git identity configured, so checkpoints and the first commit still work. */
const FALLBACK_IDENTITY = ["-c", "user.name=ternlatex", "-c", "user.email=ternlatex@localhost"];

export interface Checkpoint {
  sha: string;
  /** ISO 8601 committer date. */
  date: string;
  message: string;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when git could not be found or started. */
  spawnError?: string;
}

export interface GitOptions {
  env?: Record<string, string>;
  /** Kills git after this long (a network fetch); it then fails like any other git error. */
  timeoutMs?: number;
}

/** Runs the resolved git in CWD. Never throws; check `code`. */
export async function git(cwd: string, args: string[], o: GitOptions = {}): Promise<GitResult> {
  let command: string[];
  try {
    command = (await resolveTool("git")).command;
  } catch (e) {
    return { code: null, stdout: "", stderr: "", spawnError: e instanceof Error ? e.message : String(e) };
  }
  const { promise, resolve } = Promise.withResolvers<GitResult>();
  const child = spawn(command[0], [...command.slice(1), ...args], {
    cwd,
    env: { ...process.env, ...o.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => (stdout += b));
  child.stderr.on("data", (b: Buffer) => (stderr += b));
  child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError: `cannot run ${command[0]}: ${e.code ?? e.message}` }));
  const timer = o.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), o.timeoutMs) : undefined;
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr: code === null && timer ? `${stderr}timed out after ${(o.timeoutMs ?? 0) / 1000} s` : stderr });
  });
  return promise;
}

/** Runs git and returns trimmed stdout, throwing with git's stderr on failure. */
export async function gitOk(cwd: string, args: string[], o: GitOptions = {}): Promise<string> {
  const r = await git(cwd, args, o);
  if (r.spawnError) throw new Error(r.spawnError);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

interface Repo {
  /** Absolute path of the private checkpoint index. */
  index: string;
  /** Identity flags to prepend to commit-creating commands ([] when the user has one). */
  identity: string[];
}

const repos = new Map<string, Repo>();

/** The repo facts checkpointing needs, cached per project; null when DIR is not in a git work tree. */
async function repo(dir: string): Promise<Repo | null> {
  const cached = repos.get(dir);
  if (cached) return cached;
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree", "--git-path", "ternlatex/index"]);
  if (r.code !== 0) return null;
  const [inside, rel] = r.stdout.trim().split("\n");
  if (inside !== "true" || !rel) return null;
  const index = isAbsolute(rel) ? rel : join(dir, rel);
  await mkdir(dirname(index), { recursive: true });
  const found: Repo = { index, identity: await identityFlags(dir) };
  repos.set(dir, found);
  return found;
}

/** [] when git has a configured (not guessed) committer identity, else the fallback flags. */
async function identityFlags(dir: string): Promise<string[]> {
  const r = await git(dir, ["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"]);
  return r.code === 0 ? [] : FALLBACK_IDENTITY;
}

/** Checkpoints of one process run one at a time; update-ref's compare-and-swap guards against other processes. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Snapshots the working tree (tracked and untracked files, honouring .gitignore) as a commit on
 * refs/ternlatex/checkpoints. Uses a private index, so HEAD, the user's index, the working tree and
 * the stash are untouched. Returns the new commit, or null when nothing changed since the last
 * checkpoint or the project is not in a git repo.
 */
export function checkpoint(cfg: Config, message: string): Promise<string | null> {
  return serial(() => checkpointNow(cfg.dir, message));
}

async function checkpointNow(dir: string, message: string): Promise<string | null> {
  const r = await repo(dir);
  if (!r) return null;
  const env = { GIT_INDEX_FILE: r.index };
  // Another ternlatex process may move the ref between our read and update-ref; retry on a lost race.
  for (let attempt = 0; ; attempt++) {
    const head = await gitOk(dir, ["for-each-ref", "--format=%(objectname) %(tree)", CHECKPOINT_REF]);
    const [prev, prevTree] = head ? head.split(" ") : [];
    await gitOk(dir, ["add", "-A", "--ignore-errors", "--", ":/"], { env });
    const tree = await gitOk(dir, ["write-tree"], { env });
    if (tree === prevTree) return null;
    const sha = await gitOk(dir, [...r.identity, "commit-tree", tree, ...(prev ? ["-p", prev] : []), "-m", message]);
    // An empty old value means "must not exist yet".
    const cas = await git(dir, ["update-ref", "-m", `ternlatex: ${message}`, CHECKPOINT_REF, sha, prev ?? ""]);
    if (cas.code === 0) return sha;
    if (attempt === 2) throw new Error(`git update-ref ${CHECKPOINT_REF} failed: ${cas.stderr.trim()}`);
  }
}

/** Checkpoints, newest first; [] when there are none or the project is not in a git repo. */
export async function listCheckpoints(cfg: Config, limit = 20): Promise<Checkpoint[]> {
  const r = await git(cfg.dir, ["log", `--max-count=${limit}`, "--format=%H%x00%cI%x00%s", CHECKPOINT_REF, "--"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, date, message] = l.split("\0");
      return { sha, date, message };
    });
}

/** Resolves REV (any git revision, e.g. HEAD~2 or refs/ternlatex/checkpoints~3) to a commit sha. */
export async function resolveRev(cfg: Config, rev: string): Promise<string> {
  const r = await git(cfg.dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (r.code !== 0) throw new Error(`unknown revision "${rev}"`);
  return r.stdout.trim();
}

/**
 * Restores the working tree (or PATHS, relative to the project) from REV after checkpointing the
 * current state. Files created since REV are removed too. The user's index and HEAD are untouched.
 */
export async function restore(cfg: Config, rev: string, paths: string[] = []): Promise<void> {
  const sha = await resolveRev(cfg, rev);
  const r = await repo(cfg.dir);
  if (!r) throw new Error(`${cfg.dir} is not in a git repository`);
  await serial(async () => {
    await checkpointNow(cfg.dir, `before restore to ${rev}`);
    // `git restore --worktree` deletes paths that are in the index but not in the source. Against a
    // throwaway index holding the checkpoint just taken, that covers untracked files as well.
    const env = { GIT_INDEX_FILE: `${r.index}.restore` };
    try {
      await gitOk(cfg.dir, ["read-tree", CHECKPOINT_REF], { env });
      await gitOk(cfg.dir, ["restore", `--source=${sha}`, "--worktree", "--", ...(paths.length ? paths : ["."])], { env });
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
  });
}

/** Makes the first commit (everything not ignored) when DIR is a git repo without one. */
export async function initialCommit(dir: string): Promise<void> {
  const r = await repo(dir);
  if (!r) return;
  if ((await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) return;
  await gitOk(dir, ["add", "-A", "--", ":/"]);
  if ((await git(dir, ["diff", "--cached", "--quiet"])).code === 0) return;
  await gitOk(dir, [...r.identity, "commit", "--quiet", "--no-verify", "-m", "ternlatex: initial project"]);
}
