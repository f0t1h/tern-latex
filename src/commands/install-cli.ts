import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { COMPILED, dataDir, which } from "../tools.ts";
import { writeLaunchers } from "./agent.ts";

/**
 * `install-cli [DIR]`: puts a `ternlatex` launcher for this very ternlatex (selfCommand) into DIR, by default Bun's
 * global bin folder (`bun pm bin -g`), prints each file written (`wrote <file>`, which the Tern plugin reads),
 * records them for `uninstall` (launchersFile), and says how to put DIR on PATH when it is not.
 */
export async function installCli(dir?: string): Promise<number> {
  const target = resolve(dir ?? bunGlobalBin());
  const written = await writeLaunchers(target);
  for (const file of written) console.log(`wrote ${file}`);
  const file = launchersFile();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(file, `${JSON.stringify([...new Set([...recordedLaunchers(), ...written])], null, 2)}\n`);
  if (userPath().some((p) => p !== "" && resolve(p) === target)) return 0;
  console.log(
    process.platform === "win32"
      ? `${target} is not on PATH; add it to your user Path (Settings › Environment Variables) to run ternlatex in a terminal`
      : `${target} is not on PATH; add to your shell profile (~/.zshrc, ~/.bashrc): export PATH="${target}:$PATH"`,
  );
  return 0;
}

/** The launchers every `install-cli` wrote (a JSON list of absolute paths), for `uninstall`. */
export function launchersFile(): string {
  return join(dataDir(), "launchers.json");
}

/** The paths in launchersFile; none when it is missing or not a list of strings. */
export function recordedLaunchers(): string[] {
  const file = launchersFile();
  if (!existsSync(file)) return [];
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
}

/** The Bun that `bun pm …` and `bun remove -g` run with: the one running this ternlatex, or, compiled, Bun on PATH. */
export function bunExecutable(): string | null {
  return COMPILED ? which("bun") : process.execPath;
}

/**
 * Bun's global bin folder: what `bun pm bin -g` says (it follows bunfig's globalBinDir), from the Bun running this
 * ternlatex (or, compiled, the one on PATH). Before the first global install it fails (no global package.json):
 * then Bun's default, $BUN_INSTALL/bin, else ~/.bun/bin.
 */
function bunGlobalBin(): string {
  const bun = bunExecutable();
  const r = bun ? spawnSync(bun, ["pm", "bin", "-g"], { encoding: "utf8" }) : undefined;
  const dir = r?.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
  return dir || join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin");
}

/**
 * The PATH a terminal gets: this process's, plus, on macOS and Linux, the login shell's (Tern starts the plugin's
 * commands with a bare PATH). Login scripts may print first, so the shell's is its last line.
 */
function userPath(): string[] {
  const entries = (process.env.PATH ?? "").split(delimiter);
  if (process.platform === "win32") return entries;
  const r = spawnSync(process.env.SHELL || "sh", ["-lc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 10_000 });
  const shellPath = r.status === 0 ? (r.stdout.split(/\r?\n/).at(-1) ?? "") : "";
  return [...entries, ...shellPath.split(":")];
}
