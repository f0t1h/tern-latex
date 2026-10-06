// Developer build: a self-contained ternlatex executable per target in dist/ (ternlatex itself ships as a Bun package).
//   bun scripts/build.ts [--target bun-linux-x64 ...]     (default: this machine's target)
import type { BunPlugin } from "bun";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ASSET_ROOTS, copyAssets } from "../src/assets.ts";

export type Target = "bun-darwin-arm64" | "bun-darwin-x64" | "bun-linux-x64" | "bun-linux-arm64" | "bun-windows-x64";

interface CanvasPackage {
  pkg: string;
  /** The package's npm `os`/`cpu`, for `bun install --os --cpu`. */
  os: string;
  cpu: string;
}

/** Bun compile target → the @napi-rs/canvas prebuilt package for that platform. */
const CANVAS: Record<Target, CanvasPackage> = {
  "bun-darwin-arm64": { pkg: "@napi-rs/canvas-darwin-arm64", os: "darwin", cpu: "arm64" },
  "bun-darwin-x64": { pkg: "@napi-rs/canvas-darwin-x64", os: "darwin", cpu: "x64" },
  "bun-linux-x64": { pkg: "@napi-rs/canvas-linux-x64-gnu", os: "linux", cpu: "x64" },
  "bun-linux-arm64": { pkg: "@napi-rs/canvas-linux-arm64-gnu", os: "linux", cpu: "arm64" },
  "bun-windows-x64": { pkg: "@napi-rs/canvas-win32-x64-msvc", os: "win32", cpu: "x64" },
};

const REPO = join(import.meta.dir, "..");

/** Every compile target. */
const TARGETS: Target[] = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"];

const isTarget = (t: string): t is Target => t in CANVAS;

/** This machine's target. */
const HOST_TARGET = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

/** The binary a target builds: `ternlatex-<os>-<arch>`, `.exe` on Windows. */
function binaryName(target: Target): string {
  return `ternlatex-${target.slice("bun-".length)}${target.includes("windows") ? ".exe" : ""}`;
}

/**
 * Repo-relative paths of the git-tracked files under `dirs`, or null outside a git checkout (a source tarball).
 * Files deleted in the working tree but not committed yet are left out.
 */
function trackedFiles(dirs: string[]): string[] | null {
  const git = spawnSync("git", ["ls-files", "-z", "--", ...dirs], { cwd: REPO, encoding: "utf8" });
  if (git.status !== 0) return null;
  return git.stdout.split("\0").filter((f) => f && existsSync(join(REPO, ...f.split("/"))));
}

/**
 * The prebuilt canvas addon for a target. The host's comes from node_modules; other platforms' packages are
 * installed into build/native/ with `bun install --os --cpu`, which otherwise skips packages for foreign platforms.
 */
function canvasAddon({ pkg, os, cpu }: CanvasPackage): string {
  const version: unknown = JSON.parse(readFileSync(Bun.resolveSync("@napi-rs/canvas/package.json", REPO), "utf8")).version;
  if (typeof version !== "string") throw new Error("cannot read the @napi-rs/canvas version");
  let manifest: string;
  try {
    manifest = Bun.resolveSync(`${pkg}/package.json`, REPO);
  } catch {
    const dir = join(REPO, "build", "native", `${pkg.replace("/", "+")}@${version}`);
    manifest = join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (!existsSync(manifest)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { [pkg]: version } }));
      const r = spawnSync(process.execPath, ["install", "--os", os, "--cpu", cpu], { cwd: dir, stdio: "inherit" });
      if (r.status !== 0 || !existsSync(manifest)) throw new Error(`could not install ${pkg}@${version}`);
    }
  }
  const main: unknown = JSON.parse(readFileSync(manifest, "utf8")).main;
  if (typeof main !== "string") throw new Error(`${manifest} has no main`);
  return join(dirname(manifest), main);
}

/** @napi-rs/canvas require()s every platform's package by name; embed only the target's, leave the rest to fail at runtime as on any other platform. */
function canvasPlugin(pkg: string, addon: string): BunPlugin {
  return {
    name: "canvas-target",
    setup(build) {
      build.onResolve({ filter: /^@napi-rs\/canvas-/ }, (args) => (args.path === pkg ? { path: addon } : { path: args.path, external: true }));
    },
  };
}

/**
 * Names that identify no one: too generic, or the users of the CI machines that build upstream prebuilts
 * (`/Users/runner` in the canvas addon, `/home/web_user` from Emscripten in pdf.js's wasm decoders).
 */
const GENERIC_NAMES: Record<string, true> = { runner: true, runneradmin: true, web_user: true, root: true, user: true, admin: true, ubuntu: true, localhost: true };

/** Home-directory prefixes whose next path component is a user name, as native, forward-slash and JS-escaped paths. */
const HOME_PREFIXES = ["/Users/", "/home/", ":\\Users\\", ":\\\\Users\\\\", ":/Users/"];

const ENCODINGS = ["utf8", "utf16le"] as const;

function count(hay: Buffer, needle: Buffer): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Strings that reveal this machine or its user, each also with `/` separators and with `\` doubled as in a JS literal. */
function machineStrings(stage: string): string[] {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (e.g. an arbitrary container uid): basename(homedir()) still covers the user.
  }
  const email = spawnSync("git", ["config", "user.email"], { cwd: REPO, encoding: "utf8" }).stdout?.trim();
  const host = hostname();
  // Short or generic names would match unrelated bytes.
  const names = [basename(homedir()), user, host, host.split(".")[0], email].filter(
    (s): s is string => !!s && s.length >= 4 && !Object.hasOwn(GENERIC_NAMES, s.toLowerCase()),
  );
  // Not tmpdir() itself: on Linux it is plain "/tmp", which the Bun runtime contains; the random staging dir
  // under it is what this build could actually embed.
  const paths = [REPO, realpathSync(REPO), homedir(), stage, realpathSync(stage)];
  return [...paths, ...names].flatMap((s) => [s, s.replaceAll("\\", "/"), s.replaceAll("\\", "\\\\")]);
}

/** Anyone's home directory (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) found in `bytes`, UTF-8 or UTF-16LE. */
function homePaths(bytes: Buffer): string[] {
  const found: string[] = [];
  for (const prefix of HOME_PREFIXES) {
    for (const enc of ENCODINGS) {
      const p = Buffer.from(prefix, enc);
      const unit = enc === "utf8" ? 1 : 2;
      for (let i = bytes.indexOf(p); i !== -1; i = bytes.indexOf(p, i + 1)) {
        let name = "";
        for (let j = i + p.length; j < bytes.length && (unit === 1 || bytes[j + 1] === 0); j += unit) {
          const c = String.fromCharCode(bytes[j]!);
          if (!/[\w.-]/.test(c)) break;
          name += c;
        }
        if (name && !Object.hasOwn(GENERIC_NAMES, name.toLowerCase())) found.push(prefix + name);
      }
    }
  }
  return found;
}

/**
 * Byte strings (UTF-8 or UTF-16LE) that would reveal this machine or another developer's; none may appear in a
 * built binary. Occurrences inside an embedded third-party file (`upstream`, e.g. the prebuilt canvas addon)
 * come from upstream, not from this build: a string leaks only if the binary holds it more often than they do.
 */
function leaks(file: string, stage: string, upstream: string[]): string[] {
  const bytes = readFileSync(file);
  const foreign = upstream.map((f) => readFileSync(f));
  const needles = new Set([...machineStrings(stage), ...homePaths(bytes)]);
  return [...needles].filter((n) =>
    ENCODINGS.some((enc) => {
      const b = Buffer.from(n, enc);
      return count(bytes, b) > foreign.reduce((sum, f) => sum + count(f, b), 0);
    }),
  );
}

/**
 * Copies asset root `root` (an ASSET_ROOTS key) into `dest`. Repo roots ship only git-tracked files, so untracked
 * or ignored files (a template's local build, .DS_Store) never reach users; outside a git checkout (a source
 * tarball, `tracked` null) the working tree is used.
 */
async function stageRoot(root: string, dest: string, tracked: string[] | null): Promise<void> {
  const def = ASSET_ROOTS[root];
  if (!def) throw new Error(`unknown asset root ${root}`);
  if (!tracked || !("repo" in def.source)) {
    await copyAssets(root, dest);
    return;
  }
  const dir = def.source.repo === "." ? "" : `${def.source.repo}/`;
  for (const file of tracked) {
    if (!file.startsWith(dir)) continue;
    const parts = file.slice(dir.length).split("/");
    if (def.include && !def.include.includes(parts[0])) continue;
    if (parts.some((p) => p.startsWith(".")) || (def.only && !def.only.test(parts.at(-1)!))) continue;
    const to = join(dest, ...parts);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO, ...file.split("/")), to);
  }
}

/** The repo paths of the asset roots (their `include` entries where given), for trackedFiles. */
const ASSET_DIRS = Object.values(ASSET_ROOTS).flatMap((def) => {
  if (!("repo" in def.source)) return [];
  const repo = def.source.repo;
  return def.include ? def.include.map((e) => (repo === "." ? e : `${repo}/${e}`)) : [repo];
});

/**
 * Compiles one binary per target into `outDir` (named by binaryName) with every asset root embedded, and checks
 * none embeds build-machine paths. Returns the binaries' paths.
 */
async function buildBinaries(targets: Target[], outDir: string): Promise<string[]> {
  const tracked = trackedFiles(ASSET_DIRS);
  if (!tracked) console.warn(`warning: not a git checkout; embedding ${ASSET_DIRS.join(", ")} from the working tree`);
  const stage = mkdtempSync(join(tmpdir(), "ternlatex-assets-"));
  try {
    for (const root of Object.keys(ASSET_ROOTS)) await stageRoot(root, join(stage, root), tracked);
    // `--asset DIR` embeds DIR under the bundle's import.meta.dir by its name, which is where src/assets.ts reads it.
    const assets = Object.keys(ASSET_ROOTS).map((root) => join(stage, root.slice(0, -1)));
    mkdirSync(outDir, { recursive: true });
    const built: string[] = [];
    for (const target of targets) {
      const canvas = CANVAS[target];
      const addon = canvasAddon(canvas);
      const outfile = join(outDir, binaryName(target));
      await Bun.build({
        entrypoints: [join(REPO, "src", "cli.ts")],
        compile: { target, outfile, assets, autoloadDotenv: false, autoloadBunfig: false },
        minify: true,
        sourcemap: "none",
        plugins: [canvasPlugin(canvas.pkg, addon)],
      });
      const found = leaks(outfile, stage, [addon]);
      if (found.length) throw new Error(`${outfile} embeds build-machine paths: ${found.join(", ")}`);
      console.log(`${outfile}  ${(statSync(outfile).size / 2 ** 20).toFixed(1)} MiB`);
      built.push(outfile);
    }
    return built;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: "string", multiple: true } } });
  const targets = values.target ?? [HOST_TARGET];
  if (!targets.every(isTarget)) throw new Error(`unsupported target in ${targets.join(", ")}; one of: ${TARGETS.join(", ")}`);
  await buildBinaries(targets, join(REPO, "dist"));
}
