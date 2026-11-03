import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfWords } from "../src/align.ts";
import { loadConfig } from "../src/config.ts";
import { latexmkArgs, missingPackages, recordedDeps } from "../src/latexmk.ts";
import { fold } from "../src/search.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-engines-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(toml: string, files: string[] = ["main.tex"]): string {
  const dir = mkdtempSync(join(root, "p-"));
  writeFileSync(join(dir, "ternlatex.toml"), toml);
  for (const f of files) writeFileSync(join(dir, f), "\\documentclass{article}\\begin{document}x\\end{document}\n");
  return dir;
}

describe("engines", () => {
  test("a project's engine applies to its documents unless one names its own; the old latexmk value says what replaced it", () => {
    const dir = project('engine = "pdflatex"\n[[documents]]\nroot = "main.tex"\n[[documents]]\nroot = "slides.tex"\nengine = "xelatex"\n', ["main.tex", "slides.tex"]);
    expect(loadConfig(dir).docs.map((d) => [d.name, d.engine])).toEqual([
      ["main", "pdflatex"],
      ["slides", "xelatex"],
    ]);
    expect(loadConfig(project('root = "main.tex"\n')).docs[0].engine).toBe("tectonic");
    expect(() => loadConfig(project('engine = "latexmk"\n'))).toThrow(/"pdflatex", "xelatex" or "lualatex"/);
    expect(() => loadConfig(project('engine = "context"\n'))).toThrow(/must be one of/);
  });

  test("latexmk runs the chosen engine, records its inputs, and gives pdfLaTeX's text Unicode (cmap)", () => {
    const cfg = loadConfig(project('engine = "pdflatex"\nlatexmk_args = ["-shell-escape"]\n'));
    const pdf = latexmkArgs(cfg, cfg.docs[0], "/s", "pdflatex");
    expect(pdf[0]).toBe("-pdf");
    expect(pdf).toContain("-shell-escape");
    expect(pdf).toContain("-recorder");
    expect(pdf).toContain("-jobname=main");
    expect(pdf).toContain("-usepretex=\\RequirePackage{cmap}");
    expect(pdf.at(-1)).toBe("main.tex");
    const xe = latexmkArgs(cfg, cfg.docs[0], "/s", "xelatex");
    expect(xe[0]).toBe("-pdfxe");
    expect(xe.some((a) => a.includes("cmap"))).toBe(false);
    expect(latexmkArgs(cfg, cfg.docs[0], "/s", "lualatex")[0]).toBe("-pdflua");
  });

  test("the files a latexmk run read: the project's, not its outputs or the distribution's", () => {
    const dir = mkdtempSync(join(root, "fls-"));
    mkdirSync(join(dir, "sections"));
    mkdirSync(join(dir, "build"));
    for (const f of ["main.tex", "sections/intro.tex", "build/main.aux"]) writeFileSync(join(dir, f), "");
    const fls = [`PWD ${dir}`, "INPUT /usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls", "INPUT main.tex", `INPUT ${join(dir, "sections/intro.tex")}`, "INPUT build/main.aux", "OUTPUT build/main.pdf", "INPUT main.tex"].join("\n");
    expect(recordedDeps(fls, dir, "build")).toEqual(["main.tex", "sections/intro.tex"]);
  });

  test("missing packages are named from the errors", () => {
    const err = (message: string) => ({ severity: "error" as const, message });
    expect(missingPackages([err("LaTeX Error: File `lettrine.sty' not found."), err("LaTeX Error: File `figs/a.pdf' not found."), err("File `llncs.cls' not found")])).toEqual(["lettrine.sty", "llncs.cls"]);
  });

  test("pdfLaTeX's classic accents (a spacing mark before the letter) match accented words", () => {
    expect(pdfWords("caf´e and na¨ıve, Karao˘glano˘glu")).toEqual(["cafe", "and", "naive", "karaoglanoglu"]);
    expect(fold("Karao˘glano˘glu")).toBe(fold("Karaoğlanoğlu"));
  });
});
