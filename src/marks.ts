import { groupEnd } from "./align.ts";
import { escapeLatex } from "./changes.ts";
import type { Hunk } from "./proofread.ts";

/**
 * Review marks the user makes on the PDF (the viewer's review tools): each becomes the user's tracked change in
 * the source, `\deleted`, `\replaced`, `\added` or `\highlight` (with a comment) from the `changes` package.
 */

export type MarkKind = "delete" | "replace" | "insert" | "highlight" | "comment";

const KINDS: Record<MarkKind, true> = { delete: true, replace: true, insert: true, highlight: true, comment: true };

export function isMarkKind(v: unknown): v is MarkKind {
  return typeof v === "string" && Object.hasOwn(KINDS, v);
}

/**
 * Typed text as LaTeX: plain text has its special characters escaped ("R&D", "50%"); text with a backslash or a
 * `$` is taken as LaTeX the user wrote (`\emph{very}`, `$x$`).
 */
export function typedLatex(text: string): string {
  const t = text.trim();
  return /[\\$]/.test(t) ? t : escapeLatex(t);
}

/** Why SLICE can't be wrapped in a command: it opens or closes a brace group or math it doesn't finish. */
function unbalanced(slice: string): string | null {
  let depth = 0;
  let dollars = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth < 0) break;
    else if (c === "$") dollars++;
  }
  if (depth !== 0) return "the selection starts or ends inside a LaTeX group ({…}); select within it, or all of it";
  if (dollars % 2) return "the selection starts or ends inside math; select within it, or all of it";
  return null;
}

/** Lists whose items a tracked change can fill: the `changes` commands can't hold an environment or a footnote. */
const LIST_ENV = /^(?:itemize|enumerate|description)$/;

/** Whether new text holds what `changes` commands can't: an environment or a footnote (the build stops). */
function structural(latex: string): boolean {
  return /\\begin\s*\{|\\footnote\s*[[{]/.test(latex);
}

/**
 * New text with lists or footnotes as pieces: the scaffolding (`\begin{itemize}`, `\item`, `\footnote{`, `}`) goes in
 * as it is, the text in between as tracked additions, so each piece is markup `changes` can take. Rejecting the
 * additions leaves an empty list or footnote, which resolving removes. A reason when it holds anything else.
 */
export function trackedPieces(latex: string): { text: string; raw: boolean }[] | string {
  const out: { text: string; raw: boolean }[] = [];
  const raw = (text: string) => text && out.push({ text, raw: true });
  const prose = (text: string) => {
    const lead = text.length - text.trimStart().length;
    const body = text.trim();
    raw(text.slice(0, lead));
    if (body) out.push({ text: body, raw: false });
    raw(text.slice(lead + body.length));
  };
  let run = 0;
  let i = 0;
  while (i < latex.length) {
    const rest = latex.slice(i);
    const env = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(rest);
    const item = /^\\item\b(?:\s*\[[^\]]*\])?/.exec(rest);
    const note = /^\\footnote\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(rest);
    if (env && !LIST_ENV.test(env[2])) return `\\${env[1]}{${env[2]}} can't go into a tracked change; only lists (itemize, enumerate, description) and footnotes can`;
    const head = env ?? item ?? note;
    if (!head) {
      i += latex[i] === "\\" ? 2 : 1;
      continue;
    }
    prose(latex.slice(run, i));
    let token = head[0];
    // A list's optional argument (enumitem's [label=…]) belongs to its \begin.
    if (env?.[1] === "begin") token += /^\s*\[[^\]]*\]/.exec(latex.slice(i + token.length))?.[0] ?? "";
    raw(token);
    i += token.length;
    if (note) {
      const close = groupEnd(latex, i);
      const inner = trackedPieces(latex.slice(i + 1, close - 1));
      if (typeof inner === "string") return inner;
      raw("{");
      out.push(...inner);
      raw("}");
      i = close;
    }
    run = i;
  }
  prose(latex.slice(run));
  return out;
}

/** Hunks putting LATEX in at offset AT: one plain addition, else trackedPieces. */
function additions(file: string, src: string, at: number, latex: string): Hunk[] | string {
  const line = lineAt(src, at);
  if (!structural(latex)) return [{ file, start: at, end: at, old: "", new: latex, why: "", line }];
  const pieces = trackedPieces(latex);
  if (typeof pieces === "string") return pieces;
  return pieces.map((p) => ({ file, start: at, end: at, old: "", new: p.text, why: "", line, ...(p.raw ? { markup: "raw" as const } : {}) }));
}

/** SRC[START, END) cut at blank lines into its paragraphs' text, each without surrounding whitespace. */
function paragraphsIn(src: string, start: number, end: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const slice = src.slice(start, end);
  let at = 0;
  for (const m of [...slice.matchAll(/\n[ \t]*\n\s*/g), null]) {
    const stop = m ? m.index : slice.length;
    const piece = slice.slice(at, stop);
    const lead = piece.length - piece.trimStart().length;
    const text = piece.trim();
    if (text) out.push({ start: start + at + lead, end: start + at + lead + text.length });
    if (m) at = m.index + m[0].length;
  }
  return out;
}

function lineAt(src: string, offset: number): number {
  return src.slice(0, offset).split("\n").length;
}

/**
 * The tracked changes for a KIND mark on SRC[START, END) of FILE (the selection's source), with TEXT the user
 * typed (the replacement, insertion or comment); a reason instead when it can't be made. `changes` commands
 * can't hold a paragraph break, so a strike or highlight over several paragraphs is one per paragraph; a
 * comment or insertion goes after the selection, wherever it starts. LATEX: TEXT is LaTeX as it stands (a
 * replacement edited from the source), not typed text to escape.
 */
export function markHunks(file: string, src: string, start: number, end: number, kind: MarkKind, text: string, latex = false): Hunk[] | string {
  const typed = latex ? text.trim() : typedLatex(text);
  if ((kind === "replace" || kind === "insert" || kind === "comment") && !typed) return `type the ${kind === "comment" ? "comment" : "new text"} first`;
  if (kind === "insert") {
    // After the selection, with the space a word needs unless it starts with punctuation or is a footnote.
    return additions(file, src, end, /^(?:[\s.,;:!?)\]]|\\footnote\b)/.test(typed) ? typed : ` ${typed}`);
  }
  if (kind === "comment") {
    // After the passage: wrapping it (\highlight with a comment) would box it on one line, past the margin.
    return [{ file, start: end, end, old: "", new: "", why: text.trim(), line: lineAt(src, end), markup: "comment" }];
  }
  const paragraphs = paragraphsIn(src, start, end);
  if (!paragraphs.length) return "the selection is empty in the source";
  if (kind === "replace" && paragraphs.length > 1) return "a replacement can't span paragraphs: replace one paragraph at a time, or strike them and insert the new text";
  const hunks: Hunk[] = [];
  for (const p of paragraphs) {
    const old = src.slice(p.start, p.end);
    const problem = unbalanced(old);
    if (problem) return problem;
    const line = lineAt(src, p.start);
    // ulem, which draws strikes and highlights, can't take apart a footnote or another review mark (a margin note).
    const inner = [...old.matchAll(/\\(footnote|comment|added|deleted|replaced|highlight)\b\s*(?:\[[^\]]*\])?\s*(?=\{)/g)].map((m) => {
      let e = groupEnd(old, m.index + m[0].length);
      if (m[1] === "replaced") e = groupEnd(old, e); // \replaced{new}{old}
      return { start: m.index, end: e, what: m[1] === "footnote" ? "a footnote" : "another review mark" };
    });
    if (inner.length && kind !== "highlight") return `the selection holds ${inner[0].what}, which can't be struck through: mark the text around it`;
    if (kind === "delete") hunks.push({ file, start: p.start, end: p.end, old, new: "", why: "", line });
    else if (kind === "replace") {
      if (typed === old) return "the new text is the same as the old";
      if (!structural(typed)) hunks.push({ file, start: p.start, end: p.end, old, new: typed, why: "", line });
      else {
        // A list or footnote can't go inside \replaced: strike the old text, then add the new after it.
        const added = additions(file, src, p.end, typed);
        if (typeof added === "string") return added;
        hunks.push({ file, start: p.start, end: p.end, old, new: "", why: "", line }, ...added);
      }
    } else {
      // A highlight goes around them: one per stretch of text between.
      let at = 0;
      for (const f of [...inner, { start: old.length, end: old.length }]) {
        const piece = old.slice(at, f.start);
        const lead = piece.length - piece.trimStart().length;
        const body = piece.trim();
        if (body) {
          const s = p.start + at + lead;
          hunks.push({ file, start: s, end: s + body.length, old: body, new: body, why: "", line: lineAt(src, s), markup: "highlight" });
        }
        at = f.end;
      }
    }
  }
  return hunks;
}

/** The LaTeX a replacement of SRC[START, END) would take out, for editing; a reason when it can't be replaced. */
export function replaceableSource(src: string, start: number, end: number): { start: number; end: number; latex: string } | string {
  // A strike checks the same things a replacement does, one paragraph at a time.
  const spans = markHunks("", src, start, end, "delete", "");
  if (typeof spans === "string") return spans;
  if (spans.length > 1) return "a replacement can't span paragraphs: replace one paragraph at a time, or strike them and insert the new text";
  return { start: spans[0].start, end: spans[0].end, latex: spans[0].old };
}
