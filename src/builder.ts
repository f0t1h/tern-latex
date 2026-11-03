import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Checksums, current, find, restore, setCurrent, store } from "./buildcache.ts";
import { CONFIG_FILE, type Config, type DocConfig, docPaths, paths, posix } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { compile } from "./engine.ts";

/** One document's build state. */
export interface Status {
  doc: string;
  root: string;
  /** Increments at every build start of this document. */
  build: number;
  /** PDF revision: increments only when a new PDF is published; 0 = none yet. */
  rev: number;
  state: "idle" | "building";
  /** Result of the last finished build; null before the first. */
  ok: boolean | null;
  /** The last build failed but its PDF was published anyway, built past the errors (Config.partial). */
  partial?: boolean;
  /** Missing files a partial PDF shows as placeholders, as the sources name them. */
  placeholders?: string[];
  durationMs?: number;
  finishedAt?: string;
  /** The PDF came from the build cache (its sources match an earlier build) instead of a compile. */
  cached?: boolean;
  /** The PDF came from one TeX run on the last full build's references, which it left unchanged (engine.ts fastPass). */
  fast?: boolean;
  /** While building: why it may take long (the first build downloads the TeX packages). */
  note?: string;
  engine: string;
  diagnostics: Diagnostic[];
}

/** Contents of build/status.json: every document, in config order. */
export interface ProjectStatus {
  docs: Status[];
}

/** Project-level steps around compiles, supplied by the command that owns the builder. */
export interface BuildHooks {
  /** Before a batch of compiles (e.g. regenerate the review setup file). */
  beforeBatch?: () => Promise<void>;
  /** After one document's compile: `rebuild` compiles it once more (citations were imported); `notes` are appended to its diagnostics. */
  afterBuild?: (doc: DocConfig, status: Status) => Promise<AfterBuild>;
  /** After a batch (e.g. checkpoint the working tree). */
  afterBatch?: (built: Status[]) => Promise<void>;
}

export interface AfterBuild {
  rebuild?: boolean;
  notes?: Diagnostic[];
}

const DEBOUNCE_MS = 150;

/** Editor swap/backup files that never feed the build. */
const TRANSIENT = [/~$/, /\.sw[a-p]$/, /(^|\/)\.?#[^/]*#?$/, /(^|\/)4913$/, /\.tmp$/, /\.DS_Store$/];

interface DocState {
  doc: DocConfig;
  status: Status;
  /** Files the last successful compile read; null = unknown, so any change rebuilds. */
  deps: Set<string> | null;
  /** Build cache entry the published PDF came from; null = unknown. */
  current: string | null;
  pending: boolean;
  /** Some pending request asked for a compile even when the cache has the sources' PDF. */
  force: boolean;
  waiters: (() => void)[];
}

/**
 * Builds every document of a project through one queue (one compile at a time; the document a viewer
 * looks at goes first). Requests during a build coalesce into one follow-up build per document. A
 * published PDF only changes on success, by rename, so readers never see a partial or failed PDF.
 */
export class Builder extends EventEmitter<{ status: [Status] }> {
  readonly cfg: Config;
  readonly #docs: DocState[];
  readonly #hooks: BuildHooks;
  #running = false;
  #priority?: string;
  #watcher?: FSWatcher;
  #timer?: NodeJS.Timeout;
  #changed = new Set<string>();
  #writes: Promise<void> = Promise.resolve();

  constructor(cfg: Config, hooks: BuildHooks = {}) {
    super();
    this.cfg = cfg;
    this.#hooks = hooks;
    this.#docs = cfg.docs.map((doc) => ({
      doc,
      deps: null,
      current: current(cfg, doc),
      pending: false,
      force: false,
      waiters: [],
      status: {
        doc: doc.name,
        root: doc.root,
        build: 0,
        rev: existsSync(docPaths(cfg, doc).pdf) ? 1 : 0,
        state: "idle",
        ok: null,
        engine: doc.engine,
        diagnostics: [],
      },
    }));
  }

  status(name?: string): Status {
    return this.#state(name).status;
  }

  all(): Status[] {
    return this.#docs.map((d) => d.status);
  }

  /** Build this document first whenever several are due (the one on screen). */
  prioritize(name: string | undefined): void {
    this.#priority = name;
  }

  /**
   * Builds the named documents (default: all); resolves with their statuses once builds started after this call
   * finish. Sources matching an earlier build reuse its PDF unless `force`.
   */
  async request(names?: string[], o: { force?: boolean } = {}): Promise<Status[]> {
    const states = names ? names.map((n) => this.#state(n)) : this.#docs;
    const done = states.map((s) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      s.waiters.push(resolve);
      s.pending = true;
      s.force ||= o.force === true;
      return promise;
    });
    if (!this.#running) void this.#loop();
    await Promise.all(done);
    return states.map((s) => s.status);
  }

  watch(): void {
    const dir = this.cfg.dir;
    // Everything below compares `/`-separated project-relative paths, the form config values and deps use.
    const outdir = posix(relative(dir, resolve(dir, this.cfg.outdir)));
    const ignore = this.cfg.ignore.map((p) => posix(relative(dir, resolve(dir, p))));
    this.#watcher = watch(dir, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = posix(name); // fs.watch reports native separators (backslashes on Windows).
      if (rel === outdir || rel.startsWith(`${outdir}/`)) return;
      if (rel.split("/").some((seg) => seg.startsWith(".") || seg === "node_modules")) return;
      if (ignore.some((p) => rel === p || rel.startsWith(`${p}/`))) return;
      if (TRANSIENT.some((r) => r.test(rel))) return;
      this.#changed.add(rel);
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#flushChanges(), DEBOUNCE_MS);
    });
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#watcher?.close();
  }

  /** Rebuilds the documents a batch of changed files can affect. */
  #flushChanges(): void {
    const changed = [...this.#changed];
    this.#changed.clear();
    // ternlatex.toml feeds every document (e.g. [review] final), though no engine lists it as a dependency.
    const affected = this.#docs.filter((s) => s.deps === null || s.status.ok !== true || changed.some((f) => f === CONFIG_FILE || f === s.doc.root || s.deps!.has(f)));
    if (affected.length) void this.request(affected.map((s) => s.doc.name));
  }

  #state(name?: string): DocState {
    const s = name === undefined ? this.#docs[0] : this.#docs.find((d) => d.doc.name === name);
    if (!s) throw new Error(`no document "${name}"`);
    return s;
  }

  async #loop(): Promise<void> {
    this.#running = true;
    while (this.#docs.some((d) => d.pending)) {
      await this.#hooks.beforeBatch?.();
      const built: Status[] = [];
      for (;;) {
        const due = this.#docs.filter((d) => d.pending);
        if (!due.length) break;
        const next = due.find((d) => d.doc.name === this.#priority) ?? due[0];
        next.pending = false;
        const force = next.force;
        next.force = false;
        const waiters = next.waiters.splice(0);
        const reused = !force && (await this.#reuse(next));
        if (!reused) {
          await this.#buildOnce(next);
          const after = await this.#hooks.afterBuild?.(next.doc, next.status).catch((e: Error): AfterBuild => ({ notes: [{ severity: "warning", message: e.message }] }));
          if (after?.rebuild) await this.#buildOnce(next);
          if (after?.notes?.length) this.#update(next, { diagnostics: [...next.status.diagnostics, ...after.notes] });
        }
        await this.#writes; // status.json matches the result by the time a requester sees it.
        built.push(next.status);
        for (const w of waiters) w();
      }
      await this.#hooks.afterBatch?.(built).catch(() => {});
    }
    this.#running = false;
  }

  /** Publishes the cached PDF of these exact sources, if there is one; false when a compile is needed. */
  async #reuse(s: DocState): Promise<boolean> {
    const p = docPaths(this.cfg, s.doc);
    const started = Date.now();
    const hit = find(this.cfg, s.doc, new Checksums(this.cfg.dir));
    if (!hit) return false;
    const fresh = hit.key !== s.current || !existsSync(p.pdf);
    if (fresh) {
      await restore(this.cfg, s.doc, hit);
      await publish(p.staged.pdf, p.pdf);
      if (existsSync(p.staged.synctex)) await publish(p.staged.synctex, p.synctex);
      if (existsSync(p.staged.log)) await publish(p.staged.log, p.log);
      s.current = hit.key;
      await setCurrent(this.cfg, s.doc, hit.key);
    }
    s.deps = new Set(hit.deps);
    this.#update(s, {
      state: "idle",
      ok: true,
      partial: false,
      placeholders: undefined,
      cached: true,
      note: undefined,
      rev: fresh || s.status.rev === 0 ? s.status.rev + 1 : s.status.rev,
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
      diagnostics: hit.diagnostics,
    });
    return true;
  }

  async #buildOnce(s: DocState): Promise<void> {
    const p = docPaths(this.cfg, s.doc);
    const started = Date.now();
    // Tectonic keeps its TeX packages in TECTONIC_CACHE_DIR (set by initToolEnv); without its bundle cache the
    // first build downloads them all, which takes a minute or two and looks stalled otherwise.
    const cache = process.env.TECTONIC_CACHE_DIR;
    const cold = s.doc.engine === "tectonic" && cache !== undefined && !existsSync(join(cache, "bundles"));
    const note = cold ? "first build: downloading the TeX packages (1–2 minutes, once)" : undefined;
    this.#update(s, { build: s.status.build + 1, state: "building", note });
    let ok = false;
    let partial = false;
    let placeholders: string[] | undefined;
    let fast = false;
    let diagnostics: Diagnostic[];
    try {
      const result = await compile(this.cfg, s.doc, {
        // A one-pass PDF whose references moved: shown now, while the full build settles them.
        provisional: async (r) => {
          await publish(r.pdf, p.pdf);
          if (existsSync(r.synctex)) await publish(r.synctex, p.synctex);
          this.#update(s, { rev: s.status.rev + 1, note: "references changed: finishing the full build" });
        },
      });
      fast = result.fast === true;
      ok = result.ok;
      partial = result.partial;
      placeholders = result.placeholders;
      diagnostics = result.diagnostics;
      if (result.ok || result.partial) {
        await publish(result.pdf, p.pdf);
        if (existsSync(result.synctex)) await publish(result.synctex, p.synctex);
        s.deps = result.deps ? new Set(result.deps) : null;
      }
      if (result.ok) {
        // Kept for reuse when the sources come back to this state; a cache failure never fails the build. A
        // partial PDF is not kept: its sources are the ones that failed.
        const entry = result.deps
          ? await store(this.cfg, s.doc, { deps: result.deps, started, diagnostics, durationMs: Date.now() - started }).catch(() => null)
          : null;
        s.current = entry?.key ?? null;
        await setCurrent(this.cfg, s.doc, s.current).catch(() => {});
      } else if (result.partial) {
        s.current = null;
        await setCurrent(this.cfg, s.doc, null).catch(() => {});
      }
      if (existsSync(result.log)) await publish(result.log, p.log);
    } catch (e) {
      diagnostics = [{ severity: "error", message: `build crashed: ${(e as Error).message}` }];
    }
    this.#update(s, {
      state: "idle",
      ok,
      partial,
      placeholders,
      cached: false,
      fast,
      note: undefined,
      rev: ok || partial ? s.status.rev + 1 : s.status.rev,
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
      diagnostics,
    });
  }

  #update(s: DocState, patch: Partial<Status>): void {
    s.status = { ...s.status, ...patch };
    const json = JSON.stringify({ docs: this.all() } satisfies ProjectStatus, null, 2) + "\n";
    // Chained so an older snapshot can never land after a newer one.
    this.#writes = this.#writes.then(() => writeAtomic(paths(this.cfg).status, json)).catch(() => {});
    this.emit("status", s.status);
  }
}

/** What a failed build left on screen, for messages: a partial PDF (with its placeholders) or the last good one. */
export function failedPdf(s: Pick<Status, "partial" | "placeholders">): string {
  if (!s.partial) return "the viewer keeps the last good PDF";
  const shown = s.placeholders?.length ? `; ${s.placeholders.join(", ")} shown as placeholders` : "";
  return `the viewer shows a partial PDF built past the errors${shown}`;
}

async function publish(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
}

export async function writeAtomic(dest: string, data: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, dest);
}
