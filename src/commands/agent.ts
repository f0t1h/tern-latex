import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { copyAssets, listAssets } from "../assets.ts";
import { loadConfig } from "../config.ts";
import { cacheDir, resolveTool, selfCommand, which } from "../tools.ts";

/**
 * Installs the omp kit: `.omp/AGENTS.md` (loaded as project context; a user's own root AGENTS.md is left
 * alone) and `.omp/skills/<name>/`. These files are owned by ternlatex and overwritten on every run.
 */
export async function setupAgent(target: string): Promise<number> {
  const omp = join(resolve(target), ".omp");
  await copyAssets("agent/", omp, { force: true });
  const skills = [...new Set(listAssets("agent/skills/").map((rel) => rel.split("/")[2]))];
  console.log(`omp kit installed in ${omp} (skills: ${skills.join(", ")})`);
  return 0;
}

export interface AgentOptions {
  /** PATH for omp and everything it runs (the agent block gets the dev server's PATH this way). */
  path?: string;
}

/**
 * Runs omp in the project, with a `ternlatex` launcher for this very ternlatex first on PATH. It continues the
 * project's most recent omp session (a fresh one when there is none), so reopening the omp block keeps context.
 */
export async function runAgent(target: string, o: AgentOptions = {}): Promise<number> {
  const cfg = loadConfig(target);
  if (!existsSync(join(cfg.dir, ".omp", "AGENTS.md"))) await setupAgent(cfg.dir);
  if (o.path !== undefined) process.env.PATH = o.path;
  const bin = join(cacheDir(), "bin");
  await writeLaunchers(bin);
  process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);
  const [omp, ...pre] = (await resolveTool("omp", cfg)).command;
  const child = spawn(omp, [...pre, "--continue"], { cwd: cfg.dir, stdio: "inherit", env: process.env });
  const { promise, resolve: done } = Promise.withResolvers<number>();
  child.on("error", (e) => {
    console.error(`ternlatex: cannot start ${omp}: ${e.message} (set TERNLATEX_OMP to the omp executable)`);
    done(127);
  });
  child.on("close", (code) => done(code ?? 1));
  return promise;
}

/**
 * Writes `ternlatex` (POSIX sh) and, on Windows, `ternlatex.cmd` into `dir`, each re-invoking selfCommand() with its
 * arguments; returns the files written.
 */
export async function writeLaunchers(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const self = selfCommand();
  const sh = which("sh");
  const quoted = self.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  const scripts: [name: string, text: string][] = [["ternlatex", `${sh ? `#!${sh}\n` : ""}exec ${quoted} "$@"\n`]];
  if (process.platform === "win32") scripts.push(["ternlatex.cmd", `@echo off\r\n${self.map((a) => `"${a}"`).join(" ")} %*\r\n`]);
  const written: string[] = [];
  for (const [name, text] of scripts) {
    // Via rename: a concurrent agent block may be running the launcher right now.
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, text);
    if (process.platform !== "win32") await chmod(tmp, 0o755);
    const file = join(dir, name);
    await rename(tmp, file);
    written.push(file);
  }
  return written;
}

/** Whether `text` is a launcher writeLaunchers writes (for any ternlatex), so uninstall leaves other files alone. */
export function isLauncher(text: string): boolean {
  return /^(#![^\n]*\n)?exec '[^\n]*' "\$@"\n$/.test(text) || /^@echo off\r\n"[^\r\n]*" %\*\r\n$/.test(text);
}
