// Review markup with the LaTeX `changes` package: scanning, accept/reject rewriting,
// the generated author setup, and importing PDF annotations as \comment[id=…]{…}.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadPdfjs, PDF_DATA } from "./render.ts";
import { type Config, CONFIG_FILE, type DocConfig, docPaths, posix, UsageError } from "./config.ts";
import { compile } from "./engine.ts";
import { SyncTex } from "./synctex.ts";

export type ChangeKind = "added" | "deleted" | "replaced" | "comment" | "highlight";

export interface Change {
  /** Stable while the change's file, kind, author, text and occurrence index are unchanged. */
  id: string;
  kind: ChangeKind;
  author?: string;
  /** Project-relative. */
  file: string;
  /** 1-based line of the command's backslash. */
  line: number;
  /** Raw LaTeX: the new text (added, replaced), the removed text (deleted), the note (comment) or the marked text (highlight). */
  text: string;
  /** replaced: the old text. */
  old?: string;
  /** The optional `comment=` key. */
  comment?: string;
}

/** Project-relative path of the generated author/option setup. */
export const REVIEW_SETUP = "style/ternlatex-review.tex";
export const OMP_AUTHOR = "omp";
/** Author of `ternlatex proofread` suggestions. */
export const PROOF_AUTHOR = "proof";
/** Author of text dictated in the viewer (🎙 Dictate). */
export const DICTATION_AUTHOR = "dictation";

/** Mandatory argument count per command. */
const COMMANDS: Record<ChangeKind, number> = { added: 1, deleted: 1, replaced: 2, comment: 1, highlight: 1 };
/** Environments whose body is not LaTeX. */
const VERBATIM: Record<string, true> = { verbatim: true, "verbatim*": true, Verbatim: true, lstlisting: true, minted: true, comment: true };
/** Argument kept on accept / reject (null: the whole command goes). */
const KEEP: Record<ChangeKind, { accept: number | null; reject: number | null }> = {
  added: { accept: 0, reject: null },
  deleted: { accept: null, reject: 0 },
  replaced: { accept: 0, reject: 1 },
  comment: { accept: null, reject: null },
  highlight: { accept: 0, reject: 0 },
};
/** Colours for authors without one, in order; xcolor base names. */
const PALETTE = ["red", "blue", "orange", "teal", "magenta", "olive", "brown", "purple", "cyan"];
/** Built-in authors (always defined) and their preferred colours. */
export const BUILTIN_AUTHORS: { id: string; name: string; color: string }[] = [
  { id: OMP_AUTHOR, name: "omp", color: "violet" },
  { id: PROOF_AUTHOR, name: "proofreader", color: "teal" },
  { id: DICTATION_AUTHOR, name: "dictation", color: "orange" },
];
const LATEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
};
/** Marks a removed command in rewritten text until whitespace is cleaned up. */
const GONE = "\u0000";
const ANNOTATION_KINDS: Record<string, true> = { Text: true, FreeText: true, Highlight: true, Underline: true, StrikeOut: true, Squiggly: true };

interface Range { start: number; end: number }

/** One parsed command: `start..end` covers `\name[opts]{arg}…`; `args` are the brace contents. */
export interface Span extends Range {
  kind: ChangeKind;
  opts: Record<string, string>;
  args: Range[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Index of the `}` matching the `{` at `open`, or -1. Skips escapes and % comments. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "%") i = lineEnd(text, i);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `]` closing the `[` at `open` (outside braces), or -1. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "%") i = lineEnd(text, i);
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "]" && depth === 0) return i;
  }
  return -1;
}

function lineEnd(text: string, i: number): number {
  const n = text.indexOf("\n", i);
  return n < 0 ? text.length : n;
}

/** Skips whitespace and % comments between a command and its arguments (not a paragraph break). */
function skipSpace(text: string, i: number): number {
  let newlines = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "%") i = lineEnd(text, i);
    else if (c === "\n") {
      if (++newlines > 1) break;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") i++;
    else break;
  }
  return i;
}

/** `id=AK, comment={a, b}` → {id: "AK", comment: "a, b"}. */
function parseOpts(s: string): Record<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(s.slice(from));
  const opts: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith("{") && matchBrace(v, 0) === v.length - 1) v = v.slice(1, -1);
    opts[p.slice(0, eq).trim()] = v;
  }
  return opts;
}

function isKind(name: string): name is ChangeKind {
  return Object.hasOwn(COMMANDS, name);
}

/** Every `changes` command in a LaTeX source, outer before inner (nested ones are found inside arguments). */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "%") {
      i = lineEnd(text, i);
      continue;
    }
    if (c !== "\\") {
      i++;
      continue;
    }
    const name = /^[A-Za-z]+\*?/.exec(text.slice(i + 1, i + 40))?.[0];
    if (!name) {
      i += 2; // control symbol: \{ \} \\ \% …
      continue;
    }
    let j = i + 1 + name.length;
    if (name === "verb" || name === "verb*") {
      const close = text.indexOf(text[j], j + 1);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (name === "begin") {
      const env = /^\s*\{([^}]*)\}/.exec(text.slice(j, j + 60));
      if (env && Object.hasOwn(VERBATIM, env[1])) {
        const close = text.indexOf(`\\end{${env[1]}}`, j);
        i = close < 0 ? text.length : close;
        continue;
      }
    }
    if (!isKind(name)) {
      i = j;
      continue;
    }
    let opts: Record<string, string> = {};
    let k = skipSpace(text, j);
    if (text[k] === "[") {
      const close = matchBracket(text, k);
      if (close < 0) {
        i = j;
        continue;
      }
      opts = parseOpts(text.slice(k + 1, close));
      j = close + 1;
    }
    const args: Range[] = [];
    for (let a = 0; a < COMMANDS[name]; a++) {
      k = skipSpace(text, j);
      const close = text[k] === "{" ? matchBrace(text, k) : -1;
      if (close < 0) break;
      args.push({ start: k + 1, end: close });
      j = close + 1;
    }
    if (args.length === COMMANDS[name]) {
      spans.push({ start: i, end: j, kind: name, opts, args });
      i = args[0].start; // nested commands live inside the arguments
    } else i = i + 1 + name.length;
  }
  return spans;
}

interface Located { change: Change; span: Span }

/** Changes in one file's text, with ids. */
export function scanText(file: string, text: string): Located[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const seen = new Map<string, number>();
  return parseSpans(text).map((span) => {
    const arg = (n: number) => text.slice(span.args[n].start, span.args[n].end);
    const author = span.opts.id || undefined;
    const body = arg(0);
    const old = span.kind === "replaced" ? arg(1) : undefined;
    const key = [file, span.kind, author ?? "", body, old ?? ""].join("\0");
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const id = createHash("sha1").update(`${key}\0${occurrence}`).digest("hex").slice(0, 8);
    const change: Change = { id, kind: span.kind, author, file, line: lineOf(span.start), text: body };
    if (old !== undefined) change.old = old;
    if (span.opts.comment) change.comment = span.opts.comment;
    return { change, span };
  });
}

/** Project .tex files (outside outdir, dot directories, node_modules and `ignore`), project-relative. */
export function texFiles(cfg: Config): string[] {
  const outdir = posix(relative(cfg.dir, resolve(cfg.dir, cfg.outdir)));
  const ignore = cfg.ignore.map((p) => posix(relative(cfg.dir, resolve(cfg.dir, p))));
  return readdirSync(cfg.dir, { recursive: true, encoding: "utf8" })
    .map(posix)
    .filter(
      (f) =>
        f.endsWith(".tex") &&
        !f.startsWith(`${outdir}/`) &&
        !ignore.some((p) => f === p || f.startsWith(`${p}/`)) &&
        !f.split("/").some((s) => s.startsWith(".") || s === "node_modules"),
    )
    .sort();
}

export function scanChanges(cfg: Config): Change[] {
  return texFiles(cfg).flatMap((f) => scanText(f, readFileSync(join(cfg.dir, f), "utf8")).map((l) => l.change));
}

// ---------------------------------------------------------------------------
// Accept / reject
// ---------------------------------------------------------------------------

/** Applies `decision` to the target spans of `text`; nested targets resolve inside their kept argument. */
export function rewrite(text: string, targets: Span[], decision: "accept" | "reject"): string {
  const sorted = [...targets].sort((a, b) => a.start - b.start || b.end - a.end);
  const render = (from: number, to: number): string => {
    let out = "";
    let pos = from;
    for (const t of sorted) {
      if (t.start < pos || t.end > to) continue; // nested in a target already handled, or outside
      out += text.slice(pos, t.start);
      const keep = KEEP[t.kind][decision];
      out += keep === null ? GONE : render(t.args[keep].start, t.args[keep].end);
      pos = t.end;
    }
    return out + text.slice(pos, to);
  };
  return tidy(render(0, text.length));
}

/** Removes GONE markers without leaving double spaces, space before punctuation or emptied lines. */
function tidy(text: string): string {
  if (!text.includes(GONE)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    let l = lines[k];
    if (!l.includes(GONE)) {
      out.push(l);
      continue;
    }
    if (l.replaceAll(GONE, "").trim() === "") {
      // The line held only removed markup: drop it, and one of two blank lines it separated.
      const prevBlank = out.length === 0 || out[out.length - 1].trim() === "";
      if (prevBlank && k + 1 < lines.length && lines[k + 1].trim() === "") k++;
      continue;
    }
    l = l
      .replace(/^([ \t]*)\u0000+[ \t]+/, "$1")
      .replace(/[ \t]+\u0000+(?=[ \t]|$|[.,;:!?)\]'])/g, "")
      .replaceAll(GONE, "");
    out.push(l);
  }
  return out.join("\n");
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content);
  await rename(tmp, path);
}

/** Accepts or rejects the changes with these ids; returns how many were resolved. */
export async function resolveChanges(cfg: Config, ids: string[], decision: "accept" | "reject"): Promise<number> {
  const wanted = new Set(ids);
  const byFile = new Map<string, string>();
  for (const f of texFiles(cfg)) {
    const text = readFileSync(join(cfg.dir, f), "utf8");
    if (scanText(f, text).some((l) => wanted.has(l.change.id))) byFile.set(f, text);
  }
  let resolved = 0;
  const found = new Set<string>();
  for (const [file, text] of byFile) {
    // Ids are computed on the unmodified text; all of a file's targets rewrite in one pass over it.
    const targets = scanText(file, text).filter((l) => wanted.has(l.change.id));
    for (const t of targets) found.add(t.change.id);
    await writeAtomic(join(cfg.dir, file), rewrite(text, targets.map((t) => t.span), decision));
    resolved += targets.length;
  }
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length) throw new UsageError(`no open change with id ${unknown.join(", ")} (${resolved} resolved); list them with \`ternlatex changes\``);
  return resolved;
}

// ---------------------------------------------------------------------------
// Generated setup
// ---------------------------------------------------------------------------

export function escapeLatex(s: string): string {
  return s.replace(/[\\{}$&#_%^~]/g, (c) => LATEX_SPECIALS[c]);
}

/** The content of REVIEW_SETUP for this config. */
export function renderReviewSetup(cfg: Config): string {
  const authors = [...cfg.review.authors];
  const taken = new Set(authors.flatMap((a) => (a.color ? [a.color] : [])));
  for (const b of BUILTIN_AUTHORS) {
    if (!authors.some((a) => a.id === b.id)) authors.push({ id: b.id, name: b.name, color: taken.has(b.color) ? undefined : b.color });
  }
  for (const a of authors) if (a.color) taken.add(a.color);
  const free = PALETTE.filter((c) => !taken.has(c));
  const lines = [
    `% Generated by ternlatex from [review] in ${CONFIG_FILE} before every build; edits are overwritten.`,
    `% Input before \\usepackage{changes} (draft/final is fixed at package load); \\tlreviewsetup after it.`,
    `\\PassOptionsToPackage{${cfg.review.final ? "final" : "draft"}}{changes}`,
    `\\def\\tlreviewsetup{%`,
    ...authors.map((a, n) => `  \\definechangesauthor[name={${escapeLatex(a.name)}}, color=${a.color ?? free[n % free.length] ?? "red"}]{${a.id}}%`),
    `}`,
  ];
  return lines.join("\n") + "\n";
}

/** Writes REVIEW_SETUP when its content changed; true if it wrote. */
export async function writeReviewSetup(cfg: Config): Promise<boolean> {
  const path = join(cfg.dir, REVIEW_SETUP);
  const content = renderReviewSetup(cfg);
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, content);
  return true;
}

// ---------------------------------------------------------------------------
// PDF comment import
// ---------------------------------------------------------------------------

/** A PDF annotation at a point in SyncTeX coordinates (PDF points, top-left origin). */
export interface PdfNote { page: number; x: number; y: number; contents: string; marked?: string }

type Quad = [number, number, number, number]; // x0, y0, x1, y1 (PDF coordinates)

function quads(points: unknown): Quad[] {
  if (!Array.isArray(points) && !(points instanceof Float32Array)) return [];
  const v = Array.from(points, Number);
  const out: Quad[] = [];
  for (let i = 0; i + 8 <= v.length; i += 8) {
    const xs = [v[i], v[i + 2], v[i + 4], v[i + 6]];
    const ys = [v[i + 1], v[i + 3], v[i + 5], v[i + 7]];
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? v : [];
}

/** Words of the page's text whose centre lies inside one of the quads, in reading order. */
function markedText(items: unknown[], qs: Quad[]): string {
  const words: string[] = [];
  for (const q of qs) {
    for (const it of items) {
      if (!it || typeof it !== "object" || !("str" in it) || typeof it.str !== "string" || !("transform" in it)) continue;
      const t = numbers(it.transform);
      const width = "width" in it && typeof it.width === "number" ? it.width : 0;
      const height = "height" in it && typeof it.height === "number" && it.height > 0 ? it.height : Math.abs(t[3] ?? 0);
      if (t.length < 6 || !it.str.length) continue;
      const cy = t[5] + height * 0.35;
      if (cy < q[1] || cy > q[3]) continue;
      for (const m of it.str.matchAll(/\S+/g)) {
        const cx = t[4] + (width * (m.index + m[0].length / 2)) / it.str.length;
        if (cx >= q[0] && cx <= q[2]) words.push(m[0]);
      }
    }
  }
  return words.join(" ");
}

/** Sticky notes, free text and text markup annotations of a PDF. */
export async function readPdfNotes(pdfPath: string): Promise<PdfNote[]> {
  const data = new Uint8Array(await readFile(pdfPath));
  const { getDocument } = await loadPdfjs();
  const task = getDocument({ data, verbosity: 0, ...PDF_DATA });
  const notes: PdfNote[] = [];
  try {
    const pdf = await task.promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const [vx, , , vtop] = page.view;
      const annots: unknown[] = await page.getAnnotations();
      let items: unknown[] | null = null;
      for (const a of annots) {
        if (!a || typeof a !== "object" || !("subtype" in a) || typeof a.subtype !== "string" || !Object.hasOwn(ANNOTATION_KINDS, a.subtype)) continue;
        const co = "contentsObj" in a ? a.contentsObj : undefined;
        const contents = co && typeof co === "object" && "str" in co && typeof co.str === "string" ? co.str : "contents" in a && typeof a.contents === "string" ? a.contents : "";
        const rect = numbers("rect" in a ? a.rect : undefined);
        const qs = quads("quadPoints" in a ? a.quadPoints : undefined);
        let marked: string | undefined;
        if (qs.length) {
          items ??= (await page.getTextContent()).items;
          marked = markedText(items, qs) || undefined;
        }
        if (!contents.trim() && !marked) continue;
        const box = qs[0] ?? rect;
        if (box.length < 4) continue;
        notes.push({ page: p, x: (box[0] + box[2]) / 2 - vx, y: vtop - (box[1] + box[3]) / 2, contents: contents.trim(), marked });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return notes;
}

/** The `\comment` text for a note: specials escaped, one line. */
export function commentBody(n: PdfNote): string {
  const text = n.marked ? `“${n.marked}”${n.contents ? `: ${n.contents}` : ""}` : n.contents;
  return escapeLatex(text.replace(/\s+/g, " ").trim());
}

/** Position in `line` where appended markup goes: before a trailing % comment and trailing spaces. */
function insertionPoint(line: string): number {
  let end = line.length;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "%") {
      end = i;
      break;
    }
  }
  while (end > 0 && /\s/.test(line[end - 1])) end--;
  return end;
}

interface Insertion { file: string; /** 0-based mapped line */ line: number; cmd: string; place: "line" | "para" | "dropped" }

/** Line index where a paragraph-end insertion goes: the last non-blank line of the paragraph holding `line`. */
function paragraphEnd(lines: string[], line: number): number {
  let k = line;
  while (k + 1 < lines.length && lines[k + 1].trim() !== "" && !lines[k + 1].includes("\\end{document}")) k++;
  return k;
}

/** Comment lines that are blank would join two paragraphs; use the previous non-blank line. */
function nonBlank(lines: string[], line: number): number {
  let k = Math.min(line, lines.length - 1);
  while (k > 0 && lines[k].trim() === "") k--;
  return k;
}

async function applyInsertions(cfg: Config, originals: Map<string, string>, ins: Insertion[]): Promise<void> {
  for (const [file, text] of originals) {
    const lines = text.split("\n");
    const extra = new Map<number, string[]>();
    for (const i of ins) {
      if (i.file !== file || i.place === "dropped") continue;
      const at = i.place === "line" ? i.line : paragraphEnd(lines, i.line);
      extra.set(at, [...(extra.get(at) ?? []), i.cmd]);
    }
    for (const [at, cmds] of extra) {
      const l = lines[at];
      const p = insertionPoint(l);
      const rest = l.slice(p);
      lines[at] = `${l.slice(0, p)}${p ? " " : ""}${cmds.join(" ")}${rest.trim() ? ` ${rest.trimStart()}` : ""}`;
    }
    await writeAtomic(join(cfg.dir, file), lines.join("\n"));
  }
}

export interface ImportResult {
  /** Comments placed on the source line their annotation maps to. */
  inserted: number;
  /** Annotations without a source location, or moved/dropped because they broke the build. */
  unmapped: number;
  /** One line per unmapped annotation. */
  notes: string[];
}

/** Inserts the PDF's annotations as `\comment[id=AUTHOR]{…}` at the end of their source lines, then builds. */
export async function importPdfComments(cfg: Config, doc: DocConfig, pdfPath: string, author: string): Promise<ImportResult> {
  if (author !== OMP_AUTHOR && !cfg.review.authors.some((a) => a.id === author)) {
    throw new UsageError(`author "${author}" is not defined; add it to [review] authors in ${CONFIG_FILE}, e.g. authors = [{ id = "${author}", name = "Full Name", color = "orange" }]`);
  }
  if (!existsSync(pdfPath)) throw new UsageError(`${pdfPath} does not exist`);
  const dp = docPaths(cfg, doc);
  if (!existsSync(dp.synctex)) throw new UsageError(`no SyncTeX data for document "${doc.name}"; run \`ternlatex build\` first`);
  const sync = await SyncTex.load(dp.synctex, cfg.dir);
  const result: ImportResult = { inserted: 0, unmapped: 0, notes: [] };
  const realDir = realpathSync(cfg.dir); // SyncTeX records real paths (symlinked dirs expanded)
  const originals = new Map<string, string>();
  const ins: Insertion[] = [];
  for (const n of await readPdfNotes(pdfPath)) {
    const loc = sync.reverse(n.page, n.x, n.y);
    const file = loc && existsSync(loc.file) ? posix(relative(realDir, realpathSync(loc.file))) : "";
    if (!loc || !file || file.startsWith("..")) {
      result.notes.push(`page ${n.page}: no source location for “${n.contents || n.marked}”`);
      continue;
    }
    if (!originals.has(file)) originals.set(file, readFileSync(join(cfg.dir, file), "utf8"));
    const lines = originals.get(file)!.split("\n");
    ins.push({ file, line: nonBlank(lines, loc.line - 1), cmd: `\\comment[id=${author}]{${commentBody(n)}}`, place: "line" });
  }
  if (ins.length) {
    await applyInsertions(cfg, originals, ins);
    let r = await compile(cfg, doc);
    if (!r.ok) {
      const errors = r.diagnostics.filter((d) => d.severity === "error" && d.file && d.line);
      let suspects = ins.filter((i) => errors.some((d) => d.file === i.file && d.line! >= i.line + 1 && d.line! <= i.line + 3));
      if (!suspects.length) suspects = ins;
      for (const place of ["para", "dropped"] as const) {
        for (const s of suspects) s.place = place;
        await applyInsertions(cfg, originals, ins);
        r = await compile(cfg, doc);
        if (r.ok) break;
      }
      if (!r.ok && suspects.length < ins.length) {
        for (const i of ins) i.place = "dropped";
        await applyInsertions(cfg, originals, ins);
        r = await compile(cfg, doc);
      }
      if (!r.ok) {
        // Fails without any imported comment: the build was broken before; keep them where they map.
        for (const i of ins) i.place = "line";
        await applyInsertions(cfg, originals, ins);
        result.notes.push(`the build fails without the imported comments too; kept them on their lines (${errors[0]?.message ?? "see \`ternlatex build\`"})`);
      }
    }
    for (const i of ins) {
      if (i.place === "line") result.inserted++;
      else result.notes.push(`${i.file}:${i.line + 1}: ${i.place === "para" ? "broke the build there; moved to the end of the paragraph" : "broke the build; not inserted"}: ${i.cmd}`);
    }
  }
  result.unmapped = result.notes.filter((n) => !n.startsWith("the build fails")).length;
  return result;
}
