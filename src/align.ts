import { maskSource } from "./outline.ts";

/**
 * Lines up text selected in the PDF with the LaTeX source, word by word, through macros. The source becomes a
 * list of words and of stand-ins for what the PDF shows in place of a command (a citation's "[12]", \autoref's
 * "Table 2", \LaTeX, math): a stand-in takes up a few PDF words, or none. The user's own text macros
 * (\newcommand{\tool}{\textsc{Gallifrey}}) are read as the words they typeset. A selection that begins or ends in
 * a macro's output then covers the whole command.
 */

/** A source word (folded) or, with `word` null, a command or math whose PDF text is unknown. */
export interface Token {
  word: string | null;
  /** At most how many PDF words a stand-in takes up. */
  max: number;
  /** Its source offsets: the whole command for a stand-in or a macro's words. */
  start: number;
  end: number;
}

/** Words as compared: compatibility forms split, accents and case dropped. */
export function foldWord(w: string): string {
  return w.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of PDF text, folded. */
export function pdfWords(s: string): string[] {
  return (s.normalize("NFKC").replace(/\u00ad/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).map(foldWord);
}

/** Commands whose output isn't their argument's text: a citation, a cross-reference, a URL, a unit. */
const STAND_IN = /^(?:[A-Za-z]*[cC]ite[a-zA-Z]*|[cC]?ref|autoref|eqref|pageref|nameref|vref|[cC]pageref|labelcref|url|nolinkurl|SI|si|num|qty|ang|unit|footnotemark|gls[a-zA-Z]*|ac[a-zA-Z]*)$/;
/** Commands whose arguments typeset nothing: how many to pass over. */
const SILENT_ARGS: Record<string, number> = {
  label: 1, input: 1, include: 1, includegraphics: 1, vspace: 1, "vspace*": 1, hspace: 1, "hspace*": 1, phantom: 1,
  color: 1, pagestyle: 1, thispagestyle: 1, setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2,
  bibliography: 1, bibliographystyle: 1, usepackage: 1, documentclass: 1, begin: 1, end: 1,
  textcolor: 1, href: 1, definechangesauthor: 1, hypersetup: 1, geometry: 1,
};
/** Bare commands that typeset nothing. */
const SILENT = new Set([
  "centering", "noindent", "indent", "par", "item", "small", "footnotesize", "scriptsize", "tiny", "large", "Large",
  "LARGE", "huge", "Huge", "normalsize", "bfseries", "itshape", "ttfamily", "sffamily", "rmfamily", "scshape",
  "upshape", "mdseries", "em", "bf", "it", "tt", "sc", "rm", "sf", "hline", "toprule", "midrule", "bottomrule",
  "newline", "linebreak", "pagebreak", "newpage", "clearpage", "cleardoublepage", "smallskip", "medskip", "bigskip",
  "vfill", "hfill", "quad", "qquad", "protect", "relax", "xspace", "maketitle", "tableofcontents", "appendix",
  "nobreak", "allowbreak", "sloppy", "raggedright", "raggedleft", "frenchspacing", "null", "leavevmode", "unskip",
]);
/** Accents spelled as letters, and letters spelled as commands. */
const ACCENTS = new Set(["v", "u", "H", "c", "k", "r", "d", "b", "t"]);
const LETTERS: Record<string, string> = { i: "i", j: "j", ss: "ss", ae: "ae", AE: "ae", oe: "oe", OE: "oe", o: "o", O: "o", l: "l", L: "l", aa: "a", AA: "a" };
/** Math environments: a stand-in for all of the display. */
const MATH_ENVS = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math)\*?$/;

/** End of the group at OPEN (`{` or `[`), past its closer. */
function groupEnd(src: string, open: number): number {
  const [o, c] = src[open] === "[" ? ["[", "]"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i + 1;
  }
  return src.length;
}

function skipSpaces(src: string, i: number): number {
  while (i < src.length && /[ \t\r\n]/.test(src[i]) && !/\n[ \t\r]*\n/.test(src.slice(i, i + 3))) i++;
  return i;
}

/** Past COUNT brace arguments at I, and the optional `[…]` ones among them. */
function skipArgs(src: string, i: number, count: number): number {
  let left = count;
  for (;;) {
    const j = skipSpaces(src, i);
    if (src[j] === "[") i = groupEnd(src, j);
    else if (left > 0 && src[j] === "{") {
      i = groupEnd(src, j);
      left--;
    } else return i;
  }
}

/** Definitions: the command, how many bodies it has. */
const DEFINITIONS: Record<string, number> = {
  newcommand: 1, renewcommand: 1, providecommand: 1, DeclareRobustCommand: 1, DeclareMathOperator: 1,
  newenvironment: 2, renewenvironment: 2, def: 1, gdef: 1, edef: 1, xdef: 1,
};

/** Past a definition at I (after its command): the name (`{\x}` or `\x`), parameters (`[1][x]`, `#1#2`), BODIES bodies. */
function skipDefinition(src: string, i: number, bodies: number): number {
  let j = skipSpaces(src, i);
  if (src[j] === "{") j = groupEnd(src, j);
  else if (src[j] === "\\") j += /^\\(?:[A-Za-z@]+|.)/.exec(src.slice(j, j + 64))?.[0].length ?? 1;
  // Parameters, up to the first body.
  while (j < src.length && src[j] !== "{" && !/\n[ \t\r]*\n/.test(src.slice(j, j + 3))) j = src[j] === "[" ? groupEnd(src, j) : j + 1;
  return skipArgs(src, j, bodies);
}

/** Zero-argument macros defined in TEXTS, as the words they typeset: \newcommand{\tool}{\textsc{Gallifrey}\xspace}. */
export function userMacros(texts: string[]): Map<string, string[]> {
  const bodies = new Map<string, string>();
  const def = /\\(?:(?:re|provide)?newcommand|DeclareRobustCommand)\*?\s*\{?\\([A-Za-z@]+)\}?\s*(\[0\])?\s*(?=\{)|\\def\\([A-Za-z@]+)\s*(?=\{)/g;
  for (const text of texts) {
    const src = maskSource(text);
    for (const m of src.matchAll(def)) {
      const at = m.index + m[0].length;
      const body = src.slice(at + 1, groupEnd(src, at) - 1);
      if (!body.includes("#")) bodies.set(m[1] ?? m[3], body);
    }
  }
  const words = new Map<string, string[]>();
  const expanding = new Set<string>();
  const wordsOf = (name: string): string[] => {
    const known = words.get(name);
    if (known) return known;
    if (expanding.has(name)) return []; // a definition that uses itself
    expanding.add(name);
    const body = bodies.get(name) ?? "";
    const out = tokenize(body, { get: (n: string) => (bodies.has(n) ? wordsOf(n) : undefined) })
      .flatMap((t) => (t.word === null ? [] : [t.word]));
    expanding.delete(name);
    words.set(name, out);
    return out;
  };
  for (const name of bodies.keys()) wordsOf(name);
  return words;
}

/** Source tokens of SRC; MACROS gives the words of the user's text macros. */
export function tokenize(src: string, macros: { get(name: string): string[] | undefined }): Token[] {
  const s = maskSource(src);
  const tokens: Token[] = [];
  let word = "";
  let wordStart = -1;
  let wordEnd = -1;
  const flush = () => {
    if (word) tokens.push({ word: foldWord(word), max: 0, start: wordStart, end: wordEnd });
    word = "";
  };
  const letter = (c: string, at: number, end = at + 1) => {
    if (!word) wordStart = at;
    word += c;
    wordEnd = end;
  };
  const standIn = (start: number, end: number, max: number) => {
    flush();
    tokens.push({ word: null, max, start, end });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const name = /^\\([A-Za-z@]+\*?|.?)/.exec(s.slice(i, i + 64))?.[1] ?? "";
      const after = i + 1 + name.length;
      if (name === "(" || name === "[") {
        const close = s.indexOf(name === "(" ? "\\)" : "\\]", after);
        const end = close < 0 ? s.length : close + 2;
        standIn(i, end, 40);
        i = end;
        continue;
      }
      if (!/^[A-Za-z@]/.test(name)) {
        // \& \% \_ and \, \\ break words; accents (\' \" \^ …) don't.
        if (!/^['`^"~=.]$/.test(name)) flush();
        i = after;
        continue;
      }
      const bare = name.replace(/\*$/, "");
      if (Object.hasOwn(LETTERS, bare)) {
        letter(LETTERS[bare], i, after);
        i = skipSpaces(s, after);
        continue;
      }
      if (ACCENTS.has(bare)) {
        i = skipSpaces(s, after);
        continue;
      }
      if (bare === "begin") {
        const env = /^\{([^}]*)\}/.exec(s.slice(after, after + 64))?.[1] ?? "";
        if (MATH_ENVS.test(env)) {
          const close = s.indexOf(`\\end{${env}}`, after);
          const end = close < 0 ? s.length : close + `\\end{${env}}`.length;
          standIn(i, end, 80);
          i = end;
          continue;
        }
      }
      const expansion = macros.get(bare);
      if (expansion) {
        // The macro's words, each spanning the whole command (and a following {}), so marks wrap all of it.
        flush();
        let end = after;
        if (s.startsWith("{}", end)) end += 2;
        for (const w of expansion) tokens.push({ word: w, max: 0, start: i, end });
        i = end;
        continue;
      }
      if (STAND_IN.test(bare)) {
        const end = skipArgs(s, after, /^(?:SI|qty|SIrange)$/.test(bare) ? 2 : 1);
        standIn(i, end, 4);
        i = end;
        continue;
      }
      flush();
      if (Object.hasOwn(DEFINITIONS, bare)) {
        i = skipDefinition(s, after, DEFINITIONS[bare]);
        continue;
      }
      if (Object.hasOwn(SILENT_ARGS, bare)) {
        i = skipArgs(s, after, SILENT_ARGS[bare]);
        continue;
      }
      const next = skipSpaces(s, after);
      // A numbered heading or caption: the PDF shows its number ("2.2", "Table 1.") before the text.
      if (/^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|caption)$/.test(name)) standIn(i, after, 3);
      if (s[next] === "{" || s[next] === "[" || SILENT.has(bare)) {
        // Formatting and sectioning (\emph{…}, \section{…}, a macro with arguments): its arguments are the text.
        i = s[next] === "[" ? skipArgs(s, after, 0) : after;
        continue;
      }
      // A bare command that may typeset something (\LaTeX, \etal): up to three words, or none.
      standIn(i, after, 3);
      i = after;
      continue;
    }
    if (c === "$") {
      const opener = s[i + 1] === "$" ? "$$" : "$";
      let k = i + opener.length;
      while (k < s.length && !s.startsWith(opener, k)) k += s[k] === "\\" ? 2 : 1;
      const end = Math.min(s.length, k + opener.length);
      standIn(i, end, opener === "$$" ? 40 : 8);
      i = end;
      continue;
    }
    if (c === "{" || c === "}") {
      i++;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(c)) letter(c, i);
    else flush();
    i++;
  }
  flush();
  return tokens;
}

/** A selection lined up with the source: its first and last token, and how many PDF words stand-ins took. */
export interface Alignment {
  first: number;
  last: number;
  /** Selection words matched by stand-ins rather than source words: fewer is a better match. */
  loose: number;
}

/** Every way WORDS (folded PDF words) line up with a run of TOKENS. */
export function align(words: string[], tokens: Token[]): Alignment[] {
  const n = words.length;
  if (!n) return [];
  const found: Alignment[] = [];
  const [w0, w1] = words;
  // A selection starts at a word (or the end of one, or a word the PDF hyphenated), or inside a stand-in's output.
  const startsAt = (t: Token) =>
    t.word === null ? t.max > 0 : t.word === w0 || (w0.length >= 2 && t.word.endsWith(w0)) || (w1 !== undefined && t.word === w0 + w1) || (n === 1 && w0.length >= 2 && t.word.startsWith(w0));
  for (let first = 0; first < tokens.length; first++) {
    const t = tokens[first];
    if (!startsAt(t)) continue;
    const memo = new Map<number, { last: number; loose: number } | null>();
    const go = (wi: number, ti: number): { last: number; loose: number } | null => {
      if (wi === n) return { last: ti - 1, loose: 0 };
      if (ti >= tokens.length) return null;
      const key = wi * tokens.length + ti;
      if (memo.has(key)) return memo.get(key) ?? null;
      const tok = tokens[ti];
      let best: { last: number; loose: number } | null = null;
      const consider = (r: { last: number; loose: number } | null, loose: number) => {
        if (r && (!best || r.loose + loose < best.loose)) best = { last: r.last, loose: r.loose + loose };
      };
      if (tok.word !== null) {
        const w = words[wi];
        if (tok.word === w) consider(go(wi + 1, ti + 1), 0);
        // A word the PDF hyphenated at a line end: two selection words, one source word.
        if (wi + 1 < n && tok.word === w + words[wi + 1]) consider(go(wi + 2, ti + 1), 0);
        // A drag from the middle of a word: the selection's first word ends a source word, its last starts one.
        if (w.length >= 2 && tok.word !== w) {
          if (wi === 0 && tok.word.endsWith(w)) consider(go(1, ti + 1), 0.5);
          if (wi === n - 1 && tok.word.startsWith(w)) consider({ last: ti, loose: 0 }, 0.5);
        }
      } else {
        for (let take = Math.min(tok.max, n - wi); take >= 0; take--) {
          // The selection may end inside what the stand-in typesets.
          consider(wi + take === n && take > 0 ? { last: ti, loose: 0 } : go(wi + take, ti + 1), take);
        }
      }
      memo.set(key, best);
      return best;
    };
    let r: { last: number; loose: number } | null = null;
    if (t.word !== null) r = go(0, first);
    else {
      for (let take = Math.min(t.max, n); take >= 1; take--) {
        const rest = take === n ? { last: first, loose: 0 } : go(take, first + 1);
        if (rest && (!r || rest.loose + take < r.loose)) r = { last: rest.last, loose: rest.loose + take };
      }
    }
    if (r && r.last >= first) found.push({ first, last: r.last, loose: r.loose });
  }
  return found;
}
