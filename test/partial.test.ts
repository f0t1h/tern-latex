import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder } from "../src/builder.ts";
import { docPaths, loadConfig } from "../src/config.ts";
import { missingFiles, pdfPlaceholder, texPlaceholder } from "../src/placeholders.ts";
import { readPdfText } from "../src/search.ts";
import { clearToolCache } from "../src/tools.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-partial-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("missingFiles", () => {
  test("names the project's missing figures and \\input files, not packages, paths outside, or TeX's prompt", () => {
    const err = (message: string) => ({ severity: "error" as const, file: "main.tex", line: 3, message });
    expect(
      missingFiles([
        err("LaTeX Error: File `figs/plot' not found."),
        err("! LaTeX Error: File `sections/intro.tex' not found."),
        { severity: "warning", message: "File `figs/photo.png' not found" },
        err("LaTeX Error: File `fancything.sty' not found."),
        err("LaTeX Error: File `../outside.pdf' not found."),
        err("LaTeX Error: File `/abs/fig.pdf' not found."),
        err("! LaTeX Error: File `.' not found."),
        err("LaTeX Error: File `figs/plot' not found"),
        err("Undefined control sequence"),
      ]),
    ).toEqual(["figs/plot", "sections/intro.tex", "figs/photo.png"]);
  });
});

describe("placeholders", () => {
  test("a missing figure is a one-page PDF naming it", async () => {
    const file = join(root, "placeholder.pdf");
    writeFileSync(file, pdfPlaceholder("figs/a (draft)\\b.pdf"));
    const text = await readPdfText(file);
    expect(text.pages).toHaveLength(1);
    expect(text.pages[0]).toContain("Missing figure");
    expect(text.pages[0]).toContain("figs/a (draft)\\b.pdf");
  });

  test("a missing \\input is a framed line naming it, safe to typeset", () => {
    expect(texPlaceholder("sections/a_b{c}.tex")).toBe("\\par\\noindent\\fbox{\\ttfamily Missing file: \\detokenize{sections/a_bc.tex}}\\par\n");
  });
});

/**
 * A stand-in Tectonic: a document needing figs/plot. Without the file it fails like Tectonic; with
 * `-Z continue-on-errors` and the figure on its `-Z search-path` it writes a PDF saying so.
 */
const FAKE = `
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const fs = require("node:fs");
const path = require("node:path");
const out = at("--outdir");
const search = args.filter((a) => a.startsWith("search-path=")).map((a) => a.slice("search-path=".length));
const write = (pdf) => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "main.pdf"), pdf);
  fs.writeFileSync(path.join(out, "main.log"), "");
  fs.writeFileSync(at("--makefile-rules"), "main.pdf: main.tex\\n");
};
if (fs.existsSync("figs/plot.pdf")) { write("complete"); process.exit(0); }
if (args.includes("continue-on-errors") && search.some((d) => fs.existsSync(path.join(d, "figs/plot.pdf")))) { write("partial"); process.exit(0); }
console.log("error: main.tex:3: LaTeX Error: File \`figs/plot' not found.");
process.exit(1);
`;

function fakeTectonic(dir: string): string {
  const script = join(dir, "fake-tectonic.cjs");
  writeFileSync(script, FAKE);
  if (process.platform === "win32") {
    const cmd = join(dir, "tectonic.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, "tectonic");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe("a build with a missing figure", () => {
  let dir: string;
  const project = (extra = "") => {
    writeFileSync(join(dir, "ternlatex.toml"), `root = "main.tex"\ncheckpoints = false\n${extra}[tools]\ntectonic = ${JSON.stringify(fakeTectonic(dir))}\n`);
    return loadConfig(dir);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(root, "project-"));
    writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\\begin{document}\\includegraphics{figs/plot}\\end{document}\n");
    clearToolCache();
  });

  test("publishes a partial PDF with the figure as a placeholder, then the full one once the figure arrives", async () => {
    const cfg = project();
    const builder = new Builder(cfg);
    const [partial] = await builder.request();
    expect(partial).toMatchObject({ ok: false, partial: true, placeholders: ["figs/plot"], rev: 1 });
    expect(partial.diagnostics.map((d) => d.message)).toContain("LaTeX Error: File `figs/plot' not found.");
    expect(readFileSync(docPaths(cfg, cfg.docs[0]).pdf, "utf8")).toBe("partial");

    // Not reused from the build cache: the same sources compile again.
    const [again] = await builder.request();
    expect(again).toMatchObject({ partial: true, cached: false, rev: 2 });

    mkdirSync(join(dir, "figs"));
    writeFileSync(join(dir, "figs", "plot.pdf"), "figure");
    const [full] = await builder.request();
    expect(full).toMatchObject({ ok: true, partial: false, rev: 3 });
    expect(full.placeholders).toBeUndefined();
    expect(readFileSync(docPaths(cfg, cfg.docs[0]).pdf, "utf8")).toBe("complete");
  });

  test("partial = false keeps the last good PDF instead", async () => {
    const cfg = project("partial = false\n");
    const [failed] = await new Builder(cfg).request();
    expect(failed).toMatchObject({ ok: false, partial: false, rev: 0 });
    expect(existsSync(docPaths(cfg, cfg.docs[0]).pdf)).toBe(false);
  });
});
