import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Config, type DocConfig, docPaths, posix } from "./config.ts";
import { parseDeps } from "./engine.ts";
import { NON_PROSE } from "./proofread.ts";
import { citeUses, definedKeys, skipGroup } from "./zotero.ts";

/**
 * A document's structure as the source spells it: sectioning commands, floats and labelled display math in
 * reading order (following \input/\include/\subfile/\import), numbered from the last build's .aux, plus the
 * cross-reference problems a reader would hit (undefined refs, unused or duplicate labels, missing citations).
 */

export type SectionKind = "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph";
export type OutlineKind = SectionKind | "figure" | "table" | "equation";

export interface OutlineItem {
  kind: OutlineKind;
  /** Depth: sectioning relative to the document's top sectioning level (1-based); floats/equations one below their section. */
  level: number;
  /** Plain text: section title, caption, or the equation's source. */
  title: string;
  /** From the last build's .aux; absent when unknown or unnumbered. */
  number?: string;
  /** Project-relative, `/`-separated. */
  file: string;
  line: number;
  label?: string;
}

export type ProblemKind = "undefined-ref" | "unused-label" | "duplicate-label" | "missing-citation";

export interface OutlineProblem {
  kind: ProblemKind;
  key: string;
  file: string;
  line: number;
}

export interface Outline {
  doc: string;
  items: OutlineItem[];
  problems: OutlineProblem[];
}

const SECTION_KINDS: SectionKind[] = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph"];
const FLOAT_KIND: Record<string, "figure" | "table"> = {
  figure: "figure", "figure*": "figure", wrapfigure: "figure", sidewaysfigure: "figure",
  table: "table", "table*": "table", wraptable: "table", sidewaystable: "table",
};
/** Numbered display-math environments; each \label inside one is an equation item. */
const EQUATION_ENV: Record<string, true> = { equation: true, align: true, gather: true, multline: true, flalign: true, alignat: true, eqnarray: true };
const VERBATIM_ENV: Record<string, true> = { verbatim: true, "verbatim*": true, Verbatim: true, BVerbatim: true, LVerbatim: true, lstlisting: true, minted: true, comment: true };
const REF_CMD: Record<string, true> = {
  ref: true, cref: true, Cref: true, autoref: true, Autoref: true, eqref: true, pageref: true, nameref: true, Nameref: true,
  vref: true, Vref: true, labelcref: true, cpageref: true, Cpageref: true, subref: true,
};
/** Two-label range references: \crefrange{a}{b}. */
const RANGE_CMD: Record<string, true> = { crefrange: true, Crefrange: true, cpagerefrange: true, Cpagerefrange: true };
const INPUT_CMD: Record<string, true> = { input: true, include: true, subfile: true };
/** \import{dir}{file} resolves against the project, \subimport against the including file. */
const IMPORT_CMD: Record<string, true> = { import: true, subimport: true, inputfrom: true, subinputfrom: true, includefrom: true, subincludefrom: true };
/** Commands dropped with their arguments from titles, on top of proofreading's non-prose commands. */
const TITLE_DROP: Record<string, true> = { footnote: true, footnotemark: true, thanks: true, index: true, protect: true, relax: true, ignorespaces: true };
/** Commands that print text. */
const TITLE_LITERAL: Record<string, string> = {
  LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX2e", XeTeX: "XeTeX", XeLaTeX: "XeLaTeX", BibTeX: "BibTeX", LuaTeX: "LuaTeX",
  textbackslash: "\\", ldots: "…", dots: "…", textendash: "–", textemdash: "—", textquoteright: "’", textquoteleft: "‘",
  "&": "&", "%": "%", _: "_", "#": "#", $: "$", "{": "{", "}": "}", "\\": " ", " ": " ", ",": " ", ";": " ", "@": "",
};

/** Plain text of a title or caption: commands removed (prose arguments kept), non-prose arguments, braces and math delimiters dropped. */
export function plainTitle(tex: string): string {
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const c = tex[i];
    if (c === "\\") {
      const m = /^\\([A-Za-z@]+|.)\*?/s.exec(tex.slice(i));
      const name = m ? m[1] : "";
      i += m ? m[0].length : 1;
      const literal = TITLE_LITERAL[name];
      if (literal !== undefined) out += literal;
      else if (NON_PROSE.has(name) || TITLE_DROP[name] === true) {
        for (;;) {
          let j = i;
          while (tex[j] === " ") j++;
          const end = tex[j] === "{" ? skipGroup(tex, j, "{", "}") : tex[j] === "[" ? skipGroup(tex, j, "[", "]") : -1;
          if (end < 0) break;
          i = end;
        }
        out += " ";
      }
      // Formatting commands leave their arguments (the prose); accents and other control symbols carry no letters.
    } else {
      out += c === "~" || c === "\n" ? " " : c === "{" || c === "}" || c === "$" ? "" : c;
      i++;
    }
  }
  return out.replace(/\s+/g, " ").replace(/ ([.,;:!?])/g, "$1").trim();
}

/** TEXT with comments and verbatim material blanked out (newlines and offsets kept). */
export function maskSource(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "%") {
      const eol = text.indexOf("\n", i);
      const end = eol < 0 ? text.length : eol;
      blank(i, end);
      i = end;
    } else if (c === "\\") {
      const env = /^\\begin\{([A-Za-z]+\*?)\}/.exec(text.slice(i, i + 40));
      if (env && VERBATIM_ENV[env[1]] === true) {
        const close = text.indexOf(`\\end{${env[1]}}`, i + env[0].length);
        const end = close < 0 ? text.length : close;
        blank(i + env[0].length, end);
        i = end;
        continue;
      }
      const verb = /^\\(?:verb\*?|lstinline|mintinline\{[^}]*\})([^A-Za-z\s{])/.exec(text.slice(i, i + 40));
      if (verb) {
        const close = text.indexOf(verb[1], i + verb[0].length);
        const end = close < 0 ? text.length : close + 1;
        blank(i, end);
        i = end;
        continue;
      }
      i += 2; // Skips escaped characters, \% included.
    } else i++;
  }
  return out.join("");
}

interface AuxData {
  /** Label → printed number. */
  labels: Map<string, string>;
  /** Numbered table-of-contents/figure/table entries in order, by kind. */
  entries: Map<string, string[]>;
}

/** Numbers from an .aux file and the .aux files it \@input's (\include'd chapters). */
export function readAux(file: string, into: AuxData = { labels: new Map(), entries: new Map() }, depth = 0): AuxData {
  if (depth > 8 || !existsSync(file)) return into;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\\(newlabel|@writefile|@input)\{/g)) {
    const argStart = m.index + m[0].length - 1;
    const argEnd = skipGroup(text, argStart, "{", "}");
    if (argEnd < 0) continue;
    const arg = text.slice(argStart + 1, argEnd - 1);
    if (m[1] === "@input") readAux(join(dirname(file), arg), into, depth + 1);
    else if (m[1] === "newlabel") {
      if (arg.endsWith("@cref") || text[argEnd] !== "{" || text[argEnd + 1] !== "{") continue;
      const numEnd = skipGroup(text, argEnd + 1, "{", "}");
      if (numEnd < 0) continue;
      const num = plainTitle(text.slice(argEnd + 2, numEnd - 1));
      if (num && !into.labels.has(arg)) into.labels.set(arg, num);
    } else {
      const end = text[argEnd] === "{" ? skipGroup(text, argEnd, "{", "}") : -1;
      if (end < 0) continue;
      const line = /\\contentsline\s*\{(\w+)\}\s*\{\\numberline\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(text.slice(argEnd, end));
      if (!line) continue;
      const list = into.entries.get(line[1]) ?? [];
      list.push(plainTitle(line[2]));
      into.entries.set(line[1], list);
    }
  }
  return into;
}

interface Scan {
  items: (OutlineItem & { rank?: number; parentRank?: number; starred: boolean })[];
  labels: Map<string, { file: string; line: number }[]>;
  refs: { key: string; file: string; line: number }[];
  cites: { key: string; file: string; line: number }[];
  seen: Set<string>;
  /** Files the last build read, to pick between candidate paths of an \input; null before the first build. */
  deps: Set<string> | null;
  sectionRank?: number;
}

/** Index just past the optional [..] groups and whitespace at s[i]. */
function skipOptional(s: string, i: number): number {
  for (;;) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s[i] !== "[") return i;
    const end = skipGroup(s, i, "[", "]");
    if (end < 0) return i;
    i = end;
  }
}

/** The braced argument at s[i] (after optional args and whitespace): its content and the index past it. */
function braced(s: string, i: number): { text: string; end: number } | null {
  const at = skipOptional(s, i);
  if (s[at] !== "{") return null;
  const end = skipGroup(s, at, "{", "}");
  return end < 0 ? null : { text: s.slice(at + 1, end - 1), end };
}

/** Project-relative file an \input-like NAME refers to, trying the project directory and BASES in turn. */
function resolveInput(cfg: Config, name: string, bases: string[], deps: Set<string> | null): string | null {
  const rels: string[] = [];
  for (const base of [cfg.dir, ...bases]) {
    for (const n of name.endsWith(".tex") ? [name] : [`${name}.tex`, name]) {
      const rel = relative(cfg.dir, resolve(base, n));
      if (!rel.startsWith("..") && !isAbsolute(rel)) rels.push(posix(rel));
    }
  }
  return rels.find((r) => deps?.has(r)) ?? rels.find((r) => existsSync(join(cfg.dir, r)) && statSync(join(cfg.dir, r)).isFile()) ?? null;
}

function scanFile(cfg: Config, file: string, st: Scan, isRoot: boolean): void {
  if (st.seen.has(file)) return;
  st.seen.add(file);
  const src = maskSource(readFileSync(join(cfg.dir, file), "utf8"));
  const fileDir = dirname(join(cfg.dir, file));
  const begin = isRoot ? src.indexOf("\\begin{document}") : -1;
  const from = begin < 0 ? 0 : begin;
  for (const u of citeUses(src.slice(from))) st.cites.push({ key: u.key, file, line: u.line + (src.slice(0, from).match(/\n/g)?.length ?? 0) });
  /** Open float or numbered display-math environment. */
  let env: { name: string; item?: Scan["items"][number]; bodyStart: number } | null = null;
  let line = 1;
  let counted = 0;
  const lineAt = (offset: number) => {
    for (; counted < offset; counted++) if (src[counted] === "\n") line++;
    return line;
  };
  const re = /\\([A-Za-z@]+)(\*?)/g;
  re.lastIndex = from;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1];
    const after = m.index + m[0].length;
    const at = lineAt(m.index);
    const section = SECTION_KINDS.find((k) => k === name);
    if (section) {
      const arg = braced(src, after);
      if (!arg) continue;
      const rank = SECTION_KINDS.indexOf(section);
      st.items.push({ kind: section, level: 0, title: plainTitle(arg.text), file, line: at, rank, starred: m[2] === "*" });
      st.sectionRank = rank;
    } else if (name === "begin" || name === "end") {
      const arg = braced(src, after);
      if (!arg) continue;
      const envName = arg.text.trim();
      if (name === "end") {
        if (env && env.name === envName) env = null;
        continue;
      }
      const float = FLOAT_KIND[envName];
      if (float) {
        const item = { kind: float, level: 0, title: "", file, line: at, parentRank: st.sectionRank, starred: false };
        st.items.push(item);
        env = { name: envName, item, bodyStart: arg.end };
      } else if (EQUATION_ENV[envName] === true) env = { name: envName, bodyStart: arg.end };
    } else if (name === "caption") {
      const arg = braced(src, after);
      if (arg && env?.item && !env.item.title) env.item.title = plainTitle(arg.text);
    } else if (name === "label") {
      const arg = braced(src, after);
      const key = arg?.text.trim();
      if (!arg || !key) continue;
      const defs = st.labels.get(key) ?? [];
      defs.push({ file, line: at });
      st.labels.set(key, defs);
      if (env && FLOAT_KIND[env.name] === undefined) {
        // A labelled row of display math: its title is the row's source.
        const close = src.indexOf(`\\end{${env.name}}`, after);
        const body = src.slice(env.bodyStart, close < 0 ? src.length : close);
        const pos = m.index - env.bodyStart;
        const rowStart = body.lastIndexOf("\\\\", pos);
        const rowEnd = body.indexOf("\\\\", pos);
        const row = body.slice(rowStart < 0 ? 0 : rowStart + 2, rowEnd < 0 ? body.length : rowEnd);
        const math = row.replace(/\\label\s*\{[^}]*\}|\\(?:nonumber|notag)\b|&/g, " ").replace(/\s+/g, " ").trim();
        st.items.push({ kind: "equation", level: 0, title: math.length > 80 ? `${math.slice(0, 79)}…` : math, file, line: at, label: key, parentRank: st.sectionRank, starred: false });
      } else if (env?.item) env.item.label ??= key;
      else {
        const last = st.items.at(-1);
        if (last?.rank !== undefined && last.label === undefined) last.label = key;
      }
    } else if (REF_CMD[name] === true || RANGE_CMD[name] === true) {
      let i = after;
      for (let n = RANGE_CMD[name] === true ? 2 : 1; n > 0; n--) {
        const arg = braced(src, i);
        if (!arg) break;
        for (const k of arg.text.split(",")) if (k.trim()) st.refs.push({ key: k.trim(), file, line: at });
        i = arg.end;
      }
    } else if (INPUT_CMD[name] === true) {
      const arg = braced(src, after);
      const target = arg?.text.trim() ?? /^\s+([^\s{}%\\]+)/.exec(src.slice(after))?.[1];
      const rel = target ? resolveInput(cfg, target, [fileDir], st.deps) : null;
      if (rel) scanFile(cfg, rel, st, false);
    } else if (IMPORT_CMD[name] === true) {
      const dir = braced(src, after);
      const name2 = dir ? braced(src, dir.end) : null;
      if (!dir || !name2) continue;
      const base = name.startsWith("sub") ? resolve(fileDir, dir.text.trim()) : resolve(cfg.dir, dir.text.trim());
      const rel = resolveInput(cfg, join(base, name2.text.trim()), [], st.deps);
      if (rel) scanFile(cfg, rel, st, false);
    }
  }
}

/** The outline of one document; see the module comment. */
export function outline(cfg: Config, doc: DocConfig): Outline {
  const dp = docPaths(cfg, doc);
  const deps = existsSync(dp.deps) ? new Set(parseDeps(readFileSync(dp.deps, "utf8"), cfg.dir, relative(cfg.dir, dp.staging))) : null;
  const st: Scan = { items: [], labels: new Map(), refs: [], cites: [], seen: new Set(), deps };
  scanFile(cfg, posix(doc.root), st, true);

  const top = Math.min(...st.items.flatMap((i) => (i.rank === undefined ? [] : [i.rank])));
  const aux = readAux(dp.aux);
  const ordinal = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const i of st.items) if (!i.starred && i.kind !== "equation") sourceCounts.set(i.kind, (sourceCounts.get(i.kind) ?? 0) + 1);
  const items: OutlineItem[] = st.items.map((i) => {
    const level = i.rank !== undefined ? i.rank - top + 1 : i.parentRank !== undefined ? i.parentRank - top + 2 : 1;
    let number = i.label ? aux.labels.get(i.label) : undefined;
    if (!i.starred && i.kind !== "equation") {
      // Unlabelled items take the n-th numbered .aux entry of their kind, when source and .aux agree on the count.
      const n = ordinal.get(i.kind) ?? 0;
      ordinal.set(i.kind, n + 1);
      const entries = aux.entries.get(i.kind);
      if (number === undefined && entries && entries.length === sourceCounts.get(i.kind)) number = entries[n];
    }
    if (i.starred) number = undefined;
    return { kind: i.kind, level, title: i.title, ...(number ? { number } : {}), file: i.file, line: i.line, ...(i.label ? { label: i.label } : {}) };
  });

  const problems: OutlineProblem[] = [];
  for (const r of st.refs) if (!st.labels.has(r.key)) problems.push({ kind: "undefined-ref", ...r });
  const bib = definedKeys(cfg);
  for (const c of st.cites) if (!bib.has(c.key)) problems.push({ kind: "missing-citation", ...c });
  for (const [key, defs] of st.labels) for (const d of defs.slice(1)) problems.push({ kind: "duplicate-label", key, ...d });
  const referenced = new Set(st.refs.map((r) => r.key));
  for (const [key, defs] of st.labels) if (!referenced.has(key)) problems.push({ kind: "unused-label", key, ...defs[0] });
  return { doc: doc.name, items, problems };
}
