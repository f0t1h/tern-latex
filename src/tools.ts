import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Config, EngineName } from "./config.ts";
import { type ArchiveKind, install } from "./download.ts";

export type ToolName = "tectonic" | "pandoc" | "latexdiff" | "perl" | "git" | "chktex" | "latexmk" | "omp" | "tern";

export const TOOL_NAMES: ToolName[] = ["tectonic", "pandoc", "latexdiff", "perl", "git", "chktex", "latexmk", "omp", "tern"];

export interface ResolvedTool {
  name: ToolName;
  /** argv prefix, e.g. [perlPath, latexdiffScript]. */
  command: string[];
  source: "env" | "config" | "path" | "managed" | "process";
  version?: string;
}

export class ToolMissingError extends Error {
  readonly tool: ToolName;
  /** How to get the tool, without the "<name> not found: " lead. */
  readonly hint: string;
  constructor(tool: ToolName, hint: string, lead = `${tool} not found`) {
    super(`${lead}: ${hint}`);
    this.tool = tool;
    this.hint = hint;
  }
}

interface Asset {
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** Executable (or script) inside the archive, `/`-separated. */
  bin: string;
}

/** `${process.platform}-${process.arch}`, or "any" for platform-independent scripts. */
type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64" | "any";

interface Managed {
  version: string;
  assets: Partial<Record<Platform, Asset>>;
  /** Runs through this interpreter (resolved like any tool) instead of directly. */
  interpreter?: ToolName;
}

const TECTONIC = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0";
const PANDOC = "https://github.com/jgm/pandoc/releases/download/3.12";

/** Pinned downloads; hashes are the GitHub release `digest` fields. */
export const MANAGED: Partial<Record<ToolName, Managed>> = {
  tectonic: {
    version: "0.17.0",
    assets: {
      "darwin-arm64": { url: `${TECTONIC}/tectonic-0.17.0-aarch64-apple-darwin.tar.gz`, sha256: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667", archive: "tar.gz", bin: "tectonic" },
      "darwin-x64": { url: `${TECTONIC}/tectonic-0.17.0-x86_64-apple-darwin.tar.gz`, sha256: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80", archive: "tar.gz", bin: "tectonic" },
      "linux-x64": { url: `${TECTONIC}/tectonic-0.17.0-x86_64-unknown-linux-gnu.tar.gz`, sha256: "1a715688baf591e650c8aeb160ae934e181685eecbb38b317de30b269ac5d606", archive: "tar.gz", bin: "tectonic" },
      "linux-arm64": { url: `${TECTONIC}/tectonic-0.17.0-aarch64-unknown-linux-musl.tar.gz`, sha256: "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8", archive: "tar.gz", bin: "tectonic" },
      "win32-x64": { url: `${TECTONIC}/tectonic-0.17.0-x86_64-pc-windows-msvc.zip`, sha256: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f", archive: "zip", bin: "tectonic.exe" },
    },
  },
  pandoc: {
    version: "3.12",
    assets: {
      "darwin-arm64": { url: `${PANDOC}/pandoc-3.12-arm64-macOS.zip`, sha256: "f148ca09c9f36594db527a9fc988ad736290ce428f79594c50208cd1ec58b3c0", archive: "zip", bin: "pandoc-3.12-arm64/bin/pandoc" },
      "darwin-x64": { url: `${PANDOC}/pandoc-3.12-x86_64-macOS.zip`, sha256: "18577f9460c3dc5d2651ad3bab37d513bc2034a5a777fbe18fa0a5acf2e936ea", archive: "zip", bin: "pandoc-3.12-x86_64/bin/pandoc" },
      "linux-x64": { url: `${PANDOC}/pandoc-3.12-linux-amd64.tar.gz`, sha256: "67d7d011fed8c8543306022b985b9b2499ab9b74818df91d8727c7e9ebc5ba06", archive: "tar.gz", bin: "pandoc-3.12/bin/pandoc" },
      "linux-arm64": { url: `${PANDOC}/pandoc-3.12-linux-arm64.tar.gz`, sha256: "6cefcf7100e23a99447c26f89d1ff5b253f3407fcef99a9e27ae06f3ed16cb82", archive: "tar.gz", bin: "pandoc-3.12/bin/pandoc" },
      "win32-x64": { url: `${PANDOC}/pandoc-3.12-windows-x86_64.zip`, sha256: "2a77ebc2517d13e95056e76b1cd5b574cfe958ac61aa6058117d80c22ca19b79", archive: "zip", bin: "pandoc-3.12/pandoc.exe" },
    },
  },
  latexdiff: {
    version: "1.4.0",
    interpreter: "perl",
    // latexdiff-so embeds Algorithm::Diff, so it needs nothing beyond core Perl.
    assets: {
      any: { url: "https://github.com/ftilmann/latexdiff/releases/download/1.4.0/latexdiff-1.4.0.tar.gz", sha256: "2aaea10ae1a9c1b975c9dc933da6ac6f83f665eea76b358daf86b97b606912ea", archive: "tar.gz", bin: "latexdiff/latexdiff-so" },
    },
  },
};

const WARM = "run `ternlatex doctor --warm`";

/** How to get a TeX distribution with latexmk and the TeX engines. */
export const TEX_INSTALL =
  process.platform === "win32"
    ? "install TinyTeX (https://yihui.org/tinytex/), MiKTeX or TeX Live"
    : `install TinyTeX (curl -sL https://yihui.org/tinytex/install-bin-unix.sh | sh)${process.platform === "darwin" ? ", MacTeX" : ""} or TeX Live`;

/** How to get each tool, before "put it on PATH, or set …". */
const INSTALL: Record<ToolName, string> = {
  tectonic: WARM,
  pandoc: WARM,
  latexdiff: WARM,
  perl: "install Perl",
  git: "install git",
  chktex: "install chktex (part of TeX Live)",
  latexmk: `${TEX_INSTALL} (or set engine = "tectonic")`,
  omp: "install omp",
  tern: "run inside Tern, or install the Tern CLI",
};

/** Extra env names accepted for compatibility, after TERNLATEX_<NAME>. */
const ENV_ALIASES: Partial<Record<ToolName, string>> = { tern: "TERN_BIN" };

/** Missing-tool hint: how to install it, PATH, and the override variable. */
function missing(name: ToolName, lead?: string): ToolMissingError {
  const alias = ENV_ALIASES[name];
  return new ToolMissingError(name, `${INSTALL[name]}, put it on PATH, or set TERNLATEX_${name.toUpperCase()}${alias ? ` (or ${alias})` : ""}`, lead);
}

/** ternlatex's per-user cache: TERNLATEX_CACHE, else the OS cache dir + "ternlatex". */
export function cacheDir(): string {
  const env = process.env.TERNLATEX_CACHE;
  if (env) return resolve(env);
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ternlatex");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ternlatex");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ternlatex");
}

/** ternlatex's per-user data (files that must outlive cache cleanups): TERNLATEX_DATA, else the OS data dir + "ternlatex". */
export function dataDir(): string {
  const env = process.env.TERNLATEX_DATA;
  if (env) return resolve(env);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "ternlatex");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "ternlatex");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "ternlatex");
}

/** Compiled executables run their entry from Bun's embedded filesystem (/$bunfs/… or B:\~BUN\…). */
export const COMPILED = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);

/**
 * argv that re-invokes this ternlatex: the binary itself, or the runtime plus src/cli.ts. A source copy has its
 * dependencies in node_modules beside src/ (the Tern plugin's setup installs them from bun.lock there).
 */
export function selfCommand(): string[] {
  if (COMPILED) return [process.execPath];
  return [process.execPath, join(import.meta.dir, "cli.ts")];
}

/** The PATH of the last `setup-tern`/`dev`: Tern's daemon starts plugin commands with a bare PATH that lacks omp and friends. */
function userPathFile(): string {
  return join(dataDir(), "user-path");
}

/** Records the current PATH for later runs started without it (see initToolEnv). */
export function rememberPath(): void {
  const path = process.env.PATH ?? "";
  const file = userPathFile();
  if (!path || (existsSync(file) && readFileSync(file, "utf8") === path)) return;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(file, path);
}

/** Process-wide defaults; the CLI calls this once at start. PATH gains the remembered entries it lacks, after its own. */
export function initToolEnv(): void {
  process.env.TECTONIC_CACHE_DIR ??= join(cacheDir(), "tectonic");
  const file = userPathFile();
  if (!existsSync(file)) return;
  const have = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extra = readFileSync(file, "utf8").split(delimiter).filter((p) => p && !have.includes(p));
  if (extra.length) process.env.PATH = [...have, ...extra].join(delimiter);
}

/** Tools a TeX distribution brings: looked for in its bin directory when they are not on PATH. */
const TEX_TOOLS: Partial<Record<ToolName, true>> = { latexmk: true, chktex: true };

/**
 * Bin directories of TeX distributions installed where they usually go, newest first: TinyTeX (installs without
 * admin rights, so often off PATH), MacTeX's texbin, TeX Live's yearly trees, MiKTeX.
 */
export function texBinDirs(): string[] {
  const home = homedir();
  const sub = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort().reverse().map((d) => join(dir, d)) : []);
  // <root>/<year>/bin/<arch>: newest year first.
  const yearly = (root: string) => sub(root).filter((d) => /\d{4}$/.test(d)).flatMap((y) => sub(join(y, "bin")));
  const dirs =
    process.platform === "win32"
      ? [
          ...sub(join(process.env.APPDATA || join(home, "AppData", "Roaming"), "TinyTeX", "bin")),
          ...yearly("C:\\texlive"),
          join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "MiKTeX", "miktex", "bin", "x64"),
          "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        ]
      : [
          ...sub(join(home, process.platform === "darwin" ? "Library/TinyTeX" : ".TinyTeX", "bin")),
          ...(process.platform === "darwin" ? ["/Library/TeX/texbin"] : []),
          ...yearly("/usr/local/texlive"),
          ...yearly("/opt/texlive"),
        ];
  return dirs.filter((d) => existsSync(d));
}

/** A TeX engine run by latexmk: latexmk's command, and the bin directory the engine and its tools come from. */
export interface TexEngine {
  latexmk: string[];
  /** Put first on the run's PATH, so latexmk finds the engine (and BibTeX, xdvipdfmx) of the same distribution. */
  binDir: string;
  /** tlmgr of a TinyTeX, which installs packages without admin rights; absent elsewhere. */
  tlmgr?: string;
}

/** latexmk and ENGINE from one distribution (see resolveTool for latexmk), else a ToolMissingError saying what to install. */
export async function resolveTexEngine(engine: Exclude<EngineName, "tectonic">, cfg?: Config): Promise<TexEngine> {
  const latexmk = await resolveTool("latexmk", cfg);
  const binDir = dirname(latexmk.command[latexmk.command.length - 1]);
  const bin = Bun.which(engine, { PATH: [binDir, process.env.PATH ?? ""].join(delimiter) });
  if (!bin) throw new ToolMissingError("latexmk", `${TEX_INSTALL}; latexmk is at ${binDir}, but ${engine} is not`, `${engine} not found`);
  const tlmgr = Bun.which("tlmgr", { PATH: binDir });
  return { latexmk: latexmk.command, binDir, ...(tlmgr && /TinyTeX/i.test(tlmgr) ? { tlmgr } : {}) };
}

/** Bun.which against the current PATH (by default it keeps the PATH the process started with). */
export function which(command: string): string | null {
  return Bun.which(command, { PATH: process.env.PATH ?? "" });
}

const cache = new Map<string, Promise<ResolvedTool>>();

/** Forgets every resolution (tests change PATH and overrides between cases). */
export function clearToolCache(): void {
  cache.clear();
}

/**
 * Finds a tool: env TERNLATEX_<NAME> (plus aliases), cfg.tools[name], PATH, then for managed tools the
 * pinned download (unless `download: false`) and for tern the ancestor processes. Cached per process.
 */
export function resolveTool(name: ToolName, cfg?: Config, o: { download?: boolean } = {}): Promise<ResolvedTool> {
  const key = `${name}\0${cfg?.tools[name] ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const found = find(name, cfg, o.download ?? true);
  cache.set(key, found);
  found.catch(() => cache.delete(key)); // A later call may download or see a fixed PATH.
  return found;
}

async function find(name: ToolName, cfg: Config | undefined, download: boolean): Promise<ResolvedTool> {
  const alias = ENV_ALIASES[name];
  const env = `TERNLATEX_${name.toUpperCase()}`;
  const overrides: [where: string, value: string | undefined, source: "env" | "config"][] = [[env, process.env[env], "env"]];
  if (alias) overrides.push([alias, process.env[alias], "env"]);
  overrides.push([`[tools] ${name} in ternlatex.toml`, cfg?.tools[name], "config"]);
  for (const [where, value, source] of overrides) {
    if (!value) continue;
    // A path, or a bare command name looked up on PATH.
    const path = which(value) ?? (existsSync(value) ? resolve(value) : null);
    if (!path) throw missing(name, `${where} = ${JSON.stringify(value)} is not an executable`);
    return { name, command: [path], source };
  }
  const onPath = which(name);
  if (onPath) return { name, command: [onPath], source: "path" };
  if (TEX_TOOLS[name]) {
    for (const dir of texBinDirs()) {
      const bin = Bun.which(name, { PATH: dir });
      if (bin) return { name, command: [bin], source: "path" };
    }
  }
  const m = MANAGED[name];
  if (m) {
    const platform = `${process.platform}-${process.arch}`;
    const asset = m.assets.any ?? Object.entries(m.assets).find(([k]) => k === platform)?.[1];
    if (!asset) throw missing(name, `${name} not found and no pinned ${name} build exists for ${platform}`);
    const dir = join(cacheDir(), "tools", `${name}-${m.version}`);
    const bin = join(dir, ...asset.bin.split("/"));
    if (!existsSync(bin) && !download) throw missing(name);
    // Before downloading, so a missing interpreter does not cost a download.
    const pre = m.interpreter ? (await resolveTool(m.interpreter, cfg, { download })).command : [];
    const path = await install({ ...asset, label: `${name} ${m.version}` }, dir);
    return { name, command: [...pre, path], source: "managed", version: m.version };
  }
  if (name === "tern") {
    const path = ternAncestor();
    if (path) return { name, command: [path], source: "process" };
  }
  throw missing(name);
}

/** Version-printing args per tool; the first non-empty output line is the version. */
const VERSION_ARGS: Record<ToolName, string[]> = {
  tectonic: ["--version"],
  pandoc: ["--version"],
  latexdiff: ["--version"],
  perl: ["-e", "print $^V"],
  git: ["--version"],
  chktex: ["--version"],
  latexmk: ["--version"],
  omp: ["--version"],
  tern: ["--version"],
};

/** The tool's own version line, or null when it does not answer. */
export function toolVersion(t: ResolvedTool): string | null {
  const [bin, ...pre] = t.command;
  const r = spawnSync(bin, [...pre, ...VERSION_ARGS[t.name]], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
}

const isTern = (exe: string) => /^tern(\.exe)?$/i.test(basename(exe));

/** The first ancestor process whose executable is named tern (Tern starts blocks from its daemon). */
function ternAncestor(): string | null {
  if (process.platform === "linux") {
    // procfs: /proc/<pid>/exe links to the executable; field 4 of /proc/<pid>/stat is the parent pid.
    for (let pid = process.ppid; pid > 1; ) {
      try {
        const exe = readlinkSync(`/proc/${pid}/exe`);
        if (isTern(exe)) return exe;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (process.platform === "darwin") {
    const ps = which("ps");
    if (!ps) return null;
    for (let pid = process.ppid; pid > 1; ) {
      const r = spawnSync(ps, ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
      const m = /^\s*(\d+)\s+(.+)$/.exec(r.stdout.trim());
      if (!m) return null;
      if (isTern(m[2])) return executablePath(ps, pid, m[2]);
      pid = Number(m[1]);
    }
  }
  return null; // Windows: not yet.
}

/**
 * macOS `comm` is the full executable path when the process was started by path, else just its name;
 * then the path comes from its argv[0] (the longest-matching existing prefix, as paths may hold spaces).
 */
function executablePath(ps: string, pid: number, comm: string): string | null {
  if (comm.startsWith("/") && existsSync(comm)) return comm;
  const args = spawnSync(ps, ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const words = args.split(" ");
  for (let i = words.length; i > 0; i--) {
    const candidate = words.slice(0, i).join(" ");
    if (candidate.startsWith("/") && isTern(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Opens a file or URL with the desktop's default app (`open`, `xdg-open`, or `cmd /c start ""`, from PATH),
 * without waiting for it. Throws when no opener is on PATH.
 */
export function openWithDefaultApp(target: string): void {
  const win = process.platform === "win32";
  const name = win ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const bin = which(name);
  if (!bin) throw new Error(`cannot open ${target}: \`${name}\` is not on PATH${name === "xdg-open" ? " (install xdg-utils)" : ""}`);
  const child = spawn(bin, [...(win ? ["/c", "start", ""] : []), target], { stdio: "ignore", detached: true });
  child.on("error", (e) => console.error(`cannot open ${target} with ${bin}: ${e.message}`));
  child.unref();
}
