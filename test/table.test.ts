import { describe, expect, test } from "bun:test";
import { parseSpans, rewrite } from "../src/changes.ts";
import { applyHunks } from "../src/proofread.ts";
import { type GridRow, type Table, type TableEdit, tableAt, tableHunks } from "../src/table.ts";

const SRC = [
  "\\begin{table}",
  "  \\begin{tabular}{l S[table-format=3.0] S[table-format=1.2]}",
  "    \\toprule",
  "    {Document} & {Pages} & {Latency} \\\\",
  "    \\midrule",
  "    Letter     &   1 & 0.41 \\\\",
  "    Article    &   8 & 0.86 \\\\ % a comment",
  "    \\multicolumn{2}{l}{Both} & 1.00 \\\\",
  "    \\bottomrule",
  "  \\end{tabular}",
  "\\end{table}",
  "",
].join("\n");

function table(): Table {
  const t = tableAt("t.tex", SRC, SRC.indexOf("Letter"));
  if (!t) throw new Error("no table");
  return t;
}

/** The grid as the editor starts it: every row and column as they are. */
function grid(t: Table): { rows: GridRow[]; columns: TableEdit["columns"] } {
  const rows = t.lines.flatMap((l) => (l.kind === "row" ? [l] : []));
  return {
    columns: t.columns.map((_, i) => ({ from: i })),
    rows: rows.map((r, i) => {
      const cells: string[] = [];
      for (const c of r.cells) cells.push(c.text, ...Array.from({ length: c.span - 1 }, () => ""));
      return { from: i, cells };
    }),
  };
}

function edited(edit: TableEdit): string {
  const h = tableHunks(SRC, table(), edit);
  if (typeof h === "string") throw new Error(h);
  return applyHunks(SRC, h, !edit.track, "AK");
}

describe("table editor", () => {
  test("reads columns (siunitx S numeric), rules, rows and cells, a \\multicolumn as one wide cell", () => {
    const t = table();
    expect(t.env).toBe("tabular");
    expect(t.columns.map((c) => [c.spec, c.numeric, c.align])).toEqual([
      ["l", false, "l"],
      ["S[table-format=3.0]", true, "r"],
      ["S[table-format=1.2]", true, "r"],
    ]);
    expect(t.lines.map((l) => (l.kind === "rule" ? l.text : l.cells.map((c) => c.text).join("|")))).toEqual([
      "\\toprule",
      "{Document}|{Pages}|{Latency}",
      "\\midrule",
      "Letter|1|0.41",
      "Article|8|0.86",
      "Both|1.00",
      "\\bottomrule",
    ]);
    const both = t.lines[5];
    expect(both.kind === "row" && both.cells[0].span).toBe(2);
    expect(tableAt("t.tex", SRC, SRC.indexOf("\\begin{table}"))).toBeNull();
  });

  test("tracked: a changed number is braced for siunitx, a new row and a removed one are marked cell by cell; reject restores the table", () => {
    const g = grid(table());
    g.rows[1].cells[2] = "0.39";
    g.rows[2].deleted = true;
    g.rows.splice(2, 0, { from: null, cells: ["Memo", "2", "0.50"] });
    const out = edited({ ...g, track: true });
    expect(out).toContain("    Letter     &   1 & {\\replaced[id=AK]{0.39}{0.41}} \\\\\n    \\added[id=AK]{Memo} & {\\added[id=AK]{2}} & {\\added[id=AK]{0.50}} \\\\\n");
    expect(out).toContain("    \\deleted[id=AK]{Article}    &   {\\deleted[id=AK]{8}} & {\\deleted[id=AK]{0.86}} \\\\ % a comment");
    expect(rewrite(out, parseSpans(out), "reject")).toBe(SRC);
    const accepted = rewrite(out, parseSpans(out), "accept");
    expect(accepted).toContain("    Letter     &   1 & 0.39 \\\\\n    Memo & 2 & 0.50 \\\\\n");
    expect(accepted).not.toContain("Article");
  });

  test("direct: a column added (its neighbour's kind) and a row removed with its line", () => {
    const g = grid(table());
    const plain = { ...g, rows: g.rows.filter((_, i) => i !== 3) }; // \multicolumn rows block column changes
    expect(tableHunks(SRC, table(), { ...g, columns: [...g.columns, { from: null }], rows: g.rows.map((r) => ({ ...r, cells: [...r.cells, ""] })), track: false })).toMatch(/multicolumn/);
    const src = SRC.replace("    \\multicolumn{2}{l}{Both} & 1.00 \\\\\n", "");
    const t = tableAt("t.tex", src, src.indexOf("Letter"));
    if (!t) throw new Error("no table");
    const edit: TableEdit = {
      columns: [{ from: 0 }, { from: null }, { from: 1 }, { from: 2 }],
      rows: plain.rows.map((r, i) => ({ from: i, cells: [r.cells[0], i === 0 ? "{Kind}" : "x", r.cells[1], r.cells[2]], ...(i === 2 ? { deleted: true } : {}) })),
      track: false,
    };
    const h = tableHunks(src, t, edit);
    if (typeof h === "string") throw new Error(h);
    const out = applyHunks(src, h, true, "AK");
    expect(out).toContain("\\begin{tabular}{l l S[table-format=3.0] S[table-format=1.2]}");
    expect(out).toContain("    {Document} & {Kind} & {Pages} & {Latency} \\\\");
    expect(out).toContain("    Letter & x & 1 & 0.41 \\\\");
    expect(out).not.toContain("Article");
    expect(tableHunks(src, t, { ...edit, track: true })).toMatch(/turn off Track changes/);
  });
});
