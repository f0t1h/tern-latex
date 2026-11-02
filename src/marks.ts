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
 * comment or insertion goes after the selection, wherever it starts.
 */
export function markHunks(file: string, src: string, start: number, end: number, kind: MarkKind, text: string): Hunk[] | string {
  const typed = typedLatex(text);
  if ((kind === "replace" || kind === "insert" || kind === "comment") && !typed) return `type the ${kind === "comment" ? "comment" : "new text"} first`;
  if (kind === "insert") {
    // After the selection, with the space a word needs unless it starts with punctuation.
    const added = /^[\s.,;:!?)\]]/.test(typed) ? typed : ` ${typed}`;
    return [{ file, start: end, end, old: "", new: added, why: "", line: lineAt(src, end) }];
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
    if (kind === "delete") hunks.push({ file, start: p.start, end: p.end, old, new: "", why: "", line });
    else if (kind === "replace") {
      if (typed === old) return "the new text is the same as the old";
      hunks.push({ file, start: p.start, end: p.end, old, new: typed, why: "", line });
    } else hunks.push({ file, start: p.start, end: p.end, old, new: old, why: "", line, markup: "highlight" });
  }
  return hunks;
}
