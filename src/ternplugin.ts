import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { version } from "../package.json";
import { assetBytes, assetText, listAssets } from "./assets.ts";
import { ternCli, ternError } from "./tern.ts";
import { cacheDir, dataDir, rememberPath, selfCommand } from "./tools.ts";

/**
 * The Tern plugin (layout, status line, forward search, Review block, build lens): a package laid out as the repo
 * root is, plugin.toml and tern-plugin/, so the repo itself installs from Tern. Also the two ways ternlatex talks to
 * it: installing it, and requests to its window half over `tern open`.
 */

export const PLUGIN_ID = "ternlatex";

/** The plugin's config.json, read by both halves; never shipped, written at install. */
const CONFIG = "config.json";

const POLL_MS = 25;

/** Runs `tern <args> --json` (the flag goes before a `--` command) and parses its answer; a failure carries Tern's message. */
async function ternJson(args: string[], env: Record<string, string | undefined> = process.env): Promise<unknown> {
  const end = args.indexOf("--");
  const r = await ternCli(end < 0 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)], env);
  if (r.code !== 0) throw ternError(args, r);
  return JSON.parse(r.stdout);
}

/** Request/reply directory shared with the plugin (config.json's `ipc`); realpath'd, as Tern reports resolved paths. */
export function ipcDir(): string {
  const dir = join(cacheDir(), "tern-ipc");
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** config.json's contents: how the plugin runs this ternlatex, where it reads requests, and its version. */
export interface PluginConfig {
  /** The argv prefix that runs this ternlatex (selfCommand). */
  bin: string[];
  /** The IPC directory (ipcDir). */
  ipc: string;
  version: string;
}

/** This ternlatex's PluginConfig; creates the IPC directory. `ternlatex tern-config --json` prints it. */
export function pluginConfig(): PluginConfig {
  return { bin: selfCommand(), ipc: ipcDir(), version };
}

function configText(): string {
  return `${JSON.stringify(pluginConfig(), null, 2)}\n`;
}

/**
 * Tern's state directory (`<state>` in the SDK's Directories table), which holds each plugin's data folder:
 * TERN_CONFIG_DIR when set, else the OS location.
 */
export function ternStateDir(): string {
  const env = process.env.TERN_CONFIG_DIR;
  if (env) return resolve(env);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Tern");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Tern");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "tern");
}

/** The plugin's data folder (`<state>/plugin-data/ternlatex`); Tern keeps it when the plugin is removed. */
export function pluginDataDir(): string {
  return join(ternStateDir(), "plugin-data", PLUGIN_ID);
}

/** Tern's configuration directory (`<config>`), holding settings.json: TERN_CONFIG_DIR when set, else the OS location. */
export function ternConfigDir(): string {
  const env = process.env.TERN_CONFIG_DIR;
  if (env) return resolve(env);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Tern");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Tern");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tern");
}

/** A key the plugin's "Use LaTeX editing keys" bound (its kv.json `edit_keys`), with the user's own binding before. */
export interface EditKey {
  chord: string;
  action: string;
  previous?: unknown;
}

/** The keys "Use LaTeX editing keys" bound that Tern's settings.json still holds as it left them. */
export function editKeys(): EditKey[] {
  const kv = join(pluginDataDir(), "kv.json");
  const settings = join(ternConfigDir(), "settings.json");
  if (!existsSync(kv) || !existsSync(settings)) return [];
  const saved = jsonObject(readFileSync(kv, "utf8"))?.edit_keys;
  const keybinds = jsonObject(readFileSync(settings, "utf8"))?.keybinds;
  if (!isObject(saved) || !isObject(keybinds)) return [];
  return Object.entries(saved).flatMap(([id, rec]) => {
    if (!isObject(rec) || typeof rec.chord !== "string") return [];
    const action = `plugin.${PLUGIN_ID}.${id}`;
    const bound = keybinds[rec.chord];
    // A key the user rebound since is theirs.
    return Array.isArray(bound) && bound.includes(action) ? [{ chord: rec.chord, action, previous: rec.previous }] : [];
  });
}

/** Puts the keys of `editKeys()` back in Tern's settings.json: the user's earlier binding, else Tern's default. */
export async function restoreEditKeys(keys: EditKey[]): Promise<void> {
  const file = join(ternConfigDir(), "settings.json");
  const settings = jsonObject(await readFile(file, "utf8"));
  if (!settings || !isObject(settings.keybinds)) return;
  for (const k of keys) {
    if (k.previous === undefined || k.previous === null) delete settings.keybinds[k.chord];
    else settings.keybinds[k.chord] = k.previous;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, file);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The plugin's data-folder config.json: an installed plugin package has none of its own, so it reads this one,
 * written by its own install of ternlatex or by ternlatex.
 */
export function dataConfigFile(): string {
  return join(pluginDataDir(), CONFIG);
}

/** The shipped package's logical asset root (src/assets.ts). */
const PACKAGE = "tern-package/";

/** This ternlatex's package root (src/'s parent); inside Bun's embedded filesystem when compiled. */
const PACKAGE_ROOT = join(import.meta.dir, "..");

/**
 * Whether this ternlatex runs from a git checkout (a `.git` beside the package root): a developer's, whose plugin
 * replaces a copy installed from Tern. An installed package or a compiled binary keeps that copy.
 */
const DEV_CHECKOUT = existsSync(join(PACKAGE_ROOT, ".git"));

/** Tern's plugins folder; failing here means this Tern predates plugins. */
async function pluginsFolder(): Promise<string> {
  let v: unknown;
  try {
    v = await ternJson(["plugin", "dir"]);
  } catch (e) {
    throw new Error(`this Tern cannot load plugins (${e instanceof Error ? e.message : String(e)}); update Tern`);
  }
  if (!v || typeof v !== "object" || !("dir" in v) || typeof v.dir !== "string") throw new Error(`tern plugin dir answered unexpectedly: ${JSON.stringify(v)}`);
  return v.dir;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  return real(a) === real(b);
}

async function writeIfChanged(file: string, data: Uint8Array): Promise<boolean> {
  if (existsSync(file) && readFileSync(file).equals(data)) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return true;
}

/** Mirrors the shipped package into `dest` (config.json aside); true when anything was written or removed. */
async function syncPluginFiles(dest: string): Promise<boolean> {
  const shipped = listAssets(PACKAGE);
  if (!shipped.length) throw new Error("this ternlatex build lacks the Tern plugin");
  let changed = false;
  const keep = new Set<string>([CONFIG]);
  for (const rel of shipped) {
    const sub = rel.slice(PACKAGE.length);
    keep.add(sub);
    const bytes = await assetBytes(rel);
    if (bytes && (await writeIfChanged(join(dest, ...sub.split("/")), bytes))) changed = true;
  }
  // Files an older ternlatex shipped would still load (a stale module), so they go.
  for (const entry of readdirSync(dest, { recursive: true, encoding: "utf8" })) {
    const abs = join(dest, entry);
    if (keep.has(entry.replaceAll("\\", "/")) || !statSync(abs).isFile()) continue;
    await rm(abs, { force: true });
    changed = true;
  }
  return changed;
}

export interface PluginSetup {
  /** The package directory Tern loads (realpath). */
  dir: string;
  /** What was done, for the user; empty when everything was already in place. */
  actions: string[];
  /** Something the user should act on (a plugin of another version), or undefined. */
  warning?: string;
}

/**
 * Makes Tern load this ternlatex's plugin: writes the package and config.json into dataDir()/tern-plugin when they
 * differ, links it unless Tern already links it from there (replacing another link or an installed copy), reloads
 * when something changed, and checks Tern reports the plugin ready. `reload` forces the reload.
 * The package is a copy of the shipped files: from the package when running from source (so setup-tern or dev
 * picks up luau edits in a checkout), embedded in the compiled binary otherwise. Never the package root: Tern watches
 * a linked folder recursively, and node_modules or dist would keep reloading it.
 * An installed package or a compiled ternlatex keeps a plugin installed from Tern's Plugins page (see
 * installTernPlugin's keepInstalled); a git checkout replaces it with its link, as a developer means to. A ternlatex
 * running from that installed plugin (Tern installed the repo, so the plugin is this very source) only writes its
 * config to the plugin's data folder.
 */
export async function ensureTernPlugin(o: { reload?: boolean } = {}): Promise<PluginSetup> {
  // Commands the plugin runs start from Tern's daemon with a bare PATH; they fall back to this one (initToolEnv).
  rememberPath();
  return installTernPlugin(join(dataDir(), "tern-plugin"), { reload: o.reload, keepInstalled: !DEV_CHECKOUT });
}

/** The `version` of the plugin.toml in `dir`, or "unknown". */
function packageVersion(dir: string): string {
  try {
    const v = parseToml(readFileSync(join(dir, "plugin.toml"), "utf8")).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Uses the plugin installed at `installed` as it is (no unlink, remove, rewrite or link): writes this ternlatex's
 * config to the plugin's data folder so the plugin runs it, warns when the package is another version, reloads
 * only when asked, and checks the plugin is ready.
 */
async function useInstalledPlugin(installed: string, reloadNow: boolean | undefined): Promise<PluginSetup> {
  const actions: string[] = [];
  const pkgVersion = packageVersion(installed);
  const warning =
    pkgVersion === version ? undefined : `the ternlatex Tern plugin is ${pkgVersion}, this ternlatex is ${version}; reinstall the plugin from Preferences › Plugins`;
  const config = dataConfigFile();
  if (await writeIfChanged(config, Buffer.from(configText()))) actions.push(`wrote ${config}`);
  let catalog: unknown;
  if (reloadNow) {
    catalog = await reload();
    actions.push("reloaded Tern's plugins");
  } else {
    catalog = await ternJson(["plugin", "list"]);
  }
  const real = realpathSync(installed);
  const problem = catalogProblem(parseCatalog(catalog), real);
  if (problem) throw new Error(problem);
  return { dir: real, actions, warning };
}

/**
 * ensureTernPlugin for an explicit package directory, which is filled from the shipped files first. With
 * `keepInstalled`, a copy installed in Tern's plugins folder is used as it is (useInstalledPlugin) instead.
 */
export async function installTernPlugin(dir: string, o: { reload?: boolean; keepInstalled?: boolean } = {}): Promise<PluginSetup> {
  const plugins = await pluginsFolder();
  const installed = join(plugins, PLUGIN_ID);
  if (samePath(PACKAGE_ROOT, installed)) return useInstalledPlugin(installed, false);
  if (o.keepInstalled && existsSync(join(installed, "plugin.toml"))) return useInstalledPlugin(installed, o.reload);
  const actions: string[] = [];
  let changed = false;
  mkdirSync(dir, { recursive: true });
  if (await syncPluginFiles(dir)) {
    changed = true;
    actions.push(`updated the plugin files in ${dir}`);
  }
  if (!existsSync(join(dir, "plugin.toml"))) throw new Error(`no Tern plugin package at ${dir}`);
  if (await writeIfChanged(join(dir, CONFIG), Buffer.from(configText()))) changed = true;
  const real = realpathSync(dir);
  const link = join(plugins, `${PLUGIN_ID}.path`); // What `tern plugin link` writes; `plugin list` has no paths.
  const linkedTo = existsSync(link) ? readFileSync(link, "utf8").trim() : undefined;
  let linked = false;
  if (linkedTo === undefined || !samePath(linkedTo, real)) {
    if (linkedTo !== undefined) {
      await ternJson(["plugin", "unlink", PLUGIN_ID]);
      actions.push(`unlinked ${PLUGIN_ID} from ${linkedTo}`);
    }
    if (existsSync(installed)) {
      await ternJson(["plugin", "remove", PLUGIN_ID]);
      actions.push(`removed the installed copy of ${PLUGIN_ID} from ${installed}`);
    }
    await ternJson(["plugin", "link", real]);
    actions.push(`linked ${real}`);
    linked = true;
  }
  // `tern plugin link` reloads by itself; edited files are only picked up by an explicit reload.
  let catalog: unknown;
  if (!linked && (changed || o.reload)) {
    catalog = await reload();
    actions.push("reloaded Tern's plugins");
  } else {
    catalog = await ternJson(["plugin", "list"]);
  }
  const problem = catalogProblem(parseCatalog(catalog), real);
  if (problem) throw new Error(problem);
  return { dir: real, actions };
}

/** `tern plugin reload`: its exit is 1 when any plugin (maybe not ours) fails, so the catalog decides. */
async function reload(): Promise<unknown> {
  const args = ["plugin", "reload"];
  const r = await ternCli([...args, "--json"]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw ternError(args, r);
  }
}

/** The parts of Tern's plugin catalog (`tern plugin list|reload --json`) read here. */
interface Catalog {
  /** Our plugin's status: "ready", `{ failed: message }`, or another state; undefined when not listed. */
  status?: unknown;
  /** Folders Tern could not load, with why. */
  problems: { dir: string; error: string }[];
}

function parseCatalog(v: unknown): Catalog {
  const plugins = v && typeof v === "object" && "plugins" in v && Array.isArray(v.plugins) ? v.plugins : [];
  const problems = v && typeof v === "object" && "problems" in v && Array.isArray(v.problems) ? v.problems : [];
  const mine: unknown = plugins.find((p: unknown) => Boolean(p && typeof p === "object" && "id" in p && p.id === PLUGIN_ID));
  return {
    status: mine && typeof mine === "object" && "status" in mine ? mine.status : undefined,
    problems: problems.flatMap((p: unknown) =>
      p && typeof p === "object" && "dir" in p && "error" in p && typeof p.dir === "string" && typeof p.error === "string" ? [{ dir: p.dir, error: p.error }] : [],
    ),
  };
}

/** Why the catalog does not show our plugin (in `dir`) ready, or null when it does. */
function catalogProblem(c: Catalog, dir: string): string | null {
  if (c.status === undefined) {
    const problems = c.problems.filter((p) => samePath(p.dir, dir) || p.error.includes(PLUGIN_ID)).map((p) => p.error);
    return problems.length ? `Tern cannot load the ternlatex plugin: ${problems.join("; ")}` : "Tern does not list the ternlatex plugin";
  }
  const status = c.status;
  if (status === "ready") return null;
  if (status && typeof status === "object" && "failed" in status && typeof status.failed === "string") return `the ternlatex Tern plugin failed: ${status.failed}`;
  return `the ternlatex Tern plugin is ${typeof status === "string" ? status : JSON.stringify(status)} (see Tern's Preferences › Plugins)`;
}

export interface PluginState {
  ok: boolean;
  detail: string;
}

/**
 * For `doctor`: whether Tern loads this ternlatex's plugin (linked, or, outside a git checkout, installed from
 * Tern's Plugins page), with current config, and reports it ready. Changes nothing.
 */
export async function ternPluginState(): Promise<PluginState> {
  const fix = "run `ternlatex setup-tern`";
  let plugins: string;
  try {
    plugins = await pluginsFolder();
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const installed = join(plugins, PLUGIN_ID);
  if (!DEV_CHECKOUT && existsSync(join(installed, "plugin.toml"))) {
    const pkgVersion = packageVersion(installed);
    if (pkgVersion !== version) return { ok: false, detail: `installed plugin is ${pkgVersion}, this ternlatex is ${version}; reinstall the plugin from Preferences › Plugins` };
    const config = dataConfigFile();
    if (!existsSync(config) || readFileSync(config, "utf8") !== configText()) return { ok: false, detail: `${config} does not name this ternlatex; ${fix}` };
    const problem = catalogProblem(parseCatalog(await ternJson(["plugin", "list"])), realpathSync(installed));
    return problem ? { ok: false, detail: problem } : { ok: true, detail: `ready (installed ${installed})` };
  }
  const dir = join(dataDir(), "tern-plugin");
  const link = join(plugins, `${PLUGIN_ID}.path`);
  const linkedTo = existsSync(link) ? readFileSync(link, "utf8").trim() : undefined;
  if (linkedTo === undefined) return { ok: false, detail: `not linked; ${fix}` };
  if (!samePath(linkedTo, dir)) return { ok: false, detail: `linked from ${linkedTo}, not this ternlatex's ${dir}; ${fix}` };
  const config = join(dir, CONFIG);
  if (!existsSync(config) || readFileSync(config, "utf8") !== configText()) return { ok: false, detail: `${config} is out of date; ${fix}` };
  const problem = catalogProblem(parseCatalog(await ternJson(["plugin", "list"])), realpathSync(dir));
  return problem ? { ok: false, detail: problem } : { ok: true, detail: `ready (${dir})` };
}

/** How Tern has the ternlatex plugin: an installed copy, a link (`tern plugin link`) to a folder, or both. */
export interface TernPluginInstall {
  /** The installed copy in Tern's plugins folder. */
  installed?: string;
  /** The folder Tern's link points to. */
  linkedTo?: string;
}

/** Where Tern has the ternlatex plugin; null without a tern CLI, a Tern that loads plugins, or the plugin. */
export async function findTernPlugin(): Promise<TernPluginInstall | null> {
  let plugins: string;
  try {
    plugins = await pluginsFolder();
  } catch {
    return null;
  }
  const installed = join(plugins, PLUGIN_ID);
  const link = join(plugins, `${PLUGIN_ID}.path`);
  const found: TernPluginInstall = {
    installed: existsSync(installed) ? installed : undefined,
    linkedTo: existsSync(link) ? readFileSync(link, "utf8").trim() : undefined,
  };
  return found.installed !== undefined || found.linkedTo !== undefined ? found : null;
}

/** Takes the plugin out of Tern (`tern plugin unlink`, `tern plugin remove`); Tern keeps its data folder. */
export async function removeTernPlugin(p: TernPluginInstall): Promise<void> {
  if (p.linkedTo !== undefined) await ternJson(["plugin", "unlink", PLUGIN_ID]);
  if (p.installed !== undefined) await ternJson(["plugin", "remove", PLUGIN_ID]);
}

/**
 * What a reply (`{ ok: true, …result }`) carries: block ids, by op (layout: viewer, editor, agent, and tabRows;
 * ask: agent; open: shown or near; popout: pane, or owner), and the flags of ops that leave creating blocks to
 * ternlatex (layoutTab, openSource, popoutViewer).
 */
export type PluginReply = Partial<Record<(typeof REPLY_NUMBERS)[number], number> & Record<(typeof REPLY_FLAGS)[number], boolean>> & {
  /** Absolute file paths (`unsaved`). */
  paths?: string[];
};

const REPLY_NUMBERS = ["viewer", "editor", "agent", "pane", "owner", "shown", "near", "tabRows"] as const;
const REPLY_FLAGS = ["needsViewer", "needsEditor", "needsAgent", "above", "opened"] as const;

/**
 * Asks the plugin's window half (the window this process runs in) to run `op`: writes a request file into the
 * IPC directory and `tern open`s it; the plugin's route claims it and writes the reply. When nothing claims it, the
 * window half is not running: Tern disables a plugin whose load overran its budget until the next reload, which
 * happens when a login after a restart keeps the machine busy. Plugins are then reloaded once and the request sent
 * again.
 */
export async function pluginCall(op: string, args: Record<string, unknown>, o: { timeoutMs?: number } = {}): Promise<PluginReply> {
  const first = await sendRequest(op, args, o.timeoutMs);
  if (first !== null) return first;
  const reload = await ternCli(["plugin", "reload"]);
  if (reload.code !== 0) throw ternError(["plugin", "reload"], reload);
  const again = await sendRequest(op, args, o.timeoutMs);
  if (again !== null) return again;
  throw new Error("the ternlatex Tern plugin did not take the request, even after reloading Tern's plugins; run `ternlatex setup-tern`");
}

/** One request (see pluginCall): its reply, or null when no plugin claimed it. */
async function sendRequest(op: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<PluginReply | null> {
  const ipc = ipcDir();
  const id = randomUUID();
  const request = join(ipc, `${id}.ternlatex`);
  const reply = join(ipc, `${id}.reply.json`);
  await writeFile(request, JSON.stringify({ op, args, reply }));
  try {
    // Without TERN_PANE: Tern would focus that block before routing. The window is still found (TERN_WINDOW_KEY etc.).
    const { TERN_PANE: _, ...env } = process.env;
    const r = await ternCli(["open", request], env);
    // A claimed open exits 1 with this message: the request reached the plugin.
    if (r.code !== 1 || !r.stderr.includes("cannot open in a file block")) {
      if (r.code === 0) return null;
      throw ternError(["open", request], r);
    }
    return await awaitReply(reply, timeoutMs);
  } finally {
    // The plugin deletes the request once read; either is left over when something went wrong.
    await Promise.all([rm(request, { force: true }), rm(reply, { force: true })]);
  }
}

/** Waits for the plugin's reply file; `read` is injectable so a half-written reply can be tested without timing. */
export async function awaitReply(file: string, timeoutMs: number, read = (f: string) => readFile(f, "utf8")): Promise<PluginReply> {
  const deadline = Date.now() + timeoutMs;
  let partial: string | undefined; // A reply caught mid-write: parsed once more after it changes.
  for (;;) {
    let text: string | undefined;
    try {
      text = await read(file);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    if (text !== undefined && text !== partial) {
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        if (partial === undefined) {
          partial = text;
          await Bun.sleep(POLL_MS);
          continue;
        }
        throw new Error(`unreadable answer from the ternlatex Tern plugin: ${text.slice(0, 200)}`);
      }
      if (v && typeof v === "object" && "error" in v && typeof v.error === "string") throw new Error(v.error);
      if (!v || typeof v !== "object" || !("ok" in v) || v.ok !== true) throw new Error(`unexpected answer from the ternlatex Tern plugin: ${text.slice(0, 200)}`);
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(v));
      const out: PluginReply = {};
      for (const k of REPLY_NUMBERS) {
        const n = fields[k];
        if (typeof n === "number") out[k] = n;
      }
      for (const k of REPLY_FLAGS) if (fields[k] === true) out[k] = true;
      // Lua can't tell an empty array from an empty table: `{}` arrives for none.
      if (Array.isArray(fields.paths)) out.paths = fields.paths.filter((p) => typeof p === "string");
      else if (fields.paths && typeof fields.paths === "object") out.paths = [];
      return out;
    }
    if (Date.now() >= deadline) throw new Error(`no answer from the ternlatex Tern plugin within ${timeoutMs / 1000} s; check it with \`ternlatex doctor\``);
    await Bun.sleep(POLL_MS);
  }
}

/*
 * Creating a block (browser, file or shell) takes Tern longer than a window hook's 50 ms budget, and an overrun
 * disables the hook. So the plugin's ops only find and place blocks; ternlatex creates them with the tern CLI.
 */

/** Runs a `tern browser` op in this block's window and returns its `ok` answer. */
async function ternBrowser(op: Record<string, unknown>): Promise<unknown> {
  const args = ["browser", JSON.stringify(op)];
  const r = await ternCli(args);
  let v: unknown;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    throw ternError(args, r);
  }
  if (r.code !== 0 || !v || typeof v !== "object" || !("ok" in v)) throw ternError(args, r);
  return v.ok;
}

/** Opens `url` in a browser block over `owner` (picture in picture, for the plugin to dock); returns its id. */
async function openBrowser(owner: number, url: string): Promise<number> {
  const ok = await ternBrowser({ op: "open", owner, url });
  if (!ok || typeof ok !== "object" || !("block" in ok) || typeof ok.block !== "number") throw new Error(`tern browser open answered without a block: ${JSON.stringify(ok)}`);
  return ok.block;
}

/** The block id in a `tern open|split --json` answer (`{blocks: [id]}` or `{block: id}`). */
function answeredBlock(v: unknown, what: string): number {
  if (v && typeof v === "object") {
    if ("block" in v && typeof v.block === "number") return v.block;
    if ("blocks" in v && Array.isArray(v.blocks) && typeof v.blocks[0] === "number") return v.blocks[0];
  }
  throw new Error(`${what} answered without a block: ${JSON.stringify(v)}`);
}

/** `tern open` of `target` (PATH[:LINE]) as if run in block `from`: beside it, or (`flags`) split or in a tab. */
async function openFile(from: number, target: string, flags: string[]): Promise<number> {
  return answeredBlock(await ternJson(["open", ...flags, target], { ...process.env, TERN_PANE: String(from) }), "tern open");
}

export interface LayoutArgs {
  devPane: number;
  dir: string;
  url: string;
  root: string;
  /** The omp block's argv. */
  agent: string[];
  rows?: number;
}

/**
 * Lays out the dev block's tab (the plugin's `layout` op): the plugin finds what the tab has and places what
 * ternlatex creates for it: first the viewer (over the dev block, docked right of it while the dev block is alone
 * in its column), then the editor (below the dev block) and omp (below the editor). An existing viewer is
 * navigated to `url`.
 */
export async function layoutTab(args: LayoutArgs, o: { timeoutMs?: number } = {}): Promise<PluginReply> {
  const { agent: agentArgv, ...plain } = args;
  let r = await pluginCall("layout", plain, o);
  if (r.viewer !== undefined) await ternBrowser({ op: "goto", block: r.viewer, url: args.url });
  if (r.needsViewer) r = await pluginCall("layout", { ...plain, tabRows: r.tabRows, viewer: await openBrowser(args.devPane, args.url) }, o);
  if (!r.needsEditor && !r.needsAgent) return r;
  const editor = r.needsEditor ? await openFile(args.devPane, `${args.root}:1`, ["--split", "down"]) : r.editor;
  if (editor === undefined) throw new Error("the ternlatex Tern plugin found no editor and asked for none");
  const agent = r.needsAgent ? answeredBlock(await ternJson(["split", String(editor), "down", "--cwd", args.dir, "--", ...agentArgv]), "tern split") : undefined;
  return pluginCall("layout", { ...plain, tabRows: r.tabRows, editor: r.needsEditor ? editor : undefined, agent }, o);
}

/**
 * Shows `path` (at `line`) for the viewer's click-to-source: the block already showing it, else in the project's
 * editor block in place of its file (the plugin does that itself), else a new block below the editor or above
 * the omp block (the plugin's `open` op says which), else in a new tab.
 */
export async function openSource(devPane: number, path: string, line?: number): Promise<void> {
  const where = await pluginCall("open", { devPane, path, ...(line ? { line } : {}) });
  if (where.opened) return;
  const target = line ? `${path}:${line}` : path;
  if (where.shown !== undefined) await openFile(where.shown, target, []);
  else if (where.near === undefined) await openFile(devPane, target, ["--tab"]);
  else {
    const block = await openFile(where.near, target, ["--split", "down"]);
    if (where.above) await ternJson(["move", String(block), "above", String(where.near)]);
  }
}

/** A second viewer at `url` right of the main one (the plugin's `popout` op), or the one already showing it. */
export async function popoutViewer(devPane: number, url: string): Promise<void> {
  const r = await pluginCall("popout", { devPane, url });
  if (r.needsViewer && r.owner !== undefined) await pluginCall("popout", { devPane, url, pane: await openBrowser(r.owner, url) });
}

/** Files under `dir` open in Tern with unsaved edits (absolute paths). */
export async function unsavedFiles(dir: string): Promise<string[]> {
  return (await pluginCall("unsaved", { dir })).paths ?? [];
}

/** One of the plugin's editor commands with its default chord as shown on this platform (`⌘⌥J`, `Ctrl+Alt+J`). */
export interface TernKey {
  id: string;
  title: string;
  hint: string;
  display: string;
}

/**
 * The plugin's editor commands from its tern-plugin/keys.json, which the plugin binds its chords from: ⌘⌥<key> on
 * macOS, Ctrl+Alt+<key> elsewhere.
 */
export async function ternKeys(platform: NodeJS.Platform = process.platform): Promise<TernKey[]> {
  const text = await assetText(`${PACKAGE}tern-plugin/keys.json`);
  if (text === null) throw new Error("tern-plugin/keys.json is missing from this ternlatex");
  const v: unknown = JSON.parse(text);
  const commands: unknown[] = v && typeof v === "object" && "commands" in v && Array.isArray(v.commands) ? v.commands : [];
  const mod = platform === "darwin" ? "⌘⌥" : "Ctrl+Alt+";
  return commands.flatMap((c) => {
    if (!c || typeof c !== "object" || !("id" in c && "key" in c && "title" in c && "hint" in c)) return [];
    const { id, key, title, hint } = c;
    if (typeof id !== "string" || typeof key !== "string" || typeof title !== "string" || typeof hint !== "string") return [];
    return [{ id, title, hint, display: mod + key.toUpperCase() }];
  });
}
