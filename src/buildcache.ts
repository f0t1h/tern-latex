import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json";
import { CONFIG_FILE, type Config, type DocConfig, docPaths } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";

/**
 * Successful builds kept by the checksums of every file they read, so a document whose sources are back to a
 * state built before (a save without changes, an edit undone, a variant tried and dropped, a restart) gets that
 * PDF again instead of a compile. Per document under <outdir>/.cache/<doc>/<key>/, the most recently used
 * CACHE_SIZE kept.
 */

export const CACHE_SIZE = 8;

let lastStamp = 0;
/** Date.now(), but never the same twice in this process: builds within one millisecond still order. */
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Outputs kept per build: published ones, plus the intermediates other commands read from staging. */
const KEPT = ["pdf", "synctex", "log", "aux", "deps"] as const;
type Kept = (typeof KEPT)[number];

export interface CacheEntry {
  key: string;
  /** ternlatex version and engine: either changing invalidates every entry. */
  version: string;
  engine: string;
  /** Project-relative file → content checksum, for every file the build read plus the root and ternlatex.toml. */
  files: Record<string, string>;
  deps: string[];
  diagnostics: Diagnostic[];
  durationMs: number;
  finishedAt: string;
  /** When it was last built or reused (ms, strictly increasing within a process), for keeping the most recent. */
  usedAt: number;
}

/** Content checksums of project files, each file read once per instance. */
export class Checksums {
  readonly #dir: string;
  readonly #memo = new Map<string, string | null>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** null when the file is missing (a deleted input never matches). */
  of(rel: string): string | null {
    let sum = this.#memo.get(rel);
    if (sum === undefined) {
      const abs = join(this.#dir, rel);
      sum = existsSync(abs) && statSync(abs).isFile() ? Bun.hash(readFileSync(abs)).toString(16) : null;
      this.#memo.set(rel, sum);
    }
    return sum;
  }
}

function cacheDir(cfg: Config, doc: DocConfig): string {
  return join(cfg.dir, cfg.outdir, ".cache", doc.name);
}

/** Where each kept output lives: in the build's staging directory, and inside a cache entry. */
function keptPaths(cfg: Config, doc: DocConfig): Record<Kept, string> {
  const p = docPaths(cfg, doc);
  return { pdf: p.staged.pdf, synctex: p.staged.synctex, log: p.staged.log, aux: p.aux, deps: p.deps };
}

function isEntry(v: unknown): v is CacheEntry {
  if (!v || typeof v !== "object") return false;
  return (
    "key" in v && typeof v.key === "string" && "version" in v && typeof v.version === "string" && "engine" in v &&
    typeof v.engine === "string" && "files" in v && Boolean(v.files) && typeof v.files === "object" && "deps" in v &&
    Array.isArray(v.deps) && "diagnostics" in v && Array.isArray(v.diagnostics) && "usedAt" in v && typeof v.usedAt === "number"
  );
}

/** Entries of a document, most recently used first. */
export function entries(cfg: Config, doc: DocConfig): CacheEntry[] {
  const dir = cacheDir(cfg, doc);
  if (!existsSync(dir)) return [];
  const out: CacheEntry[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "entry.json");
    if (!existsSync(file)) continue;
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isEntry(v) && existsSync(join(dir, name, "pdf"))) out.push(v);
    } catch {
      // A torn or foreign file: not an entry.
    }
  }
  return out.sort((a, b) => b.usedAt - a.usedAt);
}

/** The most recent entry whose every input has the same content now, if any. */
export function find(cfg: Config, doc: DocConfig, sums: Checksums): CacheEntry | null {
  for (const e of entries(cfg, doc)) {
    if (e.version !== version || e.engine !== cfg.engine) continue;
    if (Object.entries(e.files).every(([rel, sum]) => typeof sum === "string" && sums.of(rel) === sum)) return e;
  }
  return null;
}

/**
 * Keeps a successful build whose staged outputs are in place. Not kept when an input changed after `started`
 * (its content may differ from what the build read; the watcher rebuilds anyway). Returns the entry, or null.
 */
export async function store(
  cfg: Config,
  doc: DocConfig,
  build: { deps: string[]; started: number; diagnostics: Diagnostic[]; durationMs: number },
): Promise<CacheEntry | null> {
  const inputs = [...new Set([...build.deps, doc.root, CONFIG_FILE])].sort();
  for (const rel of inputs) {
    const abs = join(cfg.dir, rel);
    if (existsSync(abs) && statSync(abs).mtimeMs > build.started) return null;
  }
  const sums = new Checksums(cfg.dir);
  const files: Record<string, string> = {};
  for (const rel of inputs) {
    const sum = sums.of(rel);
    if (sum !== null) files[rel] = sum;
  }
  const key = Bun.hash(JSON.stringify([version, cfg.engine, files])).toString(16);
  const entry: CacheEntry = {
    key, version, engine: cfg.engine, files, deps: build.deps, diagnostics: build.diagnostics, durationMs: build.durationMs,
    finishedAt: new Date().toISOString(), usedAt: stamp(),
  };
  const root = cacheDir(cfg, doc);
  const dest = join(root, key);
  const tmp = join(root, `.${key}.${process.pid}.tmp`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const from = keptPaths(cfg, doc);
  for (const k of KEPT) if (existsSync(from[k])) await copyFile(from[k], join(tmp, k));
  await writeFile(join(tmp, "entry.json"), JSON.stringify(entry));
  await rm(dest, { recursive: true, force: true });
  await rename(tmp, dest);
  await prune(cfg, doc);
  return entry;
}

/** Puts an entry's outputs back into staging (for the commands that read it) and marks it used. */
export async function restore(cfg: Config, doc: DocConfig, entry: CacheEntry): Promise<void> {
  const dir = join(cacheDir(cfg, doc), entry.key);
  const to = keptPaths(cfg, doc);
  await mkdir(docPaths(cfg, doc).staging, { recursive: true });
  for (const k of KEPT) {
    if (!existsSync(join(dir, k))) continue;
    await copyFile(join(dir, k), `${to[k]}.tmp`);
    await rename(`${to[k]}.tmp`, to[k]);
  }
  await writeFile(join(dir, "entry.json"), JSON.stringify({ ...entry, usedAt: stamp() }));
}

/** The entry last published for a document (survives restarts), or null. */
export function current(cfg: Config, doc: DocConfig): string | null {
  const file = join(cacheDir(cfg, doc), "current");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

export async function setCurrent(cfg: Config, doc: DocConfig, key: string | null): Promise<void> {
  const file = join(cacheDir(cfg, doc), "current");
  if (key === null) await rm(file, { force: true });
  else {
    await mkdir(cacheDir(cfg, doc), { recursive: true });
    await writeFile(file, key);
  }
}

async function prune(cfg: Config, doc: DocConfig): Promise<void> {
  for (const e of entries(cfg, doc).slice(CACHE_SIZE)) await rm(join(cacheDir(cfg, doc), e.key), { recursive: true, force: true });
}
