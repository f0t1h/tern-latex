import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { outline, plainTitle } from "../src/outline.ts";

const dir = mkdtempSync(join(tmpdir(), "ternlatex-outline-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

put("ternlatex.toml", `root = "main.tex"\n`);
put("refs.bib", `@article{known2020,\n  author = {Known, A.},\n  title = {Known},\n  year = {2020},\n}\n`);
put(
  "main.tex",
  `\\documentclass{report}
\\newcommand{\\fake}{\\section{Not a section}}
\\begin{document}
\\chapter{Getting \\emph{Started} with \\LaTeX}
\\label{ch:start}
Intro text citing \\cite{known2020,ghost2021}. % \\ref{in:comment} \\label{dup}
\\include{chapters/one}
\\section*{Unnumbered}
\\begin{verbatim}
\\ref{in:verbatim} \\label{dup}
\\end{verbatim}
\\end{document}
`,
);
put(
  "chapters/one.tex",
  `\\section[Short]{Methods and $n$ runs\\footnote{A note.}}
\\label{sec:methods}
See \\cref{fig:a,eq:two} and \\eqref{eq:missing}, \\ref{ch:start}.
\\begin{figure}
  \\caption[short]{A \\textbf{bold} plot of $x$.}
  \\label{fig:a}
\\end{figure}
\\subsection{Details}
\\begin{align}
  a &= b \\label{eq:one} \\\\
  c &= d \\label{eq:two}
\\end{align}
\\begin{table}\\caption{Numbers}\\end{table}
\\label{dup}\\label{dup}
`,
);
// What a build leaves: the root's .aux \@input's the \include'd chapter's .aux.
put(
  "build/.staging/main/main.aux",
  `\\relax
\\newlabel{ch:start}{{1}{1}{Getting Started}{chapter.1}{}}
\\@input{chapters/one.aux}
`,
);
put(
  "build/.staging/main/chapters/one.aux",
  `\\@writefile{toc}{\\contentsline {section}{\\numberline {1.1}Methods}{2}{section.1.1}\\protected@file@percent }
\\newlabel{sec:methods}{{1.1}{2}{Methods}{section.1.1}{}}
\\newlabel{sec:methods@cref}{{[section][1][1]1.1}{[1][2][]2}}
\\newlabel{fig:a}{{1.1}{2}{A plot}{figure.1.1}{}}
\\@writefile{toc}{\\contentsline {subsection}{\\numberline {1.1.1}Details}{2}{subsection.1.1.1}\\protected@file@percent }
\\newlabel{eq:one}{{1.1}{2}{}{equation.1.1}{}}
\\newlabel{eq:two}{{1.2}{2}{}{equation.1.2}{}}
\\@writefile{lot}{\\contentsline {table}{\\numberline {1.1}{\\ignorespaces Numbers}}{2}{table.1.1}\\protected@file@percent }
`,
);

test("items follow \\include in reading order, with levels, plain titles and .aux numbers", () => {
  const o = outline(loadConfig(dir), loadConfig(dir).docs[0]);
  assert.equal(o.doc, "main");
  assert.deepEqual(o.items, [
    { kind: "chapter", level: 1, title: "Getting Started with LaTeX", number: "1", file: "main.tex", line: 4, label: "ch:start" },
    { kind: "section", level: 2, title: "Methods and n runs", number: "1.1", file: "chapters/one.tex", line: 1, label: "sec:methods" },
    { kind: "figure", level: 3, title: "A bold plot of x.", number: "1.1", file: "chapters/one.tex", line: 4, label: "fig:a" },
    { kind: "subsection", level: 3, title: "Details", number: "1.1.1", file: "chapters/one.tex", line: 8 },
    { kind: "equation", level: 4, title: "a = b", number: "1.1", file: "chapters/one.tex", line: 10, label: "eq:one" },
    { kind: "equation", level: 4, title: "c = d", number: "1.2", file: "chapters/one.tex", line: 11, label: "eq:two" },
    { kind: "table", level: 4, title: "Numbers", number: "1.1", file: "chapters/one.tex", line: 13 },
    { kind: "section", level: 2, title: "Unnumbered", file: "main.tex", line: 8 },
  ]);
});

test("problems: undefined refs, missing citations, duplicate and unused labels; comments and verbatim ignored", () => {
  const o = outline(loadConfig(dir), loadConfig(dir).docs[0]);
  assert.deepEqual(o.problems, [
    { kind: "undefined-ref", key: "eq:missing", file: "chapters/one.tex", line: 3 },
    { kind: "missing-citation", key: "ghost2021", file: "main.tex", line: 6 },
    { kind: "duplicate-label", key: "dup", file: "chapters/one.tex", line: 14 },
    { kind: "unused-label", key: "sec:methods", file: "chapters/one.tex", line: 2 },
    { kind: "unused-label", key: "eq:one", file: "chapters/one.tex", line: 10 },
    { kind: "unused-label", key: "dup", file: "chapters/one.tex", line: 14 },
  ]);
});

test("titles keep prose arguments and drop keys, notes and math delimiters", () => {
  assert.equal(plainTitle("Results for \\cite{x} \\textit{fast} builds~\\ref{y}\\footnote{n}: $O(n)$ \\& more"), "Results for fast builds: O(n) & more");
});
