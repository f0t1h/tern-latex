import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UsageError } from "../config.ts";
import { findTernPlugin, pluginDataDir, removeTernPlugin } from "../ternplugin.ts";
import { cacheDir, dataDir } from "../tools.ts";
import { CHECKPOINT_REF } from "../vcs.ts";
import { isLauncher } from "./agent.ts";
import { bunExecutable, recordedLaunchers } from "./install-cli.ts";

/** One thing `uninstall` removes. */
export interface UninstallItem {
  what: string;
  /** Where it is, as shown to the user. */
  path: string;
  /** Its size on disk, or undefined when it has none of its own (a link). */
  bytes?: number;
  remove: () => Promise<void>;
}

export interface UninstallOptions {
  /** Leave cacheDir() (the downloaded tools and TeX packages) in place. */
  keepCache?: boolean;
  /** Remove without asking. */
  yes?: boolean;
  /** Asks `question` and returns the reply ("" at end of input), or null when there is no terminal to ask on. */
  ask?: (question: string) => string | null;
}

/**
 * `uninstall [--keep-cache] [--yes]`: lists every part of ternlatex outside projects with its size (launchers
 * install-cli recorded, a global Bun install, the cache, the data folder, Tern's plugin-data folder for the plugin,
 * and the plugin), asks, and removes them. The plugin goes last: this ternlatex may be running from it, which works,
 * as Bun has its files loaded. Projects are never touched; what stays in them is printed at the end.
 */
export async function uninstall(o: UninstallOptions = {}): Promise<number> {
  const items = await findItems(o.keepCache ?? false);
  if (!items.length) {
    console.log("Nothing of ternlatex is installed here.");
    console.log(leftovers());
    return 0;
  }
  console.log("ternlatex uninstall will remove:");
  const width = Math.max(...items.map((i) => i.what.length));
  for (const i of items) console.log(`  ${i.what.padEnd(width)}  ${i.path}${i.bytes === undefined ? "" : `  (${formatSize(i.bytes)})`}`);
  if (!o.yes) {
    const ask = o.ask ?? ((question: string) => (process.stdin.isTTY ? (prompt(question) ?? "") : null));
    const reply = ask("Remove these? [y/N]");
    if (reply === null) throw new UsageError("not asking without a terminal; run `ternlatex uninstall --yes` to remove these");
    if (!/^y(es)?$/i.test(reply.trim())) {
      console.log("Nothing removed.");
      return 1;
    }
  }
  let failed = false;
  for (const i of items) {
    try {
      await i.remove();
      console.log(`removed ${i.what}: ${i.path}`);
    } catch (e) {
      failed = true;
      console.error(`could not remove ${i.what} (${i.path}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(leftovers());
  return failed ? 1 : 0;
}

/** What there is to remove, in removal order. */
async function findItems(keepCache: boolean): Promise<UninstallItem[]> {
  const items: UninstallItem[] = [];
  const removeDir = (path: string) => () => rm(path, { recursive: true, force: true });
  for (const file of recordedLaunchers()) {
    if (!existsSync(file) || !lstatSync(file).isFile() || !isLauncher(readFileSync(file, "utf8"))) continue;
    items.push({ what: "launcher", path: file, bytes: lstatSync(file).size, remove: () => rm(file, { force: true }) });
  }
  const global = bunGlobalInstall();
  if (global) items.push(global);
  const cache = cacheDir();
  if (!keepCache && existsSync(cache)) items.push({ what: "cache (tools, TeX packages)", path: cache, bytes: diskSize(cache), remove: removeDir(cache) });
  const data = dataDir();
  if (existsSync(data)) items.push({ what: "data", path: data, bytes: diskSize(data), remove: removeDir(data) });
  const pluginData = pluginDataDir();
  if (existsSync(pluginData)) items.push({ what: "Tern plugin data", path: pluginData, bytes: diskSize(pluginData), remove: removeDir(pluginData) });
  const plugin = await findTernPlugin();
  if (plugin) {
    const where = [plugin.installed, plugin.linkedTo === undefined ? undefined : `link to ${plugin.linkedTo}`].filter((w) => w !== undefined);
    items.push({
      what: "Tern plugin",
      path: where.join("; "),
      bytes: plugin.installed === undefined ? undefined : diskSize(plugin.installed),
      remove: () => removeTernPlugin(plugin),
    });
  }
  return items;
}

/** ternlatex as a global Bun package (`bun add -g`), when `bun pm ls -g` lists it: removed with `bun remove -g`. */
function bunGlobalInstall(): UninstallItem | null {
  const bun = bunExecutable();
  if (!bun) return null;
  const r = spawnSync(bun, ["pm", "ls", "-g"], { encoding: "utf8", timeout: 30_000 });
  // `<global dir> node_modules (N installed)`, then a tree of `name@version`; it fails before any global install.
  const lines = r.status === 0 ? r.stdout.split(/\r?\n/) : [];
  if (!lines.some((l) => /[\s─]ternlatex@/.test(l))) return null;
  const head = lines.find((l) => l.includes(" node_modules ("));
  const pkg = head ? join(head.slice(0, head.lastIndexOf(" node_modules (")), "node_modules", "ternlatex") : undefined;
  return {
    what: "global Bun install",
    path: pkg ? `${pkg} (bun remove -g ternlatex)` : "bun remove -g ternlatex",
    bytes: pkg && existsSync(pkg) ? diskSize(pkg) : undefined,
    remove: async () => {
      const removed = spawnSync(bun, ["remove", "-g", "ternlatex"], { encoding: "utf8", timeout: 60_000 });
      if (removed.status !== 0) throw new Error(`bun remove -g ternlatex: ${(removed.error?.message ?? (removed.stderr.trim() || `exit ${removed.status}`))}`);
    },
  };
}

/** Bytes in `path`, not following symbolic links. */
function diskSize(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) total += diskSize(join(path, name));
  return total;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `bytes` for people: 512 B, 3.4 KB, 210 MB. */
function formatSize(bytes: number): string {
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${UNITS[unit]}`;
}

/** What stays in projects, and how to remove it there. omp's sessions live in omp's own folder, not the project. */
function leftovers(): string {
  const files = process.platform === "win32" ? "Remove-Item -Recurse ternlatex.toml, build" : "rm -r ternlatex.toml build";
  return [
    "",
    "Projects are left as they are. Each still has:",
    "  ternlatex.toml and build/ (the outdir)",
    `    remove with: ${files}`,
    `  save checkpoints on the ${CHECKPOINT_REF} git ref`,
    `    remove with: git update-ref -d ${CHECKPOINT_REF}`,
    "A running `ternlatex dev` keeps running until you stop it (Ctrl-C in its block).",
  ].join("\n");
}
