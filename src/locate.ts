import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Alignment, align, pdfWords, type Token, tokenize, userMacros } from "./align.ts";
import { type Config, type DocConfig, docPaths } from "./config.ts";
import { parseDeps } from "./engine.ts";

/**
 * Finds the source lines of text selected in the PDF by searching the document's .tex files for the words
 * themselves. SyncTeX attributes text read as a macro argument (moderncv's \cventry, custom \pick{…}{…}) to
 * wherever the macro happened to expand, often lines away, so a selection is located by its text first.
 */

export interface Located {
  /** Project-relative file. */
  file: string;
  from: number;
  to: number;
  /** Source offset of the selection's first character (where a rewrite starts). */
  start: number;
  /** Source offset right after the selection's last character (where dictation inserts, a rewrite ends). */
  end: number;
}

/** Source text with commands, braces and comments removed, plus each kept character's source offset. */
export function plainText(src: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  const push = (s: string, i: number) => {
    // Collapse whitespace runs so selections match regardless of line breaks.
    if (/\s/.test(s)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        at.push(i);
      }
      return;
    }
    text += s;
    at.push(i);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      push(" ", i);
    } else if (c === "\\") {
      const m = /^\\([A-Za-z@]+\*?|.)/.exec(src.slice(i));
      const name = m ? m[1] : "";
      if (/^[A-Za-z@]/.test(name)) {
        i += name.length;
        push(" ", i);
      } else {
        // \  \, \& \% …: an escaped character or a space.
        push(name === " " || name === "," ? " " : name, i + 1);
        i += name.length;
      }
    } else if (c === "{" || c === "}") push(" ", i);
    else if (c === "~") push(" ", i);
    else push(c, i);
  }
  return { text, at };
}

/** Normalises PDF text-layer text: compatibility forms (ligatures), soft hyphens, whitespace. */
function normalise(s: string): string {
  return s.normalize("NFKC").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
}

function lineAt(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** Offset of the end of 1-based LINE (before its line break); the file's end past its last line. */
export function lineEndOffset(src: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const nl = src.indexOf("\n", at);
    if (nl < 0) return src.length;
    at = nl + 1;
  }
  const nl = src.indexOf("\n", at);
  return nl < 0 ? src.length : nl > 0 && src[nl - 1] === "\r" ? nl - 1 : nl;
}

/** The .tex files the document read in its last successful build (just its root before that). */
export function docTexFiles(cfg: Config, doc: DocConfig): string[] {
  const p = docPaths(cfg, doc);
  const deps = existsSync(p.deps) ? parseDeps(readFileSync(p.deps, "utf8"), cfg.dir, relative(cfg.dir, p.staging)) : [];
  const files = deps.filter((f) => f.endsWith(".tex"));
  return files.length ? files : [doc.root];
}

/** Text around a selection in the PDF (the viewer's text layer), to tell repeated words apart. */
export interface SelectionContext {
  before: string;
  after: string;
}

const CONTEXT_WORDS = 8;

/** How many of CONTEXT's words sit next to the aligned tokens as they do in the PDF: up to 8 on each side. */
function contextFit(tokens: Token[], a: Alignment, context: SelectionContext): number {
  const near = (x: string[], y: string[]) => {
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
  };
  const wordsAt = (from: number, step: number) => {
    const out: string[] = [];
    for (let k = from; k >= 0 && k < tokens.length && out.length < CONTEXT_WORDS; k += step) {
      const w = tokens[k].word;
      if (w !== null) out.push(w);
    }
    return out;
  };
  const before = near(wordsAt(a.first - 1, -1), pdfWords(context.before).reverse().slice(0, CONTEXT_WORDS));
  const after = near(wordsAt(a.last + 1, 1), pdfWords(context.after).slice(0, CONTEXT_WORDS));
  return before + after;
}

/**
 * Where SELECTION (as the viewer's text layer reports it) is in the document's sources, word by word through
 * macros (src/align.ts): a selection that begins or ends in what a command typesets (\tool, a citation, math)
 * covers the command. Of several matches: the one whose surrounding words best match CONTEXT (the text around
 * it in the PDF), then the one with fewest words left to commands, then the one nearest HINT (the SyncTeX guess,
 * a line at best). Null when the words are not found. A single word is only looked for in HINT's file: anywhere
 * else it would match too often to mean anything.
 */
export function locateSelection(cfg: Config, doc: DocConfig, selection: string, hint?: { file: string; line: number }, context?: SelectionContext): Located | null {
  const words = pdfWords(selection);
  const single = words.length === 1;
  if (!words.length || (single && !hint)) return null;
  const texts = new Map<string, string>();
  for (const file of docTexFiles(cfg, doc)) {
    const abs = join(cfg.dir, file);
    if (existsSync(abs)) texts.set(file, readFileSync(abs, "utf8"));
  }
  const macros = userMacros([...texts.values()]);
  // Punctuation the selection starts or ends with (a closing parenthesis, a full stop) belongs to it in the source too.
  const text = normalise(selection);
  const lead = /^[^\p{L}\p{N}\s]+/u.exec(text)?.[0] ?? "";
  const trail = /[^\p{L}\p{N}\s]+$/u.exec(text)?.[0] ?? "";
  const raw = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  let best: (Located & { rank: number[] }) | null = null;
  for (const [file, src] of texts) {
    if (single && file !== hint?.file) continue;
    const tokens = tokenize(src, macros);
    for (const a of align(words, tokens)) {
      // Most of it must be the source's own words: commands can't stand for everything.
      const matched = words.length - a.loose;
      if (matched < 1 || a.loose > matched + 2) continue;
      let start = tokens[a.first].start;
      let end = tokens[a.last].end;
      for (let k = lead.length - 1; k >= 0 && src[start - 1] === lead[k]; k--) start--;
      for (const c of trail) {
        if (src[end] === c) end++;
        else if (src[end] === "\\" && src[end + 1] === c) end += 2; // \% \&
        else break;
      }
      const from = lineAt(src, start);
      const distance = hint && hint.file === file ? Math.abs(from - hint.line) : hint ? 1e6 : 0;
      const fit = context ? contextFit(tokens, a, context) : 0;
      // Case breaks ties: "the" before "The".
      const cased = Number(src.startsWith(raw[0] ?? "", tokens[a.first].start)) + Number(src.slice(0, tokens[a.last].end).endsWith(raw.at(-1) ?? ""));
      // Better context, then fewer words left to commands, then matching case, then nearer SyncTeX's line.
      const rank = [-fit, a.loose, -cased, distance];
      const k = best ? rank.findIndex((v, n) => v !== best?.rank[n]) : 0;
      if (!best || (k >= 0 && rank[k] < best.rank[k])) best = { file, from, to: lineAt(src, end - 1), start, end, rank };
    }
  }
  return best ? { file: best.file, from: best.from, to: best.to, start: best.start, end: best.end } : null;
}

/** A selection's source range from locateRange; an edge that isn't exact is where its nearest found words begin or end. */
export interface LocatedRange {
  file: string;
  start: number;
  end: number;
  /** The selection's first (last) words were found as they are; otherwise the edge falls inside the selection. */
  startExact: boolean;
  endExact: boolean;
}

/** The first run of `size` consecutive WORDS, trying start indexes `ks` in order, found in HAY at or after `from`. */
function findRun(words: string[], hay: string, size: number, ks: number[], from: number): { k: number; at: number } | null {
  for (const k of ks) {
    const probe = words.slice(k, k + size).join(" ");
    const at = hay.indexOf(probe, from);
    if (at >= 0) return { k, at };
  }
  return null;
}

/**
 * Like locateSelection, but also for selections whose first or last words a macro rendered (a citation's
 * "Knuth (1984)", `\TeX`): the range then starts at the first run of three (two in short selections) of its words
 * found in the sources and ends after the last such run, nearest HINT, flagged inexact so the caller can widen it
 * (to whole sentences, for a rewrite). Null when no run is found.
 */
export function locateRange(cfg: Config, doc: DocConfig, selection: string, hint?: { file: string; line: number }, context?: SelectionContext): LocatedRange | null {
  const exact = locateSelection(cfg, doc, selection, hint, context);
  if (exact) return { file: exact.file, start: exact.start, end: exact.end, startExact: true, endExact: true };
  const words = normalise(selection).split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const size = Math.min(words.length, words.length >= 6 ? 3 : 2);
  const forward = Array.from({ length: words.length - size + 1 }, (_, k) => k);
  const backward = [...forward].reverse();
  let best: (LocatedRange & { distance: number }) | null = null;
  for (const file of docTexFiles(cfg, doc)) {
    const abs = join(cfg.dir, file);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const plain = plainText(src);
    const hay = plain.text.normalize("NFKC");
    for (let from = 0; ; ) {
      const head = findRun(words, hay, size, forward, from);
      if (!head) break;
      // The last run at or after the head, within twice the selection's length of it.
      const tail = findRun(words, hay, size, backward.filter((k) => k >= head.k), head.at);
      const tailEnd = tail ? tail.at + words.slice(tail.k, tail.k + size).join(" ").length : -1;
      if (tail && tailEnd - head.at <= 2 * selection.length + 40) {
        const start = plain.at[head.at];
        const end = plain.at[Math.min(tailEnd - 1, plain.at.length - 1)] + 1;
        const line = lineAt(src, start);
        const distance = hint && hint.file === file ? Math.abs(line - hint.line) : hint ? 1e6 : 0;
        if (!best || distance < best.distance) {
          best = { file, start, end, startExact: head.k === 0, endExact: tail.k + size === words.length, distance };
        }
      }
      from = head.at + 1;
    }
  }
  return best ? { file: best.file, start: best.start, end: best.end, startExact: best.startExact, endExact: best.endExact } : null;
}
