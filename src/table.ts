import { createHash } from "node:crypto";
import { groupEnd } from "./align.ts";
import type { Hunk } from "./proofread.ts";

/**
 * Tables for the viewer's table editor: the `tabular` around a source offset as rows of cells (each cell's LaTeX
 * and where it is), and the edits that turn it into the grid the user saved. Tracked edits are `changes` marks per
 * cell (a cell in a siunitx `S` column braced, as `S` parses anything else as a number); rows added or removed
 * are marks in each of their cells around untracked `&` and `\\`, so resolving them leaves an empty row, which
 * resolving removes (changes.ts tidy). Columns change the column spec, which no mark can hold: direct edits only.
 */

const TABLE_ENVS = /^(?:tabular\*?|tabularx|tabulary|longtable\*?|xltabular)$/;
/** Environments whose first argument is the table's width, before the column spec. */
const WIDTH_FIRST = /^(?:tabular\*|tabularx|tabulary|xltabular)$/;
/** Lines between rows that hold no cells: rules, spacing, longtable's head and foot markers. */
const RULE = /^\\(?:hline|toprule|midrule|bottomrule|cmidrule|cline|addlinespace|morecmidrules|specialrule|endhead|endfirsthead|endfoot|endlastfoot|noalign|rowcolor|hhline)\b/;

export interface TableColumn {
  /** The spec token: `l`, `p{3cm}`, `S[table-format=1.2]`, `X`. */
  spec: string;
  /** siunitx `S`: cells other than numbers must be braced. */
  numeric: boolean;
  align: "l" | "c" | "r";
}

export interface TableCell {
  /** The cell's LaTeX, trimmed; a \multicolumn's content. */
  text: string;
  start: number;
  end: number;
  /** Columns it covers (\multicolumn). */
  span: number;
  /** Why the editor can't change it (a \multirow, a nested table); absent when it can. */
  locked?: string;
}

export interface TableRow {
  kind: "row";
  cells: TableCell[];
  /** The row from its first character (after indentation) to just past its `\\` (or the body's end). */
  start: number;
  end: number;
  indent: string;
}

export interface TableRule {
  kind: "rule";
  text: string;
}

export interface Table {
  file: string;
  env: string;
  /** Offsets of `\begin{…}` and just past `\end{…}`. */
  begin: number;
  end: number;
  /** The column spec's inside, with its offsets. */
  spec: { text: string; start: number; end: number };
  columns: TableColumn[];
  lines: (TableRow | TableRule)[];
  /** The source line of `\begin`. */
  line: number;
  /** Of the whole file: an edit is refused when the file changed since. */
  version: string;
}

export function fileVersion(src: string): string {
  return createHash("sha1").update(src).digest("hex").slice(0, 12);
}

/** Column spec tokens with what precedes each (rules `|`, `@{…}`, `>{…}`); `*{n}{…}` expanded. */
function specColumns(spec: string): { pre: string; token: string }[] {
  const out: { pre: string; token: string }[] = [];
  let pre = "";
  for (let i = 0; i < spec.length; ) {
    const c = spec[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "*" && spec[i + 1] === "{") {
      const nEnd = groupEnd(spec, i + 1);
      const bodyEnd = groupEnd(spec, nEnd);
      const n = Number(spec.slice(i + 2, nEnd - 1)) || 1;
      const inner = specColumns(spec.slice(nEnd + 1, bodyEnd - 1));
      for (let k = 0; k < n; k++) for (const [j, col] of inner.entries()) out.push({ pre: (k === 0 && j === 0 ? pre : "") + col.pre, token: col.token });
      pre = "";
      i = bodyEnd;
      continue;
    }
    if (c === "|" || c === ":") {
      pre += c;
      i++;
      continue;
    }
    if ((c === "@" || c === "!" || c === ">" || c === "<") && spec[i + 1] === "{") {
      const e = groupEnd(spec, i + 1);
      pre += spec.slice(i, e);
      i = e;
      continue;
    }
    // A column letter with its arguments: p{3cm}, S[…], w{c}{1cm}.
    let e = i + 1;
    while (spec[e] === "{" || spec[e] === "[") e = groupEnd(spec, e);
    out.push({ pre, token: spec.slice(i, e) });
    pre = "";
    i = e;
  }
  if (pre && out.length) out[out.length - 1] = { ...out[out.length - 1], token: out[out.length - 1].token + pre };
  return out;
}

function column(token: string): TableColumn {
  const letter = token[0];
  return { spec: token, numeric: letter === "S", align: letter === "c" ? "c" : letter === "r" || letter === "S" ? "r" : "l" };
}

/** Index past `\\` (and its optional `[length]`) at I, or -1 when there is none. */
function rowBreak(src: string, i: number): number {
  if (src[i] !== "\\" || src[i + 1] !== "\\") return -1;
  let e = i + 2;
  const after = /^\*?\s*\[[^\]]*\]/.exec(src.slice(e, e + 40));
  if (after) e += after[0].length;
  return e;
}

/** The cells of SRC[START, END), split at `&` outside groups. */
function cells(src: string, start: number, end: number): TableCell[] {
  const out: TableCell[] = [];
  let from = start;
  const push = (to: number) => {
    const raw = src.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    const s = from + lead;
    const multi = /^\\multicolumn\s*\{(\d+)\}\s*\{/.exec(body);
    if (multi) {
      const specEnd = groupEnd(src, s + multi[0].length - 1);
      const open = src.indexOf("{", specEnd);
      const close = groupEnd(src, open);
      out.push({ text: src.slice(open + 1, close - 1).trim(), start: open + 1, end: close - 1, span: Number(multi[1]) });
    } else {
      const locked = /\\multirow\b/.test(body) ? "a \\multirow cell" : /\\begin\s*\{/.test(body) ? "an environment in a cell" : undefined;
      out.push({ text: body, start: s, end: s + body.length, span: 1, ...(locked ? { locked } : {}) });
    }
  };
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "%") i = Math.min(end, lineEndOf(src, i)) - 1;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "&" && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(end);
  // A % comment ending the row isn't part of its last cell.
  const last = out[out.length - 1];
  const comment = /(?<!\\)%.*$/s.exec(last.text);
  if (comment && !last.locked) out[out.length - 1] = { ...last, text: last.text.slice(0, comment.index).trimEnd(), end: last.start + last.text.slice(0, comment.index).trimEnd().length };
  return out;
}

function lineEndOf(src: string, i: number): number {
  const n = src.indexOf("\n", i);
  return n < 0 ? src.length : n;
}

function lineStartOf(src: string, i: number): number {
  return src.lastIndexOf("\n", i - 1) + 1;
}

/** The table environment whose body holds offset AT in SRC, as rows of cells; null when there is none. */
export function tableAt(file: string, src: string, at: number): Table | null {
  const found = [...src.matchAll(/\\begin\s*\{([^{}]+)\}/g)].filter((m) => TABLE_ENVS.test(m[1]) && m.index <= at);
  for (const m of found.reverse()) {
    const env = m[1];
    const endTag = new RegExp(String.raw`\\end\s*\{${env.replace("*", "\\*")}\}`, "g");
    endTag.lastIndex = m.index + m[0].length;
    const close = endTag.exec(src);
    if (!close || close.index + close[0].length < at) continue;
    let i = m.index + m[0].length;
    const skip = () => {
      while (/\s/.test(src[i] ?? "")) i++;
    };
    skip();
    if (src[i] === "[") i = src.indexOf("]", i) + 1;
    skip();
    if (WIDTH_FIRST.test(env)) {
      i = groupEnd(src, i);
      skip();
    }
    if (src[i] !== "{") continue;
    const specEnd = groupEnd(src, i);
    const spec = { text: src.slice(i + 1, specEnd - 1), start: i + 1, end: specEnd - 1 };
    const columns = specColumns(spec.text).map((c) => column(c.token));
    const lines: (TableRow | TableRule)[] = [];
    let pos = specEnd;
    const bodyEnd = close.index;
    while (pos < bodyEnd) {
      // Rules, comments and blank space before a row.
      const ws = /^[\s]*/.exec(src.slice(pos, bodyEnd))?.[0] ?? "";
      pos += ws.length;
      if (pos >= bodyEnd) break;
      if (src[pos] === "%") {
        pos = lineEndOf(src, pos);
        continue;
      }
      const rest = src.slice(pos, bodyEnd);
      const rule = RULE.exec(rest);
      if (rule) {
        let e = pos + rule[0].length;
        while (src[e] === "[" || src[e] === "(" || src[e] === "{") e = src[e] === "(" ? src.indexOf(")", e) + 1 : groupEnd(src, e);
        lines.push({ kind: "rule", text: src.slice(pos, e) });
        pos = e;
        continue;
      }
      // A row runs to the next \\ outside groups, else to the body's end.
      let depth = 0;
      let stop = bodyEnd;
      let after = bodyEnd;
      for (let k = pos; k < bodyEnd; k++) {
        const c = src[k];
        if (c === "\\" && src[k + 1] === "\\" && depth === 0) {
          stop = k;
          after = rowBreak(src, k);
          break;
        }
        if (c === "\\") k++;
        else if (c === "%") k = lineEndOf(src, k) - 1;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
      }
      if (src.slice(pos, stop).trim()) {
        const lineStart = lineStartOf(src, pos);
        lines.push({ kind: "row", cells: cells(src, pos, stop), start: pos, end: after, indent: /^[ \t]*/.exec(src.slice(lineStart, pos))?.[0] ?? "" });
      }
      pos = after;
    }
    return { file, env, begin: m.index, end: close.index + close[0].length, spec, columns, lines, line: src.slice(0, m.index).split("\n").length, version: fileVersion(src) };
  }
  return null;
}

/** A row of the grid the user saved: an original row (`from`, its index among the table's rows) or a new one. */
export interface GridRow {
  from: number | null;
  cells: string[];
  deleted?: boolean;
}

export interface TableEdit {
  rows: GridRow[];
  /** The grid's columns: an original column (`from`) or a new one; only direct edits change them. */
  columns: { from: number | null }[];
  track: boolean;
}

/** Hunks (untracked pieces as `raw`) that turn TABLE in SRC into EDIT's grid, or why they can't. */
export function tableHunks(src: string, table: Table, edit: TableEdit): Hunk[] | string {
  /** The grid column a row's Jth cell starts in (\multicolumn cells cover several). */
  const gridIndex = (row: TableRow, j: number) => row.cells.slice(0, j).reduce((n, c) => n + c.span, 0);
  const rows = table.lines.filter((l): l is TableRow => l.kind === "row");
  const width = table.columns.length;
  const changedColumns = edit.columns.length !== width || edit.columns.some((c, i) => c.from !== i);
  if (changedColumns && edit.track) return "columns can't be tracked: turn off Track changes to add or remove them";
  const kept = edit.columns.map((c) => c.from).filter((f): f is number => f !== null);
  if (kept.some((f, i) => f < 0 || f >= width || (i > 0 && f <= kept[i - 1]))) return "columns can only be added or removed, not moved";
  if (changedColumns && rows.some((r) => r.cells.some((c) => c.span > 1))) return "this table has \\multicolumn cells; change its columns in the source";
  if (edit.rows.some((r) => r.cells.length !== edit.columns.length)) return "every row needs one cell per column";
  const seen = edit.rows.map((r) => r.from).filter((f): f is number => f !== null);
  if (seen.some((f, i) => f < 0 || f >= rows.length || (i > 0 && f <= seen[i - 1])) || seen.length !== rows.length) return "rows can only be added or removed, not moved; reopen the table";
  const rowWidth = (row: TableRow) => row.cells.reduce((n, c) => n + c.span, 0);
  const wide = rows.findIndex((r) => rowWidth(r) > width);
  if (wide >= 0) return `row ${wide + 1} has more cells than the column spec {${table.spec.text}}; fix it in the source`;
  /** Text typed into the columns past a short row's last cell (`&`s it never had), trailing empties left out. */
  const extra = (row: TableRow, cells: string[]) => {
    const out = cells.slice(rowWidth(row)).map((t) => t.trim());
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  };

  const file = table.file;
  const lineAt = (offset: number) => src.slice(0, offset).split("\n").length;
  const hunks: Hunk[] = [];
  const raw = (at: number, text: string): Hunk => ({ file, start: at, end: at, old: "", new: text, why: "", line: lineAt(at), markup: "raw" });
  const numericAt = (col: number) => table.columns[edit.columns[col]?.from ?? -1]?.numeric === true;

  if (changedColumns || !edit.track) {
    // Direct: rows rewritten where they changed, removed rows dropped with their line, new rows written out.
    const specCols = specColumns(table.spec.text);
    if (changedColumns) {
      const spec = edit.columns
        .map((c, i) => {
          if (c.from !== null) return specCols[c.from].pre + specCols[c.from].token;
          // A new column takes its left neighbour's kind (the right one's when first).
          const near = edit.columns.slice(0, i).reverse().find((x) => x.from !== null)?.from ?? edit.columns.find((x) => x.from !== null)?.from ?? 0;
          return specCols[near]?.token.replace(/[|]+$/, "") ?? "l";
        })
        .join(/\s/.test(table.spec.text.trim()) ? " " : "");
      hunks.push({ file, start: table.spec.start, end: table.spec.end, old: table.spec.text, new: spec, why: "", line: lineAt(table.spec.start), markup: "raw" });
    }
    let insertAt = rows[0]?.start ?? table.spec.end + 1;
    let indent = rows[0]?.indent ?? "  ";
    let leading = true; // new rows before the first original one
    for (const r of edit.rows) {
      if (r.from === null) {
        const text = `${r.cells.join(" & ")} \\\\`;
        hunks.push(leading ? raw(insertAt, `${text}\n${indent}`) : raw(insertAt, `\n${indent}${text}`));
        continue;
      }
      const row = rows[r.from];
      leading = false;
      indent = row.indent;
      insertAt = row.end;
      if (r.deleted) {
        // The row and its line (when it has one to itself).
        const ls = lineStartOf(src, row.start);
        const le = lineEndOf(src, row.end);
        const own = !src.slice(ls, row.start).trim() && !src.slice(row.end, le).trim();
        const [s, e] = own ? [ls, Math.min(src.length, le + 1)] : [row.start, row.end];
        hunks.push({ file, start: s, end: e, old: src.slice(s, e), new: "", why: "", line: lineAt(s), markup: "raw" });
        continue;
      }
      const before = edit.columns.map((c) => (c.from === null ? "" : (row.cells[c.from]?.text ?? "")));
      if (!changedColumns) {
        for (const [j, cell] of row.cells.entries()) {
          const now = (r.cells[gridIndex(row, j)] ?? "").trim();
          if (now === cell.text || cell.locked) continue;
          hunks.push({ file, start: cell.start, end: cell.end, old: cell.text, new: now, why: "", line: lineAt(cell.start), markup: "raw" });
        }
        const more = extra(row, r.cells);
        if (more.length) hunks.push(raw(row.cells[row.cells.length - 1].end, more.map((t) => ` & ${t}`).join("")));
      } else if (r.cells.some((t, j) => t !== before[j]) || edit.columns.length !== width) {
        const last = row.cells[row.cells.length - 1];
        hunks.push({ file, start: row.start, end: last.end, old: src.slice(row.start, last.end), new: r.cells.join(" & "), why: "", line: lineAt(row.start), markup: "raw" });
      }
    }
    return hunks;
  }

  // Tracked: one mark per changed cell; a removed row struck cell by cell, a new one added cell by cell.
  const mark = (at: number, end: number, old: string, text: string, numeric: boolean): Hunk => ({ file, start: at, end, old, new: text, why: "", line: lineAt(at), ...(numeric ? { braced: true } : {}) });
  let insertAt = rows[0]?.start ?? table.spec.end + 1;
  let indent = rows[0]?.indent ?? "  ";
  let leading = true;
  for (const r of edit.rows) {
    if (r.from === null) {
      if (r.cells.every((t) => !t.trim())) continue;
      const pieces: Hunk[] = [raw(insertAt, leading ? "" : `\n${indent}`)];
      r.cells.forEach((t, j) => {
        if (j > 0) pieces.push(raw(insertAt, " & "));
        if (t.trim()) pieces.push(mark(insertAt, insertAt, "", t.trim(), numericAt(j)));
      });
      pieces.push(raw(insertAt, leading ? ` \\\\\n${indent}` : " \\\\"));
      hunks.push(...pieces.filter((p) => p.markup !== "raw" || p.new));
      continue;
    }
    const row = rows[r.from];
    leading = false;
    indent = row.indent;
    insertAt = row.end;
    for (const [j, cell] of row.cells.entries()) {
      const g = gridIndex(row, j);
      const now = r.deleted ? "" : (r.cells[g] ?? "").trim();
      if (cell.locked) {
        if (now !== cell.text) return `row ${r.from + 1} has ${cell.locked}, which the editor can't change; edit it in the source`;
        continue;
      }
      if (now === cell.text) continue;
      hunks.push(mark(cell.start, cell.end, cell.text, now, cell.span === 1 && numericAt(g)));
    }
    if (!r.deleted) {
      const end = row.cells[row.cells.length - 1].end;
      extra(row, r.cells).forEach((t, k) => {
        hunks.push(raw(end, " & "));
        if (t) hunks.push(mark(end, end, "", t, numericAt(rowWidth(row) + k)));
      });
    }
  }
  return hunks;
}
