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
  if (/\n[ \t]*\n/.test(slice)) return "the selection spans paragraphs; mark one paragraph at a time";
  return null;
}

/**
 * The tracked change for a KIND mark on SRC[START, END) of FILE (the selection's source), with TEXT the user typed
 * (the replacement, insertion or comment); a reason instead when it can't be made.
 */
export function markHunk(file: string, src: string, start: number, end: number, kind: MarkKind, text: string): Hunk | string {
  const old = src.slice(start, end);
  const line = src.slice(0, start).split("\n").length;
  const typed = typedLatex(text);
  if ((kind === "replace" || kind === "insert" || kind === "comment") && !typed) return `type the ${kind === "comment" ? "comment" : "new text"} first`;
  if (kind === "insert") {
    // After the selection, with the space a word needs unless it starts with punctuation.
    const added = /^[\s.,;:!?)\]]/.test(typed) ? typed : ` ${typed}`;
    return { file, start: end, end, old: "", new: added, why: "", line: src.slice(0, end).split("\n").length };
  }
  if (!old.trim()) return "the selection is empty in the source";
  const problem = unbalanced(old);
  if (problem) return problem;
  if (kind === "delete") return { file, start, end, old, new: "", why: "", line };
  if (kind === "replace") return typed === old ? "the new text is the same as the old" : { file, start, end, old, new: typed, why: "", line };
  if (kind === "comment") {
    // After the passage: wrapping it (\highlight with a comment) would box it on one line, past the margin.
    return { file, start: end, end, old: "", new: "", why: text.trim(), line: src.slice(0, end).split("\n").length, markup: "comment" };
  }
  return { file, start, end, old, new: old, why: "", line, markup: "highlight" };
}
