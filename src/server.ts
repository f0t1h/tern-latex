import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assetBytes } from "./assets.ts";
import { type Builder, type Status, writeAtomic } from "./builder.ts";
import { DICTATION_AUTHOR, OMP_AUTHOR } from "./changes.ts";
import { type DocConfig, docPaths, paths, posix, type ReviewAuthor } from "./config.ts";
import { type Diagnostic, formatDiagnostic } from "./diagnostics.ts";
import { SearchIndex } from "./search.ts";
import { SyncTex } from "./synctex.ts";
import { fileVersion, type Table, type TableEdit, tableAt, tableHunks } from "./table.ts";
import { lineEndOffset, type LocatedRange, locateRange, locateSelection, type SelectionContext } from "./locate.ts";
import { isMarkKind, markHunks, replaceableSource } from "./marks.ts";
import { changesLoaded, type Hunk, writeSuggestions } from "./proofread.ts";
import type { OverleafSync } from "./overleaf.ts";
import { offsetOf, type Position, positionOf, type RewriteRequest, type RewriteResult, widenToSentences } from "./rewrite.ts";
import { pcm16, type SpeechStatus, spokenLatex } from "./speech.ts";
import type { TernKey } from "./ternplugin.ts";
import { openWithDefaultApp } from "./tools.ts";

export interface ServerOptions {
  builder: Builder;
  /** Preferred port; falls back to a free one when taken. */
  port: number;
  /** Opens a project file in the editor. */
  open: (absFile: string, line?: number) => Promise<void>;
  /** Whether `open` reaches a real editor (Tern) rather than just printing the location. */
  editor: boolean;
  /** Submits a prompt to the attached omp block; undefined while none is attached. */
  agent: () => ((prompt: string) => Promise<void>) | undefined;
  /** Dictation with omp's speech model (src/speech.ts); absent: no 🎙 Dictate. */
  dictation?: DictationApi;
  /** The Tern plugin's editor commands with their default chords, for the viewer's hints; absent outside Tern. */
  keys?: TernKey[];
  /** Opens another viewer block showing one document; absent outside Tern. */
  popout?: (url: string) => Promise<void>;
  history?: HistoryApi;
  review?: ReviewApi;
  /** Proofreads a file range (src/proofread.ts) and returns a summary for the viewer. */
  proofread?: (target: { file: string; from: number; to: number }) => Promise<ProofreadSummary>;
  /** Rewrite alternatives for a source range (src/rewrite.ts); nothing is written. */
  rewrite?: (req: RewriteRequest) => Promise<RewriteResult>;
  /** Restarts the dev server in place (`ternlatex restart`); called after the response is sent. */
  restart?: () => void;
  /** Stops the dev server (`ternlatex stop`); called after the response is sent. */
  stop?: () => void;
  /** Keeps an Overleaf clone in step (src/overleaf.ts); absent in other projects. */
  overleaf?: OverleafSync;
}

export interface ProofreadSummary {
  suggestions: number;
  paragraphs: number;
  skipped: Record<string, number>;
  reverted?: string;
  /** Suggestions are stored for Review, not marked in the source (the document doesn't load `changes`). */
  pending?: boolean;
  /** `file:line: old → new (why)` per suggestion. */
  lines: string[];
}

/** Checkpoints and redline diffs (src/vcs.ts, src/latexdiff.ts), injected so the server stays testable. */
export interface HistoryApi {
  checkpoints(limit: number): Promise<{ sha: string; date: string; message: string }[]>;
  diff(doc: DocConfig, rev: string): Promise<{ ok: boolean; pdf: string; diagnostics: Diagnostic[] }>;
}

/** `changes`-package review items (src/changes.ts). */
export interface ReviewApi {
  changes(): { authors: ReviewAuthor[]; items: unknown[] };
  resolve(ids: string[], decision: "accept" | "reject"): Promise<number>;
  /** The author the viewer's review marks carry. */
  me: ReviewAuthor;
}

/** omp's local speech model, injected so the server stays testable. */
export interface DictationApi {
  /** Whether the model can run; checked once at start, again on a dictation request while not ready. */
  status(): Promise<SpeechStatus>;
  /** Mono samples in [-1, 1) at `sampleRate` → text. */
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
}

export type AgentAction = "proofread" | "ask";

/** The omp prompt for diagnostics the user asked to fix from the viewer; errors go through the fix-build skill. */
export function fixPrompt(doc: DocConfig, items: Diagnostic[]): string {
  const list = items.map((d) => `- ${formatDiagnostic(d)}`).join("\n");
  const which = `document "${doc.name}" (${doc.root})`;
  if (items.some((d) => d.severity === "error")) return `/skill:fix-build Fix the build of ${which}. Reported by the viewer:\n${list}`;
  return `Fix these LaTeX warnings in ${which} at their source, following the project rules (fix the cause, never silence the warning):\n${list}\nThen run \`ternlatex build --doc ${doc.name}\` and check they are gone.`;
}

/** The omp prompt for a passage the user selected in the viewer. */
export function agentPrompt(action: AgentAction, file: string, from: number, to: number, text: string, instruction?: string): string {
  const where = from === to ? `${file}:${from}` : `${file}:${from}-${to}`;
  const quote = text ? `\n\nSelected in the PDF viewer:\n> ${text}` : "";
  if (action === "proofread") return `/skill:proofread ${where}${quote}`;
  return `${instruction}\n\nApplies to ${where}.${quote}`;
}

const NO_AGENT = "no omp block attached (run ternlatex dev inside Tern)";
const BAD_AUDIO = "audio (base64 16-bit little-endian PCM, mono) and sampleRate (8000–192000) required";
/** Request body caps: recordings for dictation (2 minutes of 16 kHz audio, base64) and everything else. */
const DICTATE_BODY_LIMIT = 8 * 1024 * 1024;
const BODY_LIMIT = 64 * 1024;

export interface DevServer {
  url: string;
  /** The port actually bound, which differs from the preferred one when that was taken. */
  port: number;
  close(): Promise<void>;
}

/** Written to <outdir>/.server.json so CLI commands (`build`, `show`) can reach a running dev server. */
export interface ServerInfo {
  url: string;
  pid: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** URL prefixes served straight from the shipped assets of the same name. */
const SERVED = ["/viewer/", "/pdfjs/", "/pdfjs-cmaps/", "/pdfjs-fonts/", "/pdfjs-wasm/"];

export async function startServer(o: ServerOptions): Promise<DevServer> {
  const { builder } = o;
  const cfg = builder.cfg;
  const p = paths(cfg);
  const clients = new Set<ServerResponse>();
  const synctex = new Map<string, { rev: number; data: Promise<SyncTex> }>();
  const searchIndex = new SearchIndex(cfg);

  const sse = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const onStatus = (s: Status) => sse("status", s);
  builder.on("status", onStatus);
  const offOverleaf = o.overleaf?.onState((s) => sse("overleaf", s));

  /** The document a request names (`?doc=` or a `doc` body field), defaulting to the first. */
  const docOf = (name: unknown): DocConfig | null => {
    if (name === undefined || name === null || name === "") return cfg.docs[0];
    return cfg.docs.find((d) => d.name === name) ?? null;
  };
  const loadSynctex = (doc: DocConfig): Promise<SyncTex> | null => {
    const file = docPaths(cfg, doc).synctex;
    if (!existsSync(file)) return null;
    const rev = builder.status(doc.name).rev;
    let entry = synctex.get(doc.name);
    if (entry?.rev !== rev) synctex.set(doc.name, (entry = { rev, data: SyncTex.load(file, cfg.dir) }));
    return entry.data;
  };
  /** Project-relative path from a request, or null if it escapes the project. */
  const inProject = (file: unknown): string | null => {
    if (typeof file !== "string" || file === "") return null;
    const abs = resolve(cfg.dir, file);
    const rel = relative(cfg.dir, abs);
    return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
  };

  // SyncTeX names files by their resolved path (macOS /tmp → /private/tmp) or relative to cfg.dir; handle both.
  const realDir = realpathSync(cfg.dir);
  const sourceRel = (file: string) => posix(relative(file.startsWith(realDir + sep) ? realDir : cfg.dir, file));
  /**
   * Source lines of a PDF selection: SyncTeX gives a first guess, the selected text (when sent) pins it down,
   * since SyncTeX misplaces text read as macro arguments (\cventry{…}, custom macros). `end`, the offset right
   * after the selection, is known only when the text was found.
   */
  const selectionSource = async (
    doc: DocConfig,
    page: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
    text: unknown,
    context?: SelectionContext,
  ): Promise<{ file: string; from: number; to: number; end?: number } | null> => {
    const st = await loadSynctex(doc);
    const a = st?.reverse(page, start.x, start.y) ?? null;
    const b = st?.reverse(page, end.x, end.y) ?? null;
    const hint = a ? { file: sourceRel(a.file), line: a.line } : undefined;
    const found = typeof text === "string" ? locateSelection(cfg, doc, text, hint, context) : null;
    if (found) return found;
    if (!a) return null;
    // A selection crossing into another file (an \input boundary) is anchored at its start.
    const [from, to] = b && b.file === a.file ? [Math.min(a.line, b.line), Math.max(a.line, b.line)] : [a.line, a.line];
    return { file: sourceRel(a.file), from, to };
  };
  /** The source range of a PDF selection's text for a rewrite (locateRange), SyncTeX's guess breaking ties. */
  const selectionRange = async (doc: DocConfig, page: number, start: { x: number; y: number }, text: string, context?: SelectionContext): Promise<LocatedRange | null> => {
    const a = (await loadSynctex(doc))?.reverse(page, start.x, start.y) ?? null;
    return locateRange(cfg, doc, text, a ? { file: sourceRel(a.file), line: a.line } : undefined, context);
  };
  /** The table at BODY's source line (`file`, `line`) or PDF point (`page`, `x`, `y`), or why there is none. */
  const tableFor = async (doc: DocConfig, body: Record<string, unknown>): Promise<{ table: Table } | string> => {
    let file: string;
    let line: number;
    if (typeof body.file === "string" && typeof body.line === "number") {
      const abs = inProject(body.file);
      if (!abs || !existsSync(abs)) return "file outside project";
      file = posix(relative(cfg.dir, abs));
      line = body.line;
    } else if (typeof body.page === "number" && typeof body.x === "number" && typeof body.y === "number") {
      const a = (await loadSynctex(doc))?.reverse(body.page, body.x, body.y);
      if (!a) return "no source at that point";
      file = sourceRel(a.file);
      line = a.line;
    } else return "file and line, or page, x and y required";
    const abs = join(cfg.dir, file);
    if (!existsSync(abs)) return `${file} is not in the project`;
    const src = readFileSync(abs, "utf8");
    // The line's end: a `\begin{tabular}` anywhere on it counts.
    const at = src.split("\n").slice(0, Math.max(1, line)).join("\n").length;
    const table = tableAt(file, src, at);
    return table ? { table } : `no table (tabular, tabularx, longtable) at ${file}:${line}`;
  };
  /** Status of omp's speech model: checked at start in the background, again on a request while not ready (`omp setup speech` needs no restart). */
  let speech = o.dictation?.status();
  const speechReady = async (api: DictationApi): Promise<SpeechStatus> => {
    const known = await speech;
    if (known?.ready) return known;
    speech = api.status();
    return speech;
  };

  let serverUrl = ""; // Known once listening; pop-out URLs point back here.
  let port = 0; // Likewise; requests only arrive after it is set.
  let proofreading = false;
  const server = createServer(async (req, res) => {
    try {
      const refused = refusal(req, port);
      if (refused) return send(res, 403, { error: refused });
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /") return sendAsset(res, "viewer/index.html");
      const body = req.method === "POST" ? await json(req, url.pathname.startsWith("/dictate") ? DICTATE_BODY_LIMIT : BODY_LIMIT) : {};
      const doc = docOf(req.method === "POST" ? body.doc : (url.searchParams.get("doc") ?? undefined));
      if (!doc) return send(res, 404, { error: `no such document; documents: ${cfg.docs.map((d) => d.name).join(", ")}` });
      const dp = docPaths(cfg, doc);

      if (route === "GET /docs") return send(res, 200, builder.all());
      if (route === "GET /status") return send(res, 200, url.searchParams.has("doc") ? builder.status(doc.name) : { docs: builder.all() });
      if (route === "GET /pdf") {
        if (!existsSync(dp.pdf)) return send(res, 404, { error: "no PDF yet" });
        return sendFile(res, dp.pdf, url.searchParams.has("download") ? `${doc.name}.pdf` : undefined);
      }
      if (route === "GET /search") {
        const st = await (loadSynctex(doc)?.catch(() => null) ?? null);
        return send(res, 200, await searchIndex.search(doc, url.searchParams.get("q") ?? "", st));
      }
      if (route === "GET /capabilities") {
        const agent = o.agent() !== undefined;
        const caps = {
          agent,
          editor: o.editor,
          popout: Boolean(o.popout),
          history: Boolean(o.history),
          review: Boolean(o.review),
          proofread: Boolean(o.proofread),
          rewrite: Boolean(o.rewrite),
          overleaf: Boolean(o.overleaf),
          ...(o.review ? { reviewer: o.review.me } : {}),
          ...(o.keys ? { keys: o.keys } : {}),
          ...(o.dictation ? { dictation: await speechReady(o.dictation) } : {}),
        };
        return send(res, 200, caps);
      }
      if (route === "GET /events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 1000\n\n");
        for (const s of builder.all()) res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
        if (o.overleaf?.state) res.write(`event: overleaf\ndata: ${JSON.stringify(o.overleaf.state)}\n\n`);
        if (url.searchParams.has("doc")) builder.prioritize(doc.name);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (route === "POST /overleaf/pull") {
        if (!o.overleaf) return send(res, 404, { error: "this project is no Overleaf clone" });
        return send(res, 200, await o.overleaf.check());
      }
      // Co-authors' latest edits on this document's pages (the viewer marks them; nothing is written).
      if (route === "GET /overleaf/edits") {
        const people = (o.overleaf?.state?.people ?? []).filter((p) => p.edit);
        const st = people.length ? await (loadSynctex(doc)?.catch(() => null) ?? null) : null;
        const edits = people.flatMap((p) => {
          const e = p.edit;
          const box = e && st?.forwardLines(join(cfg.dir, e.file), e.line);
          return e && box ? [{ name: p.name, email: p.email, lastAt: p.lastAt, ...e, box }] : [];
        });
        return send(res, 200, { doc: doc.name, rev: builder.status(doc.name).rev, edits });
      }
      if (route === "POST /overleaf/push") {
        if (!o.overleaf) return send(res, 404, { error: "this project is no Overleaf clone" });
        const message = typeof body.message === "string" ? body.message : undefined;
        return send(res, 200, await o.overleaf.push({ message, build: () => builder.request(undefined, { force: false }) }));
      }
      // The viewer reports the document on screen so it is rebuilt first.
      if (route === "POST /focus") {
        builder.prioritize(doc.name);
        return send(res, 200, { ok: true });
      }
      if (route === "POST /build") {
        // ↻ in the viewer means compile; `ternlatex build` passes force:false to reuse a cached PDF of the same sources.
        const docs = await builder.request(body.doc === undefined ? undefined : [doc.name], { force: body.force !== false });
        return send(res, 200, { docs });
      }
      if (route === "POST /open-pdf") {
        if (!existsSync(dp.pdf)) return send(res, 404, { error: "no PDF yet" });
        // The server and the viewer share a machine, so the system PDF app can show the file directly.
        // No opener on PATH throws, which the handler turns into a 500 carrying the message.
        openWithDefaultApp(dp.pdf);
        return send(res, 200, { ok: true });
      }
      if (route === "POST /popout") {
        if (!o.popout) return send(res, 409, { error: "pop-out needs ternlatex dev inside Tern" });
        await o.popout(`${serverUrl}?doc=${encodeURIComponent(doc.name)}`);
        return send(res, 200, { ok: true });
      }
      if (route === "POST /agent") {
        const { action, page, start, end, text, instruction } = body;
        if (action !== "proofread" && action !== "ask") return send(res, 400, { error: "action must be proofread or ask" });
        if (typeof page !== "number" || !isPoint(start) || !isPoint(end)) return send(res, 400, { error: "page, start {x,y}, end {x,y} required" });
        if (action === "ask" && (typeof instruction !== "string" || !instruction.trim())) return send(res, 400, { error: "ask needs an instruction" });
        const submit = o.agent();
        if (!submit) return send(res, 409, { error: NO_AGENT });
        const loc = await selectionSource(doc, page, start, end, text, contextOf(body));
        if (!loc) return send(res, 404, { error: "no source for that selection" });
        const { file, from, to } = loc;
        const quote = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
        await submit(agentPrompt(action, file, from, to, quote, typeof instruction === "string" ? instruction.trim() : undefined));
        return send(res, 200, { file, from, to });
      }
      if (route === "POST /dictate/transcribe") {
        if (!o.dictation) return send(res, 404, { error: "dictation unavailable" });
        const rec = audioOf(body);
        if (!rec) return send(res, 400, { error: BAD_AUDIO });
        const status = await speechReady(o.dictation);
        if (!status.ready) return send(res, 409, { error: status.hint ?? "omp's speech model is not ready" });
        return send(res, 200, { text: (await o.dictation.transcribe(rec.samples, rec.sampleRate)).trim() });
      }
      // Dictated words go in at the end of the selection, as a review suggestion like a proofread's.
      if (route === "POST /dictate") {
        if (!o.dictation) return send(res, 404, { error: "dictation unavailable" });
        const { page, start, end, text } = body;
        if (typeof page !== "number" || !isPoint(start) || !isPoint(end)) return send(res, 400, { error: "page, start {x,y}, end {x,y} required" });
        const rec = audioOf(body);
        if (!rec) return send(res, 400, { error: BAD_AUDIO });
        const status = await speechReady(o.dictation);
        if (!status.ready) return send(res, 409, { error: status.hint ?? "omp's speech model is not ready" });
        const transcript = await o.dictation.transcribe(rec.samples, rec.sampleRate);
        const loc = await selectionSource(doc, page, start, end, text, contextOf(body));
        if (!loc) return send(res, 404, { error: "no source for that selection" });
        const abs = join(cfg.dir, loc.file);
        if (!existsSync(abs)) return send(res, 404, { error: `${loc.file} does not exist` });
        const src = readFileSync(abs, "utf8");
        // Unmatched text: the end of the selection's last SyncTeX line.
        const at = loc.end ?? lineEndOffset(src, loc.to);
        const inserted = spokenLatex(transcript, src.slice(Math.max(0, at - 1), at));
        if (!inserted) return send(res, 422, { error: "didn't catch anything; try again a little closer to the microphone" });
        const line = src.slice(0, at).split("\n").length;
        const hunk: Hunk = { file: loc.file, start: at, end: at, old: "", new: inserted, why: "", line };
        const r = await writeSuggestions(cfg, [hunk], new Map([[loc.file, src]]), { author: DICTATION_AUTHOR, direct: false, build: () => builder.request(), label: "dictation" });
        if (r.reverted) return send(res, 409, { error: `dictation not added: ${r.reverted}` });
        if (!r.hunks.length) return send(res, 409, { error: `${loc.file} changed meanwhile; dictate again` });
        return send(res, 200, { file: loc.file, line, inserted, pending: r.pending === true });
      }
      if (route === "POST /fix") {
        const submit = o.agent();
        if (!submit) return send(res, 409, { error: NO_AGENT });
        const items = Array.isArray(body.diagnostics) ? body.diagnostics.filter(isDiagnostic).slice(0, 30) : [];
        if (!items.length) return send(res, 400, { error: "diagnostics [{severity, message, file?, line?}] required" });
        await submit(fixPrompt(doc, items));
        return send(res, 200, { sent: items.length });
      }
      if (route === "POST /proofread") {
        if (!o.proofread) return send(res, 404, { error: "proofreading unavailable" });
        if (proofreading) return send(res, 409, { error: "a proofread is already running" });
        const { page, start, end } = body;
        if (typeof page !== "number" || !isPoint(start) || !isPoint(end)) return send(res, 400, { error: "page, start {x,y}, end {x,y} required" });
        const loc = await selectionSource(doc, page, start, end, body.text, contextOf(body));
        if (!loc) return send(res, 404, { error: "no source for that selection" });
        proofreading = true;
        try {
          return send(res, 200, await o.proofread(loc));
        } finally {
          proofreading = false;
        }
      }
      // Alternatives for the source of a selection. Its words must be found in the sources (SyncTeX lines alone don't
      // bound a passage); an edge a macro rendered (a citation, \TeX) widens to its whole sentence. Nothing is
      // written; /rewrite/apply does that with the one the user picks.
      if (route === "POST /rewrite") {
        if (!o.rewrite) return send(res, 404, { error: "rewriting unavailable" });
        const { page, start, text, instruction } = body;
        if (typeof page !== "number" || !isPoint(start) || typeof text !== "string") return send(res, 400, { error: "page, start {x,y} and text required" });
        const loc = await selectionRange(doc, page, start, text, contextOf(body));
        if (!loc) return send(res, 404, { error: "couldn't find those words in the source; select at least two words of running text" });
        const abs = join(cfg.dir, loc.file);
        const src = readFileSync(abs, "utf8");
        const [s, e] = widenToSentences(src, loc.file, loc.start, loc.end, { start: loc.startExact, end: loc.endExact });
        const request = {
          file: abs,
          at: positionOf(src, s),
          to: positionOf(src, e),
          count: cfg.rewrite.count,
          instruction: typeof instruction === "string" && instruction.trim() ? instruction.trim() : undefined,
        };
        return send(res, 200, await o.rewrite(request));
      }
      // Replaces from..to of a project file with `replacement` when it still reads `text` (the user may have edited
      // it meanwhile); checkpointed first and undone when it breaks a document's build, like other server edits.
      if (route === "POST /rewrite/apply") {
        const { file, from, to, text, replacement } = body;
        const abs = inProject(file);
        if (!abs || !existsSync(abs)) return send(res, 400, { error: "file outside project" });
        if (!isPosition(from) || !isPosition(to) || typeof text !== "string" || typeof replacement !== "string") {
          return send(res, 400, { error: "from, to {line, col}, text and replacement required" });
        }
        const rel = posix(relative(cfg.dir, abs));
        const src = readFileSync(abs, "utf8");
        const s = offsetOf(src, from);
        const e = offsetOf(src, to);
        if (src.slice(s, e) !== text) return send(res, 409, { error: `${rel} changed meanwhile; rewrite again` });
        const hunk: Hunk = { file: rel, start: s, end: e, old: text, new: replacement, why: "", line: from.line };
        // A direct edit: the author would only name tracked markup.
        const r = await writeSuggestions(cfg, [hunk], new Map([[rel, src]]), { author: OMP_AUTHOR, direct: true, build: () => builder.request(), label: "rewrite" });
        if (r.reverted) return send(res, 409, { error: `not applied: ${r.reverted}` });
        if (!r.hunks.length) return send(res, 409, { error: `${rel} changed meanwhile; rewrite again` });
        return send(res, 200, { file: rel, line: from.line });
      }
      // A review mark on a PDF selection: the user's tracked change (deleted, replaced, added, highlighted with a
      // comment) in the source, checkpointed first and undone when it breaks a build, like other server edits.
      if (route === "POST /review/mark") {
        if (!o.review) return send(res, 404, { error: "review unavailable" });
        const { page, start, text, kind, input } = body;
        if (typeof page !== "number" || !isPoint(start) || typeof text !== "string" || !isMarkKind(kind)) {
          return send(res, 400, { error: "page, start {x,y}, text and kind (delete, replace, insert, highlight, comment) required" });
        }
        const loc = await selectionRange(doc, page, start, text, contextOf(body));
        if (!loc) return send(res, 404, { error: "couldn't find that text in the source (a figure's text, an algorithm, or text from two files?)" });
        // An insertion or comment goes at the end, so only that must be exact; the other marks wrap the selection.
        if (!(kind === "insert" || kind === "comment" ? loc.endExact : loc.startExact && loc.endExact)) {
          return send(res, 422, { error: "couldn't line the selection up with the source word for word (a figure's text, an algorithm, or text from two files?); select running text" });
        }
        const src = readFileSync(join(cfg.dir, loc.file), "utf8");
        const hunks = markHunks(loc.file, src, loc.start, loc.end, kind, typeof input === "string" ? input : "", body.latex === true);
        if (typeof hunks === "string") return send(res, 422, { error: hunks });
        if (hunks.some((h) => h.markup === "highlight" || h.markup === "comment") && !changesLoaded(cfg, [loc.file])) {
          return send(res, 409, { error: "highlights and comments need the changes package: add \\usepackage{changes} to the preamble" });
        }
        const me = o.review.me;
        const r = await writeSuggestions(cfg, hunks, new Map([[loc.file, src]]), { author: me.id, direct: false, build: () => builder.request(), label: `${kind} by ${me.id}` });
        if (r.reverted) return send(res, 409, { error: `not marked: ${r.reverted}` });
        if (!r.pending && r.hunks.length < hunks.length) return send(res, 409, { error: `${loc.file} changed meanwhile; select again` });
        return send(res, 200, { file: loc.file, line: hunks[0].line, author: me.id, pending: r.pending === true });
      }
      // The LaTeX behind a selection, for Replace… to edit instead of the PDF's text.
      if (route === "POST /review/source") {
        const { page, start, text } = body;
        if (typeof page !== "number" || !isPoint(start) || typeof text !== "string") return send(res, 400, { error: "page, start {x,y} and text required" });
        const loc = await selectionRange(doc, page, start, text, contextOf(body));
        if (!loc) return send(res, 404, { error: "couldn't find that text in the source (a figure's text, an algorithm, or text from two files?)" });
        if (!(loc.startExact && loc.endExact)) {
          return send(res, 422, { error: "couldn't line the selection up with the source word for word (a figure's text, an algorithm, or text from two files?); select running text" });
        }
        const src = readFileSync(join(cfg.dir, loc.file), "utf8");
        const r = replaceableSource(src, loc.start, loc.end);
        if (typeof r === "string") return send(res, 422, { error: r });
        return send(res, 200, { file: loc.file, line: src.slice(0, r.start).split("\n").length, latex: r.latex });
      }
      // The table editor: the table at a PDF point or a source line, as rows of LaTeX cells; edits back as marks.
      if (route === "POST /table/probe" || route === "POST /table/source" || route === "POST /table/open") {
        const found = await tableFor(doc, body);
        if (typeof found === "string") return send(res, route === "POST /table/probe" ? 200 : 404, route === "POST /table/probe" ? { table: false } : { error: found });
        const { table } = found;
        if (route === "POST /table/probe") return send(res, 200, { table: true, file: table.file, line: table.line });
        if (route === "POST /table/open") {
          // From the editor (`ternlatex table`): show the table, and have the viewers open it.
          for (const d of cfg.docs) {
            const box = (await loadSynctex(d))?.forward(join(cfg.dir, table.file), table.line);
            if (!box) continue;
            sse("reveal", { doc: d.name, ...box });
            break;
          }
          sse("table", { file: table.file, line: table.line });
          return send(res, 200, { file: table.file, line: table.line, viewers: clients.size });
        }
        return send(res, 200, tableView(table));
      }
      if (route === "POST /table/apply") {
        if (!o.review) return send(res, 404, { error: "review unavailable" });
        const abs = inProject(body.file);
        if (!abs || !existsSync(abs) || typeof body.begin !== "number" || typeof body.version !== "string") return send(res, 400, { error: "file, begin and version required" });
        const edit = tableEdit(body);
        if (!edit) return send(res, 400, { error: "rows [{from, cells, deleted}], columns [{from}] and track required" });
        const file = posix(relative(cfg.dir, abs));
        const src = readFileSync(abs, "utf8");
        const table = tableAt(file, src, body.begin);
        if (fileVersion(src) !== body.version || !table || table.begin !== body.begin) return send(res, 409, { error: `${file} changed meanwhile; open the table again` });
        const hunks = tableHunks(src, table, edit);
        if (typeof hunks === "string") return send(res, 422, { error: hunks });
        if (!hunks.length) return send(res, 200, { file, line: table.line, changed: 0 });
        const me = o.review.me;
        const r = await writeSuggestions(cfg, hunks, new Map([[file, src]]), { author: me.id, direct: !edit.track, build: () => builder.request(), label: `table edit by ${me.id}` });
        if (r.reverted) return send(res, 409, { error: `not saved: ${r.reverted}` });
        if (!r.pending && r.hunks.length < hunks.length) return send(res, 409, { error: `${file} changed meanwhile; open the table again` });
        return send(res, 200, { file, line: table.line, changed: hunks.filter((h) => h.markup !== "raw").length || hunks.length, author: me.id, tracked: edit.track, pending: r.pending === true });
      }
      if (route === "POST /open") {
        const abs = inProject(body.file);
        if (!abs) return send(res, 400, { error: "file outside project" });
        await o.open(abs, typeof body.line === "number" ? body.line : undefined);
        return send(res, 200, { ok: true });
      }
      if (route === "POST /reverse") {
        const { page, x, y } = body;
        if (typeof page !== "number" || typeof x !== "number" || typeof y !== "number") return send(res, 400, { error: "page, x, y must be numbers" });
        const point = { x, y };
        const loc = await selectionSource(doc, page, point, point, body.text, contextOf(body));
        if (!loc) return send(res, 404, { error: "no source at that point" });
        await o.open(join(cfg.dir, loc.file), loc.from);
        return send(res, 200, { file: loc.file, line: loc.from });
      }
      if (route === "POST /forward") {
        const abs = inProject(body.file);
        if (!abs || typeof body.line !== "number") return send(res, 400, { error: "file (in project) and line required" });
        // Without an explicit doc, the first document whose PDF contains the line wins.
        const candidates = body.doc === undefined ? cfg.docs : [doc];
        for (const d of candidates) {
          const box = (await loadSynctex(d))?.forward(abs, body.line);
          if (!box) continue;
          sse("reveal", { doc: d.name, ...box });
          return send(res, 200, { doc: d.name, ...box, viewers: clients.size });
        }
        return send(res, 404, { error: "line not found in any document's PDF" });
      }
      if (route === "GET /checkpoints") {
        if (!o.history) return send(res, 404, { error: "history unavailable" });
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return send(res, 200, await o.history.checkpoints(Number.isFinite(limit) && limit > 0 ? limit : 20));
      }
      if (route === "POST /diff") {
        if (!o.history) return send(res, 404, { error: "history unavailable" });
        if (typeof body.rev !== "string" || !body.rev) return send(res, 400, { error: "rev required" });
        const r = await o.history.diff(doc, body.rev);
        return send(res, 200, { ok: r.ok, diagnostics: r.diagnostics });
      }
      if (route === "GET /diff.pdf") {
        if (!existsSync(dp.diff)) return send(res, 404, { error: "no diff built yet" });
        return sendFile(res, dp.diff);
      }
      if (route === "GET /changes") {
        if (!o.review) return send(res, 404, { error: "review unavailable" });
        return send(res, 200, o.review.changes());
      }
      if (route === "POST /changes/resolve") {
        if (!o.review) return send(res, 404, { error: "review unavailable" });
        const { ids, decision } = body;
        if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string") || (decision !== "accept" && decision !== "reject")) {
          return send(res, 400, { error: "ids (string[]) and decision (accept|reject) required" });
        }
        return send(res, 200, { resolved: await o.review.resolve(ids, decision) });
      }
      if (route === "POST /restart") {
        if (!o.restart) return send(res, 404, { error: "restart unavailable" });
        send(res, 200, { pid: process.pid });
        // After the response is flushed: restarting closes this connection.
        res.once("finish", () => o.restart?.());
        return;
      }
      if (route === "POST /stop") {
        if (!o.stop) return send(res, 404, { error: "stop unavailable" });
        send(res, 200, { pid: process.pid });
        res.once("finish", () => o.stop?.());
        return;
      }
      if (req.method === "GET" && SERVED.some((p) => url.pathname.startsWith(p))) return sendAsset(res, decodeURIComponent(url.pathname.slice(1)));
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof BodyTooLarge ? 413 : 500, { error: (e as Error).message });
    }
  });

  port = await listen(server, o.port);
  const url = `http://127.0.0.1:${port}/`;
  serverUrl = url;
  const info: ServerInfo = { url, pid: process.pid };
  await writeAtomic(p.server, JSON.stringify(info) + "\n");
  // Lets the SSE connections notice server death quickly instead of hanging on keep-alive.
  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15_000);

  return {
    url,
    port,
    async close() {
      clearInterval(ping);
      builder.off("status", onStatus);
      offOverleaf?.();
      for (const c of clients) c.end();
      await unlink(p.server).catch(() => {});
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      server.closeAllConnections();
      return promise;
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const attempt = (p: number) => {
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && p !== 0 ? attempt(0) : reject(e)));
    server.listen(p, "127.0.0.1", () => {
      const addr = server.address(); // Always an AddressInfo for a TCP listener.
      resolve(addr && typeof addr === "object" ? addr.port : p);
    });
  };
  attempt(port);
  return promise;
}

/**
 * Why a request is refused, or null. Only the viewer (same origin) and the CLI (no Origin) may call in: the
 * Host check defeats DNS rebinding, the Origin check other sites, and requiring JSON on POST forces browsers
 * into a CORS preflight, which fails, before any cross-site POST could run.
 */
function refusal(req: IncomingMessage, port: number): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host?.toLowerCase() ?? "")) return "unexpected Host header";
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin.toLowerCase() === `http://${h}`)) return "cross-origin requests are not allowed";
  const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (req.method === "POST" && type !== "application/json") return "POST requires content-type: application/json";
  return null;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** `downloadAs` makes browsers save the file under that name instead of displaying it. */
function sendFile(res: ServerResponse, file: string, downloadAs?: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    ...(downloadAs ? { "content-disposition": `attachment; filename="${downloadAs.replace(/"/g, "")}"` } : {}),
  });
  createReadStream(file).pipe(res);
}

async function sendAsset(res: ServerResponse, rel: string): Promise<void> {
  const bytes = await assetBytes(rel);
  if (!bytes) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(bytes);
}

function isPoint(v: unknown): v is { x: number; y: number } {
  return Boolean(v && typeof v === "object" && "x" in v && "y" in v && typeof v.x === "number" && typeof v.y === "number");
}

/** What the viewer's table editor gets: cells' LaTeX without offsets, rules as lines. */
function tableView(t: Table) {
  return {
    file: t.file,
    line: t.line,
    env: t.env,
    spec: t.spec.text,
    begin: t.begin,
    version: t.version,
    columns: t.columns.map((c) => ({ spec: c.spec, numeric: c.numeric, align: c.align })),
    lines: t.lines.map((l) => (l.kind === "rule" ? { kind: "rule", text: l.text } : { kind: "row", cells: l.cells.map((c) => ({ text: c.text, span: c.span, ...(c.locked ? { locked: c.locked } : {}) })) })),
  };
}

/** A table edit from a request body, or null when it isn't one. */
function tableEdit(body: Record<string, unknown>): TableEdit | null {
  const { rows, columns, track } = body;
  if (!Array.isArray(rows) || !Array.isArray(columns) || typeof track !== "boolean") return null;
  const out: TableEdit = { rows: [], columns: [], track };
  for (const r of rows) {
    if (!r || typeof r !== "object" || !("from" in r) || !("cells" in r) || !Array.isArray(r.cells)) return null;
    const from = r.from === null ? null : typeof r.from === "number" ? r.from : undefined;
    if (from === undefined || !r.cells.every((c: unknown) => typeof c === "string")) return null;
    out.rows.push({ from, cells: r.cells, ...("deleted" in r && r.deleted === true ? { deleted: true } : {}) });
  }
  for (const c of columns) {
    if (!c || typeof c !== "object" || !("from" in c) || (c.from !== null && typeof c.from !== "number")) return null;
    out.columns.push({ from: c.from });
  }
  return out;
}

/** The text around a selection that the viewer sends with it (`before`, `after`), when it does. */
function contextOf(body: Record<string, unknown>): SelectionContext | undefined {
  const { before, after } = body;
  return typeof before === "string" && typeof after === "string" ? { before, after } : undefined;
}

function isPosition(v: unknown): v is Position {
  return Boolean(v && typeof v === "object" && "line" in v && "col" in v && Number.isInteger(v.line) && Number.isInteger(v.col) && Number(v.line) >= 1 && Number(v.col) >= 1);
}

function isDiagnostic(v: unknown): v is Diagnostic {
  if (!v || typeof v !== "object" || !("severity" in v) || !("message" in v) || typeof v.message !== "string") return false;
  if (v.severity !== "error" && v.severity !== "warning" && v.severity !== "info") return false;
  if ("file" in v && v.file !== undefined && typeof v.file !== "string") return false;
  return !("line" in v) || v.line === undefined || typeof v.line === "number";
}

/** The request's recording, or null when malformed. */
function audioOf(body: Record<string, unknown>): { samples: Float32Array; sampleRate: number } | null {
  const { audio, sampleRate } = body;
  if (typeof audio !== "string" || typeof sampleRate !== "number" || !(sampleRate >= 8000 && sampleRate <= 192_000)) return null;
  const samples = pcm16(audio);
  return samples && { samples, sampleRate };
}

class BodyTooLarge extends Error {}

/** The JSON body, at most LIMIT bytes. A larger body is still drained, so the 413 reaches the client. */
async function json(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new BodyTooLarge(`request body too large (over ${limit / 1024} KiB)`);
  const raw = Buffer.concat(chunks).toString("utf8");
  const v: unknown = raw ? JSON.parse(raw) : {};
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
