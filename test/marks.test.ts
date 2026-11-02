import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initials, renderReviewSetup, reviewer } from "../src/changes.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { locateSelection } from "../src/locate.ts";
import { markHunk } from "../src/marks.ts";
import { applyHunks } from "../src/proofread.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(toml: string, main: string): Config {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-marks-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ternlatex.toml"), `root = "main.tex"\n${toml}`);
  writeFileSync(join(dir, "main.tex"), main);
  return loadConfig(dir);
}

/** The source after marking SELECTED (its first occurrence) as KIND by author AK. */
function mark(src: string, selected: string, kind: Parameters<typeof markHunk>[4], text = ""): string {
  const start = src.indexOf(selected);
  const h = markHunk("main.tex", src, start, start + selected.length, kind, text);
  if (typeof h === "string") throw new Error(h);
  return applyHunks(src, [h], false, "AK");
}

describe("review marks", () => {
  const src = "The quick brown fox jumps.\n";

  test("strike, replace, insert, highlight and comment become the author's tracked changes", () => {
    expect(mark(src, "quick", "delete")).toBe("The \\deleted[id=AK]{quick} brown fox jumps.\n");
    expect(mark(src, "quick", "replace", "slow")).toBe("The \\replaced[id=AK]{slow}{quick} brown fox jumps.\n");
    expect(mark(src, "fox", "insert", "and its friend")).toBe("The quick brown fox\\added[id=AK]{ and its friend} jumps.\n");
    expect(mark(src, "fox", "insert", ", sadly,")).toBe("The quick brown fox\\added[id=AK]{, sadly,} jumps.\n");
    expect(mark(src, "brown fox", "highlight")).toBe("The quick \\highlight[id=AK]{brown fox} jumps.\n");
    expect(mark(src, "brown fox", "comment", "colour? 50% sure")).toBe("The quick brown fox\\comment[id=AK]{colour? 50\\% sure} jumps.\n");
  });

  test("typed text is escaped unless it is LaTeX", () => {
    expect(mark(src, "quick", "replace", "R&D_1")).toContain("\\replaced[id=AK]{R\\&D\\_1}{quick}");
    expect(mark(src, "quick", "replace", "\\emph{very} quick")).toContain("\\replaced[id=AK]{\\emph{very} quick}{quick}");
  });

  test("a selection that would split a brace group, math or a paragraph is refused", () => {
    const tex = "An \\emph{important point} and $x + y$ here.\n\nNext paragraph.";
    const reason = (selected: string) => {
      const start = tex.indexOf(selected);
      return markHunk("main.tex", tex, start, start + selected.length, "delete", "");
    };
    expect(reason("point} and")).toMatch(/group/);
    expect(reason("y$ here")).toMatch(/math/);
    expect(reason("here.\n\nNext")).toMatch(/paragraphs/);
    expect(typeof reason("\\emph{important point}")).toBe("object");
    expect(markHunk("main.tex", tex, 0, 2, "replace", "  ")).toMatch(/type the new text/);
  });
});

describe("reviewer", () => {
  test("initials from a name, accents folded", () => {
    expect(initials("Fatma Öz-Kaya")).toBe("FOK");
    expect(initials("ana")).toBe("A");
    expect(initials("")).toBe("");
  });

  test("[review] me wins and takes its name from [review] authors; the setup defines it", () => {
    const cfg = project('[review]\nme = "AK"\nauthors = [{ id = "AK", name = "Ana K" }]\n', "x");
    expect(reviewer(cfg)).toEqual({ id: "AK", name: "Ana K", color: undefined });
    const unlisted = project('[review]\nme = "ZZ"\n', "x");
    expect(reviewer(unlisted)).toEqual({ id: "ZZ", name: "ZZ" });
    expect(renderReviewSetup(unlisted, reviewer(unlisted))).toMatch(/\\definechangesauthor\[name=\{ZZ\}, color=\w+\]\{ZZ\}/);
  });
});

describe("locating a selection", () => {
  const main = "\\begin{document}\nThe theory of the thermal bath.\nLater the end.\n\\end{document}\n";

  test("is found as a whole word near SyncTeX's line, never inside another word", () => {
    const cfg = project("", main);
    const doc = cfg.docs[0];
    const near = locateSelection(cfg, doc, "the", { file: "main.tex", line: 3 });
    expect(near && main.slice(near.start, near.end)).toBe("the");
    expect(near?.from).toBe(3);
    const first = locateSelection(cfg, doc, "the", { file: "main.tex", line: 2 });
    expect(first?.from).toBe(2);
    expect(main.slice(first?.start ?? 0, (first?.start ?? 0) + 10)).toBe("the therma");
    expect(locateSelection(cfg, doc, "the", undefined)).toBeNull();
  });

  test("the words around it in the PDF pick the right one of several occurrences on the same source line", () => {
    const line = "The cat sat on the mat, and later the cat \\emph{ran} off the mat again.";
    const src = `\\begin{document}\n${line}\n\\end{document}\n`;
    const cfg = project("", src);
    const doc = cfg.docs[0];
    const hint = { file: "main.tex", line: 2 };
    const at = (selection: string, before: string, after: string) => {
      const loc = locateSelection(cfg, doc, selection, hint, { before, after });
      return loc ? src.slice(loc.start - 10, loc.end + 6) : null;
    };
    expect(at("the cat", "on the mat, and later", "ran off the mat")).toBe("and later the cat \\emph");
    expect(at("the mat", "and later the cat ran off", "again.")).toBe("{ran} off the mat again");
    expect(at("the mat", "The cat sat on", ", and later")).toBe("at sat on the mat, and ");
    // Without context: the first on the line, as before.
    expect(locateSelection(cfg, doc, "the mat", hint)?.start).toBe(src.indexOf("the mat"));
  });

  test("goes through the user's text macros, citations, references and math, covering a command it starts or ends in", () => {
    const src = [
      "\\newcommand{\\tool}{\\textsc{Gallifrey}\\xspace}",
      "\\begin{document}",
      "\\tool{} completed the assembly faster, as \\autoref{tab:x} shows, and $x^2$ grows as \\citet{knuth} said.",
      "\\end{document}",
      "",
    ].join("\n");
    const cfg = project("", src);
    const doc = cfg.docs[0];
    const at = (selection: string) => {
      const loc = locateSelection(cfg, doc, selection, { file: "main.tex", line: 3 });
      return loc ? src.slice(loc.start, loc.end) : null;
    };
    expect(at("Gallifrey completed the assembly")).toBe("\\tool{} completed the assembly");
    expect(at("faster, as Table 2 shows")).toBe("faster, as \\autoref{tab:x} shows");
    expect(at("x2 grows as Knuth (1984) said.")).toBe("$x^2$ grows as \\citet{knuth} said.");
    expect(at("nothing like this")).toBeNull();

    const start = src.indexOf("\\tool{}");
    const h = markHunk("main.tex", src, start, start + "\\tool{} completed".length, "delete", "");
    expect(typeof h === "string" ? h : applyHunks(src, [h], false, "AK")).toContain("\\deleted[id=AK]{\\tool{} completed} the assembly");
  });
});
