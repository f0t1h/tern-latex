import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { lineEndOffset, locateSelection, plainText } from "../src/locate.ts";

// moderncv-style source: the prose sits in macro arguments, where SyncTeX can't place it.
const CV = `\\documentclass{moderncv}
\\begin{document}
\\cventry{Jan 2019 -- Dec 2023}{Synthetic Biology Group}{}{}{}{%
  \\pick{%
    Distributed widget calibration (supervisor: Dr.\\ Ada Example)%
  }{%
    \\begin{itemize}
      \\item Project: Distributed widget calibration
    \\end{itemize}%
  }%
}
\\end{document}
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-locate-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), CV);
  const cfg = loadConfig(dir);
  return { cfg, doc: cfg.docs[0] };
}

test("plain text drops commands, braces and comments but keeps escaped spaces", () => {
  expect(plainText("Dr.\\ Ada~Example)% note\n\\emph{and} more").text).toBe("Dr. Ada Example) and more");
});

test("a selection inside macro arguments maps to its own source lines, not where SyncTeX points", () => {
  const { cfg, doc } = project();
  const sel = "Distributed widget calibration (supervisor: Dr. Ada Example)";
  // SyncTeX blamed line 11 (the macro's closing brace) in a real CV.
  expect(locateSelection(cfg, doc, sel, { file: "main.tex", line: 11 })).toEqual({ file: "main.tex", from: 5, to: 5, end: CV.indexOf("Example)") + "Example)".length });
});

test("of several occurrences, the one nearest the SyncTeX guess wins", () => {
  const { cfg, doc } = project();
  expect(locateSelection(cfg, doc, "Distributed widget calibration", { file: "main.tex", line: 8 })).toEqual({ file: "main.tex", from: 8, to: 8, end: CV.lastIndexOf("calibration") + "calibration".length });
});

test("words that are not in the sources give null (SyncTeX is used instead)", () => {
  const { cfg, doc } = project();
  expect(locateSelection(cfg, doc, "nothing like this appears", undefined)).toBeNull();
});

test("the selection's end offset lands after escaped characters, past citations inside it", () => {
  const { cfg, doc } = project();
  const src = "\\documentclass{article}\n\\begin{document}\nProfits rose sharply last year, see \\cite{knuth1984}, by 50\\% for R\\&D at \\emph{Smith \\& Co}. Next.\n\\end{document}\n";
  writeFileSync(join(cfg.dir, "main.tex"), src);
  // The PDF shows the citation as a number: only the selection's head and tail words must match.
  const found = locateSelection(cfg, doc, "Profits rose sharply last year, see [1], by 50% for R&D at Smith & Co");
  expect(found).toEqual({ file: "main.tex", from: 3, to: 3, end: src.indexOf("Smith \\& Co") + "Smith \\& Co".length });
  expect(locateSelection(cfg, doc, "for R&D")?.end).toBe(src.indexOf("R\\&D") + "R\\&D".length);
});

test("lineEndOffset: the end of a line before its break, the file's end past the last line", () => {
  const src = "one\r\ntwo\nthree";
  expect(lineEndOffset(src, 1)).toBe(3);
  expect(lineEndOffset(src, 2)).toBe(8);
  expect(lineEndOffset(src, 3)).toBe(src.length);
  expect(lineEndOffset(src, 9)).toBe(src.length);
});
