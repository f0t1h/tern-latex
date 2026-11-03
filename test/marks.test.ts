import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initials, parseSpans, renderReviewSetup, reviewer, rewrite } from "../src/changes.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { locateSelection } from "../src/locate.ts";
import { markHunks, replaceableSource } from "../src/marks.ts";
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
function mark(src: string, selected: string, kind: Parameters<typeof markHunks>[4], text = ""): string {
  const start = src.indexOf(selected);
  const h = markHunks("main.tex", src, start, start + selected.length, kind, text);
  if (typeof h === "string") throw new Error(h);
  return applyHunks(src, h, false, "AK");
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

  test("a selection that would split a brace group or math is refused", () => {
    const tex = "An \\emph{important point} and $x + y$ here.\n\nNext paragraph.";
    const reason = (selected: string) => {
      const start = tex.indexOf(selected);
      return markHunks("main.tex", tex, start, start + selected.length, "delete", "");
    };
    expect(reason("point} and")).toMatch(/group/);
    expect(reason("y$ here")).toMatch(/math/);
    expect(typeof reason("\\emph{important point}")).toBe("object");
    expect(markHunks("main.tex", tex, 0, 2, "replace", "  ")).toMatch(/type the new text/);
  });

  test("over several paragraphs: a strike or highlight per paragraph, one comment at the end, no replacement", () => {
    const tex = "First one ends here.\n\n  Second starts here and ends.\n";
    const all = "ends here.\n\n  Second starts";
    expect(mark(tex, all, "delete")).toBe("First one \\deleted[id=AK]{ends here.}\n\n  \\deleted[id=AK]{Second starts} here and ends.\n");
    expect(mark(tex, all, "highlight")).toBe("First one \\highlight[id=AK]{ends here.}\n\n  \\highlight[id=AK]{Second starts} here and ends.\n");
    expect(mark(tex, all, "comment", "Merge these?")).toBe("First one ends here.\n\n  Second starts\\comment[id=AK]{Merge these?} here and ends.\n");
    const start = tex.indexOf(all);
    expect(markHunks("main.tex", tex, start, start + all.length, "replace", "x")).toMatch(/can't span paragraphs/);
  });

  test("a highlight goes around footnotes and earlier marks; a strike over them is refused; \\autoref is boxed for ulem", () => {
    const tex = "Fast\\footnote{Very.} build here\\comment[id=B]{why?} and \\autoref{tab:x} there.\n";
    const all = tex.trim();
    expect(mark(tex, all, "highlight")).toBe(
      "\\highlight[id=AK]{Fast}\\footnote{Very.} \\highlight[id=AK]{build here}\\comment[id=B]{why?} \\highlight[id=AK]{and \\mbox{\\autoref{tab:x}} there.}\n",
    );
    expect(markHunks("main.tex", tex, 0, all.length, "delete", "")).toMatch(/footnote/);
    const plain = "See \\autoref{tab:x} now.\n";
    expect(mark(plain, "See \\autoref{tab:x}", "delete")).toBe("\\deleted[id=AK]{See \\mbox{\\autoref{tab:x}}} now.\n");
    // natbib's citations break the same way.
    expect(mark("\\Citet{knuth} designed it.\n", "\\Citet{knuth} designed", "replace", "\\Citet{knuth} built")).toBe(
      "\\replaced[id=AK]{\\Citet{knuth} built}{\\mbox{\\Citet{knuth}} designed} it.\n",
    );
  });

  test("Replace… edits the selection's LaTeX: offered as it stands, taken back verbatim", () => {
    const tex = "As in Fig.~\\ref{fig:a}, \\tool is 50\\% faster.\n\nNext.\n";
    const sel = "Fig.~\\ref{fig:a}, \\tool is 50\\% faster";
    const start = tex.indexOf(sel);
    expect(replaceableSource(tex, start, start + sel.length)).toEqual({ start, end: start + sel.length, latex: sel });
    const edited = "Fig.~\\ref{fig:a}, \\tool runs 50\\% faster";
    const h = markHunks("main.tex", tex, start, start + sel.length, "replace", edited, true);
    if (typeof h === "string") throw new Error(h);
    expect(applyHunks(tex, h, false, "AK")).toContain(`\\replaced[id=AK]{${edited}}{${sel}}`);
    // Typed plain text (no source) is still escaped: its ~ is a tilde, not a tie.
    expect(mark(tex, "faster", "replace", "~2x")).toContain("\\replaced[id=AK]{\\textasciitilde{}2x}{faster}");
    expect(replaceableSource(tex, start, tex.indexOf("Next.") + 5)).toMatch(/can't span paragraphs/);
    expect(replaceableSource(tex, tex.indexOf("fig:a}"), tex.indexOf(" is"))).toMatch(/group/);
  });

  test("a list or footnote in new text goes in as tracked items around untracked scaffolding; rejecting restores the text", () => {
    const tex = "Some old words here.\n";
    const list = "\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}";
    const out = mark(tex, "old words", "replace", list);
    expect(out).toBe("Some \\deleted[id=AK]{old words}\\begin{itemize}\n\\item \\added[id=AK]{one}\n\\item \\added[id=AK]{two}\n\\end{itemize} here.\n");
    expect(rewrite(out, parseSpans(out), "reject")).toBe(tex);
    expect(rewrite(out, parseSpans(out), "accept")).toBe("Some \\begin{itemize}\n\\item one\n\\item two\n\\end{itemize} here.\n");
    const noted = mark(tex, "words", "insert", "\\footnote{See \\emph{there}.}");
    expect(noted).toBe("Some old words\\footnote{\\added[id=AK]{See \\emph{there}.}} here.\n");
    expect(rewrite(noted, parseSpans(noted), "reject")).toBe(tex);
    const at = tex.indexOf("words");
    expect(markHunks("main.tex", tex, at, at + 5, "replace", "\\begin{equation}x\\end{equation}", true)).toMatch(/only lists .* and footnotes/);
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
    const h = markHunks("main.tex", src, start, start + "\\tool{} completed".length, "delete", "");
    expect(typeof h === "string" ? h : applyHunks(src, h, false, "AK")).toContain("\\deleted[id=AK]{\\tool{} completed} the assembly");
  });

  test("takes words the PDF hyphenated at a line end, words cut by the drag, and section and caption numbers", () => {
    const src = "\\begin{document}\n\\section{Methods}\nThe assembler compacts simple nodes in parallel.\n\\end{document}\n";
    const cfg = project("", src);
    const doc = cfg.docs[0];
    const at = (selection: string) => {
      const loc = locateSelection(cfg, doc, selection, { file: "main.tex", line: 3 });
      return loc ? src.slice(loc.start, loc.end) : null;
    };
    expect(at("The assem- bler compacts")).toBe("The assembler compacts");
    expect(at("ssembler compacts sim")).toBe("assembler compacts simple");
    expect(at("2 Methods The assembler")).toBe("\\section{Methods}\nThe assembler");
  });
});
