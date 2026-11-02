import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type Config, type DocConfig, docPaths, posix } from "./config.ts";
import { docTexFiles } from "./locate.ts";
import { maskSource } from "./outline.ts";
import { loadCanvas, loadPdfjs, PDF_DATA } from "./render.ts";
import type { PdfBox, SyncTex } from "./synctex.ts";

/**
 * Fuzzy search over a document's typeset text (the PDF) and its LaTeX prose (the sources minus preamble,
 * comments, math, keys of packages, files, lengths and colours), merged into one list of places on the PDF.
 * A source match is placed with SyncTeX and joined with the PDF match of the same words there.
 */

/** One place the query matched. */
export interface SearchHit {
  /** Where it matched: the typeset text, the LaTeX source, or both at the same place. */
  in: "pdf" | "source" | "both";
  /** 0–1: 1 is the query's words exactly, less for prefixes, typos and words apart. */
  score: number;
  /** A word here looks like a misspelling, in the document, of a query word it has elsewhere ("fsat" for "fast"). */
  typo?: true;
  /** The page it is on, when known. */
  page?: number;
  /** The matched words' boxes (top-left-origin PDF points); absent when only `box` is known. */
  rects?: PdfBox[];
  /** For a match only in the source: the lines SyncTeX puts it on. */
  box?: PdfBox;
  /** Project-relative file and 1-based line. */
  source?: { file: string; line: number };
  /** The text around and of the match: typeset text when the PDF matched, else the source's prose. */
  before: string;
  match: string;
  after: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** More places matched than `hits` holds. */
  truncated: boolean;
}

const MAX_HITS = 500;
/** Matches scoring below this are dropped, and so are those more than SCORE_BAND below the best one. */
const MIN_SCORE = 0.45;
const SCORE_BAND = 0.3;
/** How far (in words) beyond the query's length its words may spread. */
const SPAN_SLACK = 2;
/** Snippet context on each side, in characters. */
const CONTEXT = 60;

const FOLDED: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", ı: "i", đ: "d", ð: "d", þ: "th" };

/** A word as search compares it: compatibility forms (ligatures) split, accents and case dropped. */
export function fold(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłıđðþ]/g, (c) => FOLDED[c])
    .replace(/['’]/g, "");
}

/** Greek letters by their (folded, NFKD) character: the names of their LaTeX commands. */
const GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ι: "iota", κ: "kappa",
  λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", ο: "omicron", π: "pi", ρ: "rho", σ: "sigma", ς: "sigma", τ: "tau",
  υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega", ϑ: "theta", ϖ: "pi", ϱ: "rho",
};

/** Math symbols as typeset (pdf.js gives their Unicode characters) and the LaTeX command each comes from. */
const MATH_SYMBOLS: Record<string, string> = {
  "∑": "sum", "∏": "prod", "∐": "coprod", "∫": "int", "∬": "iint", "∭": "iiint", "∮": "oint", "√": "sqrt",
  "∞": "infty", "∂": "partial", "∇": "nabla", "±": "pm", "∓": "mp", "×": "times", "÷": "div", "·": "cdot", "⋅": "cdot",
  "∘": "circ", "∗": "ast", "⋆": "star", "⊕": "oplus", "⊗": "otimes", "≤": "leq", "≥": "geq", "≠": "neq", "\u0338": "neq",
  "≈": "approx", "≡": "equiv", "∼": "sim", "≃": "simeq", "≅": "cong", "∝": "propto", "≪": "ll", "≫": "gg",
  "∈": "in", "∉": "notin", "∋": "ni", "⊂": "subset", "⊃": "supset", "⊆": "subseteq", "⊇": "supseteq", "∪": "cup",
  "∩": "cap", "⋃": "bigcup", "⋂": "bigcap", "∧": "wedge", "∨": "vee", "¬": "neg", "∀": "forall", "∃": "exists",
  "∅": "emptyset", "→": "rightarrow", "←": "leftarrow", "↔": "leftrightarrow", "⇒": "rightarrow", "⇐": "leftarrow",
  "⇔": "leftrightarrow", "↦": "mapsto", "⋯": "cdots", "…": "ldots", "ℓ": "ell", "ℏ": "hbar", "⊥": "perp",
  "∥": "parallel", "∠": "angle", "⟨": "langle", "⟩": "rangle", "†": "dagger",
};

/** Other names of the same symbols (folded case: \Rightarrow and \rightarrow are one key). */
const MATH_ALIASES: Record<string, string> = {
  le: "leq", ge: "geq", ne: "neq", to: "rightarrow", gets: "leftarrow", implies: "rightarrow", impliedby: "leftarrow",
  iff: "leftrightarrow", longrightarrow: "rightarrow", longleftarrow: "leftarrow", longleftrightarrow: "leftrightarrow",
  varepsilon: "epsilon", varphi: "phi", vartheta: "theta", varrho: "rho", varsigma: "sigma", varpi: "pi",
  land: "wedge", lor: "vee", lnot: "neg", varnothing: "emptyset", dots: "ldots", dotsc: "ldots", dotsb: "cdots",
  bigoplus: "oplus", bigotimes: "otimes", bigwedge: "wedge", bigvee: "vee", lvert: "mid", rvert: "mid",
};

/** Math operators typeset as upright words: `\log` is the word "log" in the PDF. */
const OPERATORS = new Set([
  "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh",
  "tanh", "coth", "max", "min", "sup", "inf", "lim", "liminf", "limsup", "det", "dim", "ker", "arg", "deg", "gcd",
  "hom", "pr", "mod", "bmod", "pmod",
]);

/** The key of a LaTeX math command NAME (without its backslash): `\le` and `≤` are both `\leq`; `\log` is "log". */
function mathKey(name: string): string {
  const lower = name.toLowerCase();
  if (OPERATORS.has(lower)) return lower;
  return `\\${MATH_ALIASES[lower] ?? lower}`;
}

const SYMBOL_CHARS = Object.keys(MATH_SYMBOLS).join("");
const GREEK_CHARS = "\\u0370-\\u03FF\\u{1D6A8}-\\u{1D7CB}";
/**
 * What search compares: a math command (`\sum`, in the query and the source's math), a math symbol or Greek
 * letter (one character each), or a word (letters and digits; Greek letters stand alone, as in math).
 */
const TOKEN = new RegExp(
  `\\\\[A-Za-z]+|[${SYMBOL_CHARS}${GREEK_CHARS}]|(?:(?![${GREEK_CHARS}])[\\p{L}\\p{N}])+(?:['’](?:(?![${GREEK_CHARS}])[\\p{L}\\p{N}])+)*`,
  "gu",
);

/** A token's key: math commands, symbols and Greek letters as `\name`, words folded. */
export function tokenKey(token: string): string {
  if (token.startsWith("\\")) return mathKey(token.slice(1));
  const symbol = MATH_SYMBOLS[token];
  if (symbol) return `\\${symbol}`;
  const base = fold(token);
  const greek = GREEK[base];
  return greek ? `\\${greek}` : base;
}

/** The query's tokens as keys: `\sum` and `∑` are one, `\Gamma` and `Γ` too. */
export function queryTerms(query: string): string[] {
  return [...query.matchAll(TOKEN)].map((m) => tokenKey(m[0]));
}

/** Rows of a QWERTY keyboard (also the letter positions of QWERTY-based layouts such as Turkish Q), staggered. */
const KEY_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** Each key's neighbours: beside it, and the two touching it in the rows above and below. */
const NEIGHBOURS: ReadonlyMap<string, string> = new Map(
  KEY_ROWS.flatMap((row, r) =>
    [...row].map((key, i): [string, string] => {
      const up = KEY_ROWS[r - 1] ?? "";
      const down = KEY_ROWS[r + 1] ?? "";
      return [key, `${row[i - 1] ?? ""}${row[i + 1] ?? ""}${up[i] ?? ""}${up[i + 1] ?? ""}${down[i - 1] ?? ""}${down[i] ?? ""}`];
    }),
  ),
);

/** Whether keys A and B are the same or neighbours; false when either is missing (a word's edge). */
function nextTo(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && (a === b || (NEIGHBOURS.get(a)?.includes(b) ?? false));
}

/** Typing slips and what each costs: the likely ones (a neighbouring key, a doubled letter) cost less. */
const COST = {
  /** Hit a neighbouring key instead. */
  near: 0.5,
  /** Any other wrong letter. */
  wrong: 1,
  /** An extra letter next to its own key or a copy of a neighbour ("seaarch", "searvch"). */
  slip: 0.5,
  /** Any other extra letter, or a missed one. */
  gap: 0.8,
  /** A missed copy of a doubled letter ("ocur"). */
  double: 0.5,
  /** Two letters swapped. */
  swap: 0.6,
};

/**
 * The cost of the slips that turn TYPED into WORD (Damerau, optimal string alignment, with COST), or a number
 * above MAX once it certainly exceeds it.
 */
export function typoCost(typed: string, word: string, max: number): number {
  const over = max + 1;
  if (Math.abs(typed.length - word.length) * COST.slip > max) return over;
  // An extra typed letter: cheap when it is next to (or a copy of) a letter beside it.
  const extra = (i: number) => (nextTo(typed[i], typed[i - 1]) || nextTo(typed[i], typed[i + 1]) ? COST.slip : COST.gap);
  // A letter of WORD not typed: cheap when it is one of a double.
  const missed = (j: number) => (word[j] === word[j - 1] || word[j] === word[j + 1] ? COST.double : COST.gap);
  let before: number[] = [];
  let prev = [0];
  for (let j = 1; j <= word.length; j++) prev.push(prev[j - 1] + missed(j - 1));
  for (let i = 1; i <= typed.length; i++) {
    const row = [prev[0] + extra(i - 1)];
    let least = row[0];
    for (let j = 1; j <= word.length; j++) {
      const a = typed[i - 1];
      const b = word[j - 1];
      const sub = a === b ? 0 : nextTo(a, b) ? COST.near : COST.wrong;
      let v = Math.min(prev[j] + extra(i - 1), row[j - 1] + missed(j - 1), prev[j - 1] + sub);
      if (i > 1 && j > 1 && a === word[j - 2] && typed[i - 2] === b) v = Math.min(v, before[j - 2] + COST.swap);
      row.push(v);
      least = Math.min(least, v);
    }
    if (least > max) return over;
    before = prev;
    prev = row;
  }
  return prev[word.length];
}

/** Scores from here up are the query word itself or its start: a document that has them gets no typo matches. */
const STRONG = 0.8;

/**
 * How well query TERM matches document word KEY (both keys); LAST terms may be typed partly. A `\name` term
 * matches only math (`\sum` never finds the word "sum"); a plain term also finds math by its name, a little
 * below the word itself ("sum" finds ∑).
 */
function termScore(term: string, key: string, last: boolean): number {
  const termMath = term.startsWith("\\");
  const keyMath = key.startsWith("\\");
  if (termMath || keyMath) {
    if (termMath && !keyMath) return 0;
    const s = termScore(termMath ? term.slice(1) : term, key.slice(1), last);
    return termMath ? s : s * 0.95;
  }
  if (key === term) return 1;
  if (term.length >= 2 && key.startsWith(term)) return last ? 0.9 : STRONG;
  if (term.length >= 3 && key.includes(term)) return 0.65;
  // Typo budget: none for short words, where a slip makes another word.
  const budget = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
  if (!budget) return 0;
  const typoScore = (cost: number) => 0.78 - 0.15 * cost;
  const d = typoCost(term, key, budget);
  if (d <= budget) return typoScore(d);
  if (last && key.length > term.length) {
    // Typed partly, with a slip: "serac" → "searching".
    const p = typoCost(term, key.slice(0, term.length), budget);
    if (p <= budget) return typoScore(p) - 0.1;
  }
  return 0;
}

/** A run of words matching the query: indexes of its first and last word. */
export interface Match {
  from: number;
  to: number;
  score: number;
  /** A word of it looks like a misspelling of a query word the document has elsewhere (TermRule's set). */
  typo: boolean;
}

/** Index of the first of the ascending POSITIONS at or after `at`. */
function lowerBound(hits: { pos: number }[], at: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].pos < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * How a query word may match document words that are neither it nor start with it: "any" (the document doesn't
 * have the word, so the query may be the misspelt one: typos and words containing it), or only the words of the
 * set (the document has the word; these look like misspellings of it in the document).
 */
export type TermRule = "any" | ReadonlySet<string>;

/** A slip this likely (COST: a neighbouring key, a swap, a doubled letter) can be a misspelling in the document. */
const LIKELY_SLIP = 0.6;
/** ...when the misspelt word occurs at most this often; a word used more is a word ("last" is not "fast"). */
const RARE = 2;

/**
 * The rule for each of TERMS over a document's words: its PDF's (PDF_KEYS) and its sources' (SOURCE_KEYS).
 * A fuzzy finder that offers "last" for "fast" in a text that has "fast" is noise, but a single "fsat" in that
 * text is a typo worth finding.
 */
export function termRules(pdfKeys: readonly string[], sourceKeys: readonly (readonly string[])[], terms: readonly string[]): TermRule[] {
  const tally = (lists: readonly (readonly string[])[]) => {
    const m = new Map<string, number>();
    for (const list of lists) for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const inPdf = tally([pdfKeys]);
  const inSource = tally(sourceKeys);
  const words = new Set([...inPdf.keys(), ...inSource.keys()]);
  return terms.map((t, j) => {
    let present = false;
    const slips = new Set<string>();
    for (const k of words) {
      const s = termScore(t, k, j === terms.length - 1);
      if (s >= STRONG) present = true;
      else if (s > 0 && t.length >= 4 && Math.max(inPdf.get(k) ?? 0, inSource.get(k) ?? 0) <= RARE && typoCost(t, k, LIKELY_SLIP) <= LIKELY_SLIP) slips.add(k);
    }
    return present ? slips : "any";
  });
}

/**
 * Non-overlapping runs of KEYS (folded words) holding every term, each word matched exactly, by prefix, or as
 * RULES allow (default "any") inside a word or with typos, close together and preferably in order; in document
 * order, at least MIN_SCORE.
 */
export function findMatches(keys: readonly string[], terms: readonly string[], rules: readonly TermRule[] = terms.map(() => "any")): Match[] {
  const n = terms.length;
  if (!n) return [];
  const scored = new Map<string, number[]>();
  const hits: { pos: number; score: number; typo: boolean }[][] = terms.map(() => []);
  keys.forEach((key, pos) => {
    let s = scored.get(key);
    if (!s) scored.set(key, (s = terms.map((t, j) => termScore(t, key, j === n - 1))));
    for (let j = 0; j < n; j++) {
      const rule = rules[j];
      if (s[j] >= STRONG || (s[j] > 0 && rule === "any")) hits[j].push({ pos, score: s[j], typo: false });
      else if (s[j] > 0 && rule !== "any" && rule.has(key)) hits[j].push({ pos, score: s[j], typo: true });
    }
  });
  if (hits.some((h) => !h.length)) return [];
  // Every match holds the rarest term: try each of its places, gathering the other terms nearby.
  const anchor = hits.reduce((a, h, j) => (h.length < hits[a].length ? j : a), 0);
  const reach = n + SPAN_SLACK;
  const found: Match[] = [];
  for (const h of hits[anchor]) {
    const placed: number[] = [];
    placed[anchor] = h.pos;
    let total = h.score;
    let typo = h.typo;
    let complete = true;
    for (let j = 0; j < n && complete; j++) {
      if (j === anchor) continue;
      const want = h.pos + j - anchor;
      let best = 0;
      let bestHit: (typeof h) | undefined;
      const list = hits[j];
      for (let k = lowerBound(list, h.pos - reach); k < list.length && list[k].pos <= h.pos + reach; k++) {
        const c = list[k];
        if (placed.includes(c.pos)) continue;
        const v = c.score / (1 + 0.25 * Math.abs(c.pos - want));
        if (v > best) {
          best = v;
          bestHit = c;
        }
      }
      if (!bestHit) complete = false;
      else {
        placed[j] = bestHit.pos;
        total += best;
        typo ||= bestHit.typo;
      }
    }
    if (!complete) continue;
    const ordered = placed.every((p, j) => j === 0 || p > placed[j - 1]);
    found.push({ from: Math.min(...placed), to: Math.max(...placed), score: (total / n) * (ordered ? 1 : 0.85), typo });
  }
  found.sort((a, b) => b.score - a.score || a.from - b.from);
  const covered = new Set<number>();
  const kept: Match[] = [];
  for (const m of found) {
    if (m.score < MIN_SCORE) break;
    let clash = false;
    for (let p = m.from; p <= m.to && !clash; p++) clash = covered.has(p);
    if (clash) continue;
    for (let p = m.from; p <= m.to; p++) covered.add(p);
    kept.push(m);
  }
  return kept.sort((a, b) => a.from - b.from);
}

// ---------------------------------------------------------------- typeset text

interface PdfWord {
  key: string;
  page: number;
  /** Offsets into the page's text. */
  start: number;
  end: number;
  boxes: PdfBox[];
}

/** A PDF's words in reading order, with each page's text for snippets. */
export interface PdfText {
  pages: string[];
  words: PdfWord[];
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function textItem(v: unknown): TextItem | null {
  if (!v || typeof v !== "object" || !("str" in v) || typeof v.str !== "string" || !("transform" in v) || !Array.isArray(v.transform)) return null;
  const t = v.transform.filter((x): x is number => typeof x === "number");
  if (t.length < 6) return null;
  const width = "width" in v && typeof v.width === "number" ? v.width : 0;
  const height = "height" in v && typeof v.height === "number" ? v.height : 0;
  return { str: v.str, transform: t, width, height, hasEOL: "hasEOL" in v && v.hasEOL === true };
}

/**
 * The words of a PDF page from pdf.js text items: a space where items are apart or on another line, words
 * hyphenated at a line end joined, and each character's box: its share of its item's width by WIDTH_OF (pdf.js
 * gives no per-glyph positions; a serif face's relative widths put words much closer than equal shares).
 */
function pageWords(items: unknown[], page: number, left: number, top: number, widthOf: (ch: string) => number): { text: string; words: PdfWord[] } {
  let text = "";
  const glyphs: (PdfBox | null)[] = [];
  let lastY: number | null = null;
  let lastEnd = 0;
  let lastSize = 0;
  let pending: "none" | "space" | "line" = "none";
  for (const raw of items) {
    const it = textItem(raw);
    if (!it) continue;
    const str = it.str.replace(/\u00ad/g, "");
    if (!str) {
      if (it.hasEOL) pending = "line";
      continue;
    }
    const [, , c, d, e, f] = it.transform;
    const size = it.height > 0 ? it.height : Math.hypot(c, d);
    const x = e - left;
    const baseline = top - f;
    if (lastY !== null) {
      if (Math.abs(baseline - lastY) > size * 0.5) pending = "line";
      else if (pending === "none" && x - lastEnd > size * 0.2) pending = "space";
      // A sub- or superscript (smaller type) is a token of its own: log₂ is "log" and "2", x_i is "x" and "i".
      else if (pending === "none" && Math.abs(size - lastSize) > 0.15 * Math.max(size, lastSize)) pending = "space";
    }
    if (pending === "line" && /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(str)) {
      text = text.slice(0, -1); // hyphenated at the line's end: one word
      glyphs.pop();
    } else if (pending !== "none" && text && !text.endsWith(" ")) {
      text += " ";
      glyphs.push(null);
    }
    pending = it.hasEOL ? "line" : "none";
    const shares: number[] = [];
    for (let i = 0; i < str.length; i++) shares.push(widthOf(str[i]));
    const total = shares.reduce((a, b) => a + b, 0);
    let at = x;
    for (let i = 0; i < str.length; i++) {
      const w = total > 0 ? (it.width * shares[i]) / total : it.width / str.length;
      text += str[i];
      glyphs.push({ page, x: at, y: baseline - size * 0.8, width: w, height: size });
      at += w;
    }
    lastY = baseline;
    lastEnd = x + it.width;
    lastSize = size;
  }
  const words: PdfWord[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    const end = start + m[0].length;
    const boxes: PdfBox[] = [];
    for (let i = start; i < end; i++) {
      const g = glyphs[i];
      if (!g) continue;
      const last = boxes.at(-1);
      // Characters on one line make one box; a word hyphenated across lines gets one per line.
      if (last && Math.abs(last.y - g.y) < g.height * 0.5) {
        const right = Math.max(last.x + last.width, g.x + g.width);
        last.x = Math.min(last.x, g.x);
        last.width = right - last.x;
        last.height = Math.max(last.height, g.height);
      } else boxes.push({ ...g });
    }
    if (boxes.length) words.push({ key: tokenKey(m[0]), page, start, end, boxes });
  }
  return { text, words };
}

/** The words of the PDF at PATH. */
export async function readPdfText(path: string): Promise<PdfText> {
  const data = new Uint8Array(await readFile(path));
  const { getDocument } = await loadPdfjs();
  const ctx = (await loadCanvas()).createCanvas(1, 1).getContext("2d");
  ctx.font = "100px serif";
  const widths = new Map<string, number>();
  const widthOf = (ch: string) => {
    let w = widths.get(ch);
    if (w === undefined) widths.set(ch, (w = ctx.measureText(ch).width));
    return w;
  };
  const task = getDocument({ data, verbosity: 0, ...PDF_DATA });
  const pages: string[] = [];
  const words: PdfWord[] = [];
  try {
    const pdf = await task.promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const [left, , , top] = page.view;
      const { items } = await page.getTextContent();
      const w = pageWords(items, p, left, top, widthOf);
      pages.push(w.text);
      words.push(...w.words);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { pages, words };
}

// ---------------------------------------------------------------- LaTeX prose

/**
 * Commands whose arguments are not prose: how many to skip (Infinity: every following argument, also bare
 * control words, as in \newcommand\name[1]{…}). Every other command's arguments are prose: \section{…},
 * \emph{…}, \caption{…}, citation and label keys, and the user's own macros.
 */
const SKIP_ARGS: Record<string, number> = {
  documentclass: 1, usepackage: 1, RequirePackage: 1, PassOptionsToPackage: 2, ProvidesPackage: 1, ProvidesClass: 1,
  input: 1, include: 1, includeonly: 1, includegraphics: 1, includepdf: 1, subfile: 1, graphicspath: 1,
  bibliography: 1, bibliographystyle: 1, addbibresource: 1, bibitem: 1,
  newcommand: Infinity, renewcommand: Infinity, providecommand: Infinity, DeclareRobustCommand: Infinity,
  newenvironment: Infinity, renewenvironment: Infinity, newtheorem: Infinity, def: Infinity, gdef: Infinity, edef: Infinity, xdef: Infinity,
  DeclareMathOperator: 2, newcounter: 1, newlength: 1,
  setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2, stepcounter: 1, refstepcounter: 1,
  hspace: 1, vspace: 1, rule: 2, raisebox: 1, resizebox: 2, scalebox: 1, rotatebox: 1, makebox: 0, parbox: 1,
  color: 1, textcolor: 1, colorbox: 1, fcolorbox: 2, definecolor: 3, colorlet: 2, pagecolor: 1,
  pagestyle: 1, thispagestyle: 1, pagenumbering: 1, geometry: 1, hypersetup: 1, setmainfont: 1, setsansfont: 1, setmonofont: 1,
  fontsize: 2, usetikzlibrary: 1, tikzset: 1, pgfplotsset: 1, captionsetup: 1, setlist: 1, setbeamertemplate: 2, usetheme: 1,
  href: 1, multicolumn: 2, multirow: 2, cline: 1, cmidrule: 1, definechangesauthor: 1,
  // Cross-reference keys: the PDF prints numbers for them. Citation keys stay searchable.
  label: 1, ref: 1, eqref: 1, pageref: 1, autoref: 1, cref: 1, Cref: 1, nameref: 1, vref: 1, crefrange: 2,
};

/** Arguments of `\begin{env}` that are not prose (column specs, widths). */
const ENV_ARGS: Record<string, number> = {
  tabular: 1, "tabular*": 2, tabularx: 2, tabulary: 2, longtable: 1, array: 1, minipage: 1, multicols: 1,
  wrapfigure: 2, wraptable: 2, subfigure: 1, thebibliography: 1,
};

/** Math environments: their content is read as math (math commands, letters, numbers, `\text` words). */
const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*", "flalign", "flalign*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math",
]);

/** Environments with no prose: drawings, code. */
const SKIP_ENVS = new Set([
  "tikzpicture", "pgfpicture", "forest", "axis", "verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*",
]);

/** Math commands whose argument is words or letters: `\text{for all}`, `\mathrm{energy}`, `\mathbb{R}`. */
const MATH_TEXT = new Set([
  "text", "textrm", "textit", "textbf", "textsf", "texttt", "textnormal", "mbox", "intertext", "shortintertext", "emph",
  "mathrm", "mathit", "mathbf", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak", "mathscr", "mathnormal",
  "operatorname", "boldsymbol", "bm",
]);
/** Math commands with arguments that are not math: how many to skip. */
const MATH_SKIP: Record<string, number> = {
  label: 1, tag: 1, ref: 1, eqref: 1, cref: 1, Cref: 1, hspace: 1, vspace: 1, phantom: 1, hphantom: 1, vphantom: 1,
  color: 1, textcolor: 1, colorbox: 1, end: 1,
};
/** Math commands that only size, space or style what follows. */
const MATH_QUIET = new Set([
  "left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl",
  "Biggr", "bigm", "Bigm", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits",
  "nonumber", "notag", "quad", "qquad", "enspace", "thinspace", "mathstrut", "strut", "allowbreak", "nobreak", "relax",
]);

/** Control words that are letters: \i → i, \ss → ss. */
const LETTER_WORDS: Record<string, string> = { i: "i", j: "j", ss: "ss", ae: "ae", AE: "AE", oe: "oe", OE: "OE", o: "o", O: "O", l: "l", L: "L", aa: "a", AA: "A" };
/** Accents spelled as letters (\v{c}, \c c): they add nothing to the letter. */
const ACCENT_WORDS = new Set(["v", "u", "H", "c", "k", "r", "d", "b", "t"]);

/** End of the group opening at OPEN (`{` or `[`), past its closer; the text's end if unclosed. */
function groupEnd(src: string, open: number): number {
  const [o, c] = src[open] === "[" ? ["[", "]"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i + 1;
  }
  return src.length;
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i++;
  return i;
}

/** Past COUNT brace arguments at I and the optional ones among and before them (Infinity: all, bare control words too). */
function skipArgs(src: string, i: number, count: number): number {
  let left = count;
  for (;;) {
    const j = skipSpaces(src, i);
    if (src[j] === "[") i = groupEnd(src, j);
    else if (left > 0 && src[j] === "{") {
      i = groupEnd(src, j);
      left--;
    } else if (count === Infinity && src[j] === "\\") {
      const m = /^\\(?:[A-Za-z@]+|.)/.exec(src.slice(j, j + 64));
      i = j + (m ? m[0].length : 1);
    } else if (count === Infinity && src[j] === "#") i = j + 2;
    else return i;
    // A definition's arguments end at a paragraph break at the latest.
    if (count === Infinity && /\n[ \t\r]*\n/.test(src.slice(i, skipSpaces(src, i)))) return i;
  }
}

/** Math opened at I by OPENER: where its content ends (before the closer) and where the closer ends. */
function mathEnd(src: string, i: number, opener: string): { inner: number; end: number } {
  const closer = opener === "$$" ? "$$" : opener === "$" ? "$" : opener === "\\(" ? "\\)" : "\\]";
  for (let k = i + opener.length; k < src.length; k++) {
    if (src.startsWith(closer, k)) return { inner: k, end: k + closer.length };
    if (src[k] === "\\") k++;
  }
  return { inner: src.length, end: src.length };
}

/**
 * The prose of a LaTeX source: what search matches there. Preamble, comments, verbatim and code, and the
 * arguments of package, file, length, colour and definition commands are left out; command names are word
 * breaks, braces and accents are not (`\textbf{fo}o` is "foo", `caf\'e` is "cafe"). Math is kept as math
 * commands (`\sum`), single letters, numbers and `\text`/`\mathrm` words, without labels and sizing. `at[k]`
 * is the source offset of the prose's character k.
 */
export function proseOf(source: string): { text: string; at: number[] } {
  const src = maskSource(source);
  let text = "";
  const at: number[] = [];
  const push = (s: string, i: number) => {
    text += s;
    for (let k = 0; k < s.length; k++) at.push(i);
  };
  const space = (i: number) => {
    if (text && !text.endsWith(" ")) push(" ", i);
  };
  /** Math from FROM to TO: each command, letter, number and symbol a token of its own. */
  const math = (from: number, to: number) => {
    space(from);
    let k = from;
    while (k < to) {
      const c = src[k];
      if (c === "\\") {
        const name = /^\\([A-Za-z]+|.?)/.exec(src.slice(k, k + 40))?.[1] ?? "";
        const after = k + 1 + name.length;
        space(k);
        if (!/^[A-Za-z]/.test(name) || MATH_QUIET.has(name)) k = after;
        else if (MATH_TEXT.has(name)) {
          const open = skipSpaces(src, after);
          if (src[open] !== "{") k = after;
          else {
            // The argument's words, as written: `\mathrm{energy}` is the word energy.
            const close = groupEnd(src, open);
            for (let w = open + 1; w < close - 1; w++) {
              if (/[\p{L}\p{N}]/u.test(src[w])) push(src[w], w);
              else if (/\s/.test(src[w])) space(w);
            }
            space(close);
            k = close;
          }
        } else if (name === "begin") {
          // Inner environments (aligned, cases, pmatrix, array{cc}) add nothing but their column spec.
          const env = /^\{([^}]*)\}/.exec(src.slice(after, after + 64));
          k = skipArgs(src, after + (env ? env[0].length : 0), ENV_ARGS[env?.[1] ?? ""] ?? 0);
        } else if (Object.hasOwn(MATH_SKIP, name)) k = skipArgs(src, after, MATH_SKIP[name]);
        else {
          push(`\\${name}`, k);
          space(after);
          k = after;
        }
      } else if (/\p{N}/u.test(c)) {
        // A number is one token: 10, 0.5.
        let e = k + 1;
        while (e < to && /[\p{N}.]/u.test(src[e])) e++;
        space(k);
        push(src.slice(k, e), k);
        space(e);
        k = e;
      } else if (/\p{L}/u.test(c) || Object.hasOwn(MATH_SYMBOLS, c)) {
        // Letters are separate variables: xy is x times y.
        space(k);
        push(c, k);
        space(k + 1);
        k++;
      } else {
        if (c !== "{" && c !== "}") space(k);
        k++;
      }
    }
    space(to);
  };
  const body = src.indexOf("\\begin{document}");
  let i = body >= 0 ? body + "\\begin{document}".length : 0;
  const stop = src.indexOf("\\end{document}", i);
  const end = stop >= 0 ? stop : src.length;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      const name = /^\\([A-Za-z@]+\*?|.?)/.exec(src.slice(i, i + 64))?.[1] ?? "";
      const after = i + 1 + name.length;
      if (name === "(" || name === "[") {
        const m = mathEnd(src, i, `\\${name}`);
        math(i + 2, m.inner);
        i = m.end;
        continue;
      }
      if (!/^[A-Za-z@]/.test(name)) {
        // Control symbols: \& \% \_ … are their character, accents (\' \" \^ …) add nothing, the rest break words.
        if (/^[&%$#_{}]$/.test(name)) push(name, i + 1);
        else if (!/^['`^"~=.]$/.test(name)) space(i);
        i = after;
        if (name === "\\") {
          // A line break's star and spacing: \\*[2pt]
          if (src[i] === "*") i++;
          const j = skipSpaces(src, i);
          if (src[j] === "[") i = groupEnd(src, j);
        }
        continue;
      }
      const bare = name.replace(/\*$/, "");
      if (bare === "begin" || bare === "end") {
        const env = /^\{([^}]*)\}/.exec(src.slice(after, after + 64));
        const envName = env?.[1] ?? "";
        let next = after + (env ? env[0].length : 0);
        space(i);
        if (bare === "begin" && (SKIP_ENVS.has(envName) || MATH_ENVS.has(envName))) {
          const close = src.indexOf(`\\end{${envName}}`, next);
          const inner = close < 0 ? end : close;
          if (MATH_ENVS.has(envName)) math(next, inner);
          next = close < 0 ? end : close + `\\end{${envName}}`.length;
        } else if (bare === "begin") next = skipArgs(src, next, ENV_ARGS[envName] ?? 0);
        i = next;
        continue;
      }
      if (Object.hasOwn(LETTER_WORDS, bare) || ACCENT_WORDS.has(bare)) {
        if (Object.hasOwn(LETTER_WORDS, bare)) push(LETTER_WORDS[bare], i);
        i = skipSpaces(src, after); // TeX drops the spaces after a control word
        continue;
      }
      space(i);
      if (bare === "iffalse") {
        // Commented out the TeX way: up to the matching \fi.
        const fi = /\\fi(?![A-Za-z@])/g;
        fi.lastIndex = after;
        i = fi.exec(src) ? fi.lastIndex : end;
        continue;
      }
      if (bare === "let") {
        i = skipArgs(src, after, Infinity);
        const eq = skipSpaces(src, i);
        if (src[eq] === "=") i = skipArgs(src, eq + 1, Infinity);
        continue;
      }
      if (Object.hasOwn(SKIP_ARGS, bare)) i = skipArgs(src, after, SKIP_ARGS[bare]);
      else if (bare === "item") i = after;
      else {
        // Optional arguments of other commands are short forms, notes or options: not searched.
        let j = skipSpaces(src, after);
        if (src[j] !== "[") i = after;
        else {
          while (src[j] === "[") j = skipSpaces(src, groupEnd(src, j));
          i = j;
        }
      }
      continue;
    }
    if (c === "$") {
      const opener = src[i + 1] === "$" ? "$$" : "$";
      const m = mathEnd(src, i, opener);
      math(i + opener.length, m.inner);
      i = m.end;
      continue;
    }
    if (c === "}") {
      // Consecutive arguments ({2020}{Engineer}) are separate words.
      const j = skipSpaces(src, i + 1);
      if (src[j] === "{" || src[j] === "[") space(i);
      i++;
      continue;
    }
    if (c === "{") {
      i++;
      continue;
    }
    if (c === "~" || c === "&" || /\s/.test(c)) space(i);
    else push(c, i);
    i++;
  }
  return { text, at };
}

interface SourceWord {
  key: string;
  /** Offsets into the prose. */
  start: number;
  end: number;
  /** 1-based source line of the first character. */
  line: number;
}

interface SourceText {
  /** Project-relative. */
  file: string;
  prose: string;
  words: SourceWord[];
}

function sourceText(file: string, source: string): SourceText {
  const { text, at } = proseOf(source);
  const lineStarts = [0];
  for (let k = source.indexOf("\n"); k >= 0; k = source.indexOf("\n", k + 1)) lineStarts.push(k + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const words = [...text.matchAll(TOKEN)].map((m) => ({ key: tokenKey(m[0]), start: m.index, end: m.index + m[0].length, line: lineOf(at[m.index]) }));
  return { file, prose: text, words };
}

// ---------------------------------------------------------------- search

/** Up to CONTEXT characters of TEXT before START and after END, cut at a word boundary, one line. */
function snippet(text: string, start: number, end: number): { before: string; match: string; after: string } {
  // A space before punctuation is where the source had a \ref or \label: the PDF's number isn't in the prose.
  const flat = (s: string) => s.replace(/\s+/g, " ").replace(/ ([,.;:!?)])/g, "$1");
  let before = flat(text.slice(Math.max(0, start - CONTEXT), start));
  if (start > CONTEXT) before = `…${before.replace(/^\S*\s/, "")}`;
  let after = flat(text.slice(end, end + CONTEXT));
  if (end + CONTEXT < text.length) after = `${after.replace(/\s\S*$/, "")}…`;
  return { before: before.trimStart(), match: flat(text.slice(start, end)), after: after.trimEnd() };
}

/** First box's top, for ordering hits on a page. */
function topOf(h: SearchHit): number {
  return h.rects?.[0]?.y ?? h.box?.y ?? 0;
}

/** Search indexes of a project, rebuilt for files that changed. */
export class SearchIndex {
  private readonly pdfs = new Map<string, { stamp: string; text: Promise<PdfText> }>();
  private readonly sources = new Map<string, { stamp: number; text: SourceText }>();
  private readonly realDir: string;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.realDir = realpathSync(cfg.dir);
  }

  private pdfText(doc: DocConfig): Promise<PdfText> | null {
    const pdf = docPaths(this.cfg, doc).pdf;
    if (!existsSync(pdf)) return null;
    const st = statSync(pdf);
    const stamp = `${st.mtimeMs}:${st.size}`;
    let entry = this.pdfs.get(doc.name);
    if (entry?.stamp !== stamp) {
      entry = { stamp, text: readPdfText(pdf) };
      this.pdfs.set(doc.name, entry);
      entry.text.catch(() => this.pdfs.delete(doc.name)); // a PDF being replaced: read it again next time
    }
    return entry.text;
  }

  private sourceTexts(doc: DocConfig): SourceText[] {
    const out: SourceText[] = [];
    for (const file of docTexFiles(this.cfg, doc)) {
      const abs = join(this.cfg.dir, file);
      if (!existsSync(abs)) continue;
      const stamp = statSync(abs).mtimeMs;
      let entry = this.sources.get(abs);
      if (entry?.stamp !== stamp) this.sources.set(abs, (entry = { stamp, text: sourceText(file, readFileSync(abs, "utf8")) }));
      out.push(entry.text);
    }
    return out;
  }

  /** SyncTeX's absolute path as a project-relative one (it may name files by their resolved path). */
  private rel(abs: string): string {
    return posix(relative(abs.startsWith(this.realDir + sep) ? this.realDir : this.cfg.dir, abs));
  }

  /** Places in DOC matching QUERY, in reading order; SYNCTEX (the last build's) ties source and PDF together. */
  async search(doc: DocConfig, query: string, synctex: SyncTex | null): Promise<SearchResult> {
    const terms = queryTerms(query);
    if (!terms.length) return { query, hits: [], truncated: false };
    const pdf = await this.pdfText(doc);
    const pdfKeys = pdf?.words.map((w) => w.key) ?? [];
    const sources = this.sourceTexts(doc).map((src) => ({ src, keys: src.words.map((w) => w.key) }));
    // Typos, judged over the PDF and the sources together: any for query words the document lacks, else only
    // likely misspellings in the document.
    const rules = termRules(pdfKeys, sources.map((s) => s.keys), terms);

    const pdfHits: Hit[] = [];
    if (pdf) {
      const keys = pdfKeys;
      for (const m of findMatches(keys, terms, rules)) {
        const first = pdf.words[m.from];
        const last = pdf.words[m.to];
        const rects = pdf.words.slice(m.from, m.to + 1).flatMap((w) => w.boxes);
        const text = pdf.pages[first.page - 1];
        const s = snippet(text, first.start, last.page === first.page ? last.end : text.length);
        const at = rects[0];
        const loc = synctex?.reverse(at.page, at.x + at.width / 2, at.y + at.height / 2);
        pdfHits.push({
          in: "pdf",
          score: m.score,
          ...(m.typo ? { typo: true as const } : {}),
          page: first.page,
          rects,
          source: loc ? { file: this.rel(loc.file), line: loc.line } : undefined,
          ...s,
          keys: keys.slice(m.from, m.to + 1).join(" "),
        });
      }
    }

    const sourceHits: Hit[] = [];
    for (const { src, keys } of sources) {
      for (const m of findMatches(keys, terms, rules)) {
        const first = src.words[m.from];
        const matched = keys.slice(m.from, m.to + 1).join(" ");
        const box = synctex?.forward(join(this.cfg.dir, src.file), first.line) ?? null;
        // Without SyncTeX a source match can't be placed: words the PDF shows are left to its match.
        if (!box && pdfHits.some((h) => h.keys === matched)) continue;
        sourceHits.push({
          in: "source",
          score: m.score,
          ...(m.typo ? { typo: true as const } : {}),
          page: box?.page,
          box: box ?? undefined,
          source: { file: src.file, line: first.line },
          ...snippet(src.prose, first.start, src.words[m.to].end),
          keys: matched,
        });
      }
    }

    // A source match and the PDF match of the same words at the same place are one hit. Closest pairs first,
    // so source text that is not typeset (a draft in a macro that drops it) doesn't take the PDF match.
    const byPlace = new Map<string, Hit[]>();
    for (const p of pdfHits) {
      const at = `${p.page}\n${p.keys}`;
      const list = byPlace.get(at);
      if (list) list.push(p);
      else byPlace.set(at, [p]);
    }
    const pairs: { s: Hit; p: Hit; d: number }[] = [];
    for (const s of sourceHits) {
      if (!s.box) continue;
      for (const page of [s.box.page, s.box.page + 1]) {
        for (const p of byPlace.get(`${page}\n${s.keys}`) ?? []) {
          const d = pairDistance(s, p);
          if (d !== null) pairs.push({ s, p, d });
        }
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const paired = new Set<Hit>();
    for (const { s, p } of pairs) {
      if (paired.has(s) || paired.has(p)) continue;
      paired.add(s).add(p);
      p.in = "both";
      p.source = s.source;
      p.score = Math.max(p.score, s.score);
    }
    const hits = [...pdfHits, ...sourceHits.filter((s) => !paired.has(s))];

    const best = Math.max(0, ...hits.map((h) => h.score));
    const kept = hits
      // A possible typo in the document always shows: it is what an exact match can't find.
      .filter((h) => h.typo || h.score >= Math.max(MIN_SCORE, best - SCORE_BAND))
      .sort((a, b) => {
        if (a.page !== undefined && b.page !== undefined) return a.page - b.page || topOf(a) - topOf(b) || (a.rects?.[0]?.x ?? 0) - (b.rects?.[0]?.x ?? 0);
        if (a.page !== undefined || b.page !== undefined) return a.page === undefined ? 1 : -1;
        return (a.source?.file ?? "").localeCompare(b.source?.file ?? "") || (a.source?.line ?? 0) - (b.source?.line ?? 0);
      })
      .map(({ keys: _, ...h }) => ({ ...h, score: Math.round(h.score * 100) / 100 }));
    return { query, hits: kept.slice(0, MAX_HITS), truncated: kept.length > MAX_HITS };
  }
}

type Hit = SearchHit & { keys: string };

/** Points of slack around SyncTeX's box when looking for the PDF match of a source match. */
const NEAR = 24;

/**
 * How far apart source match S and PDF match P are, or null when they aren't the same place: the same words,
 * and P is the text SyncTeX traces to S's line, else on S's box (with slack) or the next page (a paragraph split
 * across pages).
 */
function pairDistance(s: Hit, p: Hit): number | null {
  const box = s.box;
  const r = p.rects?.[0];
  if (!box || !r || s.keys !== p.keys) return null;
  if (p.source && p.source.file === s.source?.file && p.source.line === s.source.line) return 0;
  if (p.page === box.page && r.y + r.height >= box.y - NEAR && r.y <= box.y + box.height + NEAR) return 1 + Math.abs(r.y - box.y);
  if (p.page === box.page + 1) return 1000 + r.y;
  return null;
}

