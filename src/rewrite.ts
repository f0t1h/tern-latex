import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { type Config, posix, UsageError } from "./config.ts";
import { type Paragraph, paragraphs, protectedSpans } from "./proofread.ts";

/**
 * Rewrite alternatives for one sentence (or a selected range) of LaTeX source: the model proposes rewordings,
 * and only those keeping every protected span (commands, math, keys, comments) exactly are returned.
 */

/** A source position: 1-based line, 1-based column in Unicode characters (code points), Tern's convention. */
export interface Position {
  line: number;
  col: number;
}

export interface RewriteRequest {
  /** Absolute path of the .tex file. */
  file: string;
  at: Position;
  /** End of a selection (exclusive); without it the sentence containing `at` is rewritten. */
  to?: Position;
  count: number;
  instruction?: string;
}

export interface Alternative {
  text: string;
  note: string;
}

/** JSON result of `rewrite --json`. */
export interface RewriteResult {
  /** Project-relative, `/`-separated. */
  file: string;
  from: Position;
  /** Exclusive. */
  to: Position;
  /** The exact original source text of from..to. */
  text: string;
  model: string;
  alternatives: Alternative[];
  /** Alternatives dropped because they changed protected LaTeX or structure, or were malformed. */
  rejected: number;
}

/** One model call: system prompt and input in, reply text out (omp in production, a stub in tests). */
export type Ask = (systemPrompt: string, input: string) => Promise<string>;

const SYSTEM_PROMPT = `You rewrite one passage of LaTeX source in several different ways.
Reply with ONLY a JSON array, no prose: [{"text": "<rewritten passage>", "note": "<1-4 words naming the approach>"}].
Give exactly the requested number of alternatives, each a distinct approach (for example: more concise, clearer, more formal, active voice, simpler words); notes must differ.
Keep the meaning, the language and its spelling variety. Rewrite only the passage, not the surrounding paragraph.
Keep every LaTeX command, math ($...$, \\(...\\)), \\cite/\\ref/\\label with their keys, and % comments exactly as written, each exactly as often as in the passage; change only the prose around them. Text inside \\emph{...}, \\textbf{...} and similar may be reworded, but keep the command.
Never add new LaTeX commands, braces, math or comments. Keep a % comment at the end of its line.`;

/** Abbreviations whose period does not end a sentence (lower-cased, with their periods). */
const ABBREVIATIONS: Record<string, true> = {
  "e.g.": true, "i.e.": true, "al.": true, "cf.": true, "fig.": true, "figs.": true, "eq.": true, "eqs.": true, "sec.": true, "secs.": true,
  "dr.": true, "mr.": true, "mrs.": true, "ms.": true, "prof.": true, "vs.": true, "etc.": true, "resp.": true, "approx.": true,
  "no.": true, "nos.": true, "tab.": true, "ch.": true, "chap.": true, "app.": true, "ref.": true, "refs.": true, "vol.": true, "pp.": true,
  "p.": true, "ed.": true, "eds.": true, "st.": true, "jr.": true, "sr.": true, "viz.": true, "ca.": true, "thm.": true, "lem.": true, "def.": true,
};
/** Characters that may close a sentence after its punctuation: quotes, parentheses, braces of a prose argument. */
const CLOSERS = /[)\]}"'’”»]/;
/** What may start the next sentence: an uppercase letter, a command, a digit, or an opening quote/parenthesis. */
const OPENER = /[\p{Lu}\p{N}\\(`"‘“«]/u;
/** Characters outside protected spans whose count an alternative may not change. */
const STRUCTURAL_CHARS = "{}&#^_";

/** UTF-16 offset of a 1-based line/column (columns in code points). */
export function offsetOf(text: string, p: Position): number {
  const lines = text.split("\n");
  if (!Number.isInteger(p.line) || p.line < 1 || p.line > lines.length) throw new UsageError(`line ${p.line} is outside the file (1–${lines.length})`);
  const cps = [...lines[p.line - 1]];
  if (!Number.isInteger(p.col) || p.col < 1 || p.col > cps.length + 1) throw new UsageError(`column ${p.col} is outside line ${p.line} (1–${cps.length + 1})`);
  let off = 0;
  for (let k = 0; k < p.line - 1; k++) off += lines[k].length + 1;
  return off + cps.slice(0, p.col - 1).join("").length;
}

/** 1-based line/column (columns in code points) of a UTF-16 offset. */
export function positionOf(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, col: [...before.slice(lineStart)].length + 1 };
}

function inside(spans: [number, number][], i: number): boolean {
  return spans.some(([a, b]) => i >= a && i < b);
}

/** Offsets (relative to T) just past each sentence end in T; protected spans never end a sentence. */
export function sentenceEnds(t: string, spans: [number, number][] = protectedSpans(t)): number[] {
  const ends: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ((c !== "." && c !== "?" && c !== "!") || inside(spans, i)) continue;
    let j = i + 1;
    while (j < t.length && (CLOSERS.test(t[j]) || t[j] === c)) j++;
    if (j < t.length && !/\s/.test(t[j])) continue;
    let k = j;
    while (k < t.length && /\s/.test(t[k])) k++;
    // A trailing comment on the line does not start the next sentence; look past it.
    while (k < t.length && t[k] === "%") {
      const eol = t.indexOf("\n", k);
      k = eol < 0 ? t.length : eol;
      while (k < t.length && /\s/.test(t[k])) k++;
    }
    if (k < t.length && !OPENER.test(t[k])) continue;
    if (c === ".") {
      const word = /\S+$/.exec(t.slice(0, i + 1))?.[0] ?? "";
      const bare = word.replace(/^[^\p{L}]+/u, "").toLowerCase();
      if (ABBREVIATIONS[bare] === true || /^\p{Lu}\.$/u.test(word.replace(/^[^\p{L}]+/u, ""))) continue;
    }
    ends.push(j);
  }
  return ends;
}

/** Trims whitespace and whole comments off both ends of t[start, end). */
function trimRange(t: string, spans: [number, number][], start: number, end: number): [number, number] {
  for (;;) {
    while (start < end && /\s/.test(t[start])) start++;
    const lead = spans.find(([a]) => a === start);
    if (lead && t[start] === "%") start = Math.min(lead[1], end);
    else break;
  }
  for (;;) {
    while (end > start && /\s/.test(t[end - 1])) end--;
    const tail = spans.find(([a, b]) => t[a] === "%" && b === end && a >= start);
    if (tail) end = tail[0];
    else break;
  }
  return [start, end];
}

/** The sentence of a paragraph containing offset AT (relative to the paragraph), as [start, end) relative to it. */
export function sentenceAt(t: string, at: number): [number, number] {
  const spans = protectedSpans(t);
  const bounds = [0, ...sentenceEnds(t, spans), t.length];
  let k = 0;
  while (k + 1 < bounds.length - 1 && bounds[k + 1] <= at) k++;
  let [start, end] = trimRange(t, spans, bounds[k], bounds[k + 1]);
  // A caret right after a sentence's last character (before the space) belongs to that sentence.
  if (k > 0 && at === bounds[k] && start > at) [start, end] = trimRange(t, spans, bounds[k - 1], bounds[k]);
  return [start, end];
}

/** Sorted texts of the protected spans of S. */
function protectedTexts(s: string): string[] {
  return protectedSpans(s)
    .map(([a, b]) => s.slice(a, b))
    .sort();
}

/** Counts of structural characters outside protected spans, as a comparable string. */
function structure(s: string): string {
  const spans = protectedSpans(s);
  const counts: Record<string, number> = {};
  for (let i = 0; i < s.length; i++) if (STRUCTURAL_CHARS.includes(s[i]) && !inside(spans, i)) counts[s[i]] = (counts[s[i]] ?? 0) + 1;
  return [...STRUCTURAL_CHARS].map((c) => counts[c] ?? 0).join(",");
}

/** Alternatives from a model reply that keep ORIGINAL's protected spans and structure; the rest are counted as rejected. */
export function validAlternatives(original: string, reply: string): { alternatives: Alternative[]; rejected: number } {
  const json = reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1);
  let parsed: unknown;
  try {
    parsed = json ? JSON.parse(json) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) throw new Error(`the model did not reply with a JSON array: ${reply.trim().slice(0, 200)}`);
  const lead = /^\s*/.exec(original)?.[0] ?? "";
  const trail = /\s*$/.exec(original)?.[0] ?? "";
  const want = protectedTexts(original).join("\u0000");
  const shape = structure(original);
  const alternatives: Alternative[] = [];
  let rejected = 0;
  for (const x of parsed) {
    if (!x || typeof x !== "object" || !("text" in x) || typeof x.text !== "string" || !x.text.trim()) {
      rejected++;
      continue;
    }
    const text = lead + x.text.trim() + trail;
    if (text.trim() === original.trim() || alternatives.some((a) => a.text === text)) continue;
    if (protectedTexts(text).join("\u0000") !== want || structure(text) !== shape) {
      rejected++;
      continue;
    }
    const note = "note" in x && typeof x.note === "string" ? x.note.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    alternatives.push({ text, note });
  }
  return { alternatives, rejected };
}

/** Rewrites the target range of REQ with ASK; never writes files. */
export async function rewrite(cfg: Config, req: RewriteRequest, ask: Ask): Promise<RewriteResult> {
  const source = readFileSync(req.file, "utf8");
  const rel = posix(relative(cfg.dir, req.file));
  const at = offsetOf(source, req.at);
  const para: Paragraph | undefined = paragraphs(source, rel).find((p) => at >= p.start && at <= p.end);
  let start: number;
  let end: number;
  if (req.to) {
    start = at;
    end = offsetOf(source, req.to);
    if (end <= start) throw new UsageError("--to must come after FILE:LINE:COL");
  } else {
    if (!para) throw new UsageError(`${rel}:${req.at.line}:${req.at.col} is not in a prose paragraph`);
    const [s, e] = sentenceAt(para.text, at - para.start);
    if (e <= s) throw new UsageError(`no sentence at ${rel}:${req.at.line}:${req.at.col}`);
    start = para.start + s;
    end = para.start + e;
  }
  const text = source.slice(start, end);
  const input = [
    ...(para ? ["Paragraph (context only, do not rewrite it):", para.text, ""] : []),
    "Passage to rewrite:",
    text,
    "",
    `Number of alternatives: ${req.count}`,
    ...(req.instruction ? [`Instruction for every alternative: ${req.instruction}`] : []),
  ].join("\n");
  const { alternatives, rejected } = validAlternatives(text, await ask(SYSTEM_PROMPT, input));
  return {
    file: rel,
    from: positionOf(source, start),
    to: positionOf(source, end),
    text,
    model: cfg.rewrite.model,
    alternatives: alternatives.slice(0, req.count),
    rejected,
  };
}
