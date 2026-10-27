import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { version } from "../../package.json";
import { copyAssets, listAssets } from "../assets.ts";
import { loadConfig } from "../config.ts";
import { assistantModel } from "../models.ts";
import { COMPILED, cacheDir, resolveTool, selfCommand, which } from "../tools.ts";

export interface AgentOptions {
  /** PATH for omp and everything it runs (the agent block gets the dev server's PATH this way). */
  path?: string;
  /**
   * An omp session to restore (`omp --restore`: resume it and finish what its last process left unfinished). Tern
   * passes it when it brings the omp block back after Tern or the machine restarted.
   */
  restore?: string;
}

/**
 * The folder of ternlatex's omp extension (omp/: the extension, AGENTS.md and the skills). From source it is the
 * package's own; a compiled ternlatex extracts it into its cache, one folder per version, since omp loads files.
 */
export async function ompExtension(): Promise<string> {
  if (!COMPILED) return join(import.meta.dir, "..", "..", "omp");
  const dir = join(cacheDir(), "omp", version);
  await copyAssets("omp/", dir, { force: true });
  return dir;
}

/**
 * Removes what ternlatex 0.1 wrote into a project for omp (`.omp/AGENTS.md` and its skills, files it owned and
 * overwrote on every run): omp now loads them from the extension, and stale copies would shadow it. Returns the
 * paths removed; a user's own files under `.omp/` stay.
 */
export async function removeProjectKit(dir: string): Promise<string[]> {
  const omp = join(dir, ".omp");
  const removed: string[] = [];
  const agents = join(omp, "AGENTS.md");
  if (existsSync(agents) && readFileSync(agents, "utf8").startsWith("# ternlatex project")) {
    await rm(agents);
    removed.push(agents);
  }
  const skills = new Set(listAssets("omp/skills/").map((rel) => rel.split("/")[2]));
  for (const name of skills) {
    const skill = join(omp, "skills", name);
    if (!existsSync(join(skill, "SKILL.md"))) continue;
    await rm(skill, { recursive: true });
    removed.push(skill);
  }
  for (const empty of [join(omp, "skills"), omp]) {
    if (existsSync(empty) && readdirSync(empty).length === 0) await rmdir(empty);
  }
  return removed;
}

/**
 * Runs omp in the project with ternlatex's extension (`-e`), omp's `latex` role as its model when defined (else omp's
 * default), and a `ternlatex` launcher for this very ternlatex first on PATH (the extension's tools run it). It continues
 * the project's most recent omp session (a fresh one when there is none), so reopening the omp block keeps context.
 */
export async function runAgent(target: string, o: AgentOptions = {}): Promise<number> {
  const cfg = loadConfig(target);
  const removed = await removeProjectKit(cfg.dir);
  if (removed.length) console.log(`removed ternlatex 0.1's project files for omp (omp now loads them from ternlatex): ${removed.join(", ")}`);
  if (o.path !== undefined) process.env.PATH = o.path;
  const bin = join(cacheDir(), "bin");
  await writeLaunchers(bin);
  process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);
  const extension = await ompExtension();
  const model = await assistantModel(cfg.dir, cfg);
  const [omp, ...pre] = (await resolveTool("omp", cfg)).command;
  const session = o.restore ? ["--restore", o.restore] : ["--continue"];
  const child = spawn(omp, [...pre, ...session, ...(model ? ["--model", model] : []), "-e", extension], { cwd: cfg.dir, stdio: "inherit", env: process.env });
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
