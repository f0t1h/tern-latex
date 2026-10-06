import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "../config.ts";
import { git, initialCommit } from "../vcs.ts";

// style/ternlatex-review.tex is regenerated from ternlatex.toml before every build.
const IGNORED = ["build/", ".omp/sessions/", "style/ternlatex-review.tex"];

/** Makes DIR a git repo (unless it already is in one), keeps build output out of it, and makes the first commit if there is none. */
export async function ensureGit(dir: string): Promise<void> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.spawnError) {
    console.warn(`${inside.spawnError}\nskipping repository setup (omp edits will not be reviewable as diffs)`);
    return;
  }
  if (inside.code !== 0) await git(dir, ["init", "-q"]);
  const gi = join(dir, ".gitignore");
  const have = existsSync(gi) ? readFileSync(gi, "utf8").split("\n") : [];
  const missing = IGNORED.filter((l) => !have.includes(l));
  if (missing.length) appendFileSync(gi, (have.length && have.at(-1) !== "" ? "\n" : "") + missing.join("\n") + "\n");
  await initialCommit(dir);
}

/** Parses `FILE:LINE` (FILE relative to the current directory) into an absolute path and line. */
export function parseLocation(spec: string): { file: string; line: number } {
  const m = /^(.+):(\d+)$/.exec(spec);
  if (!m) throw new UsageError(`expected FILE:LINE, got "${spec}"`);
  const file = resolve(m[1]);
  if (!existsSync(file)) throw new UsageError(`${m[1]} does not exist`);
  return { file, line: Number(m[2]) };
}
