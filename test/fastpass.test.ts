import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder, type Status } from "../src/builder.ts";
import { docPaths, loadConfig } from "../src/config.ts";
import { clearToolCache } from "../src/tools.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-fastpass-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in Tectonic. Its .aux holds a \newlabel per \label, a list-of-changes line per \deleted and a pgf
 * position that differs on every run (as todonotes' do). A full run writes "full" into the PDF; a one-pass run
 * (`--reruns 0`, the seed on `-Z search-path`) writes "fast".
 */
const FAKE = `
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const fs = require("node:fs");
const path = require("node:path");
const out = at("--outdir");
const tex = fs.readFileSync("main.tex", "utf8");
const aux = [
  ...[...tex.matchAll(/\\\\label\\{([^}]*)\\}/g)].map((m) => "\\\\newlabel{" + m[1] + "}{{1}{1}}"),
  ...[...tex.matchAll(/\\\\deleted\\{([^}]*)\\}/g)].map((m) => "\\\\@writefile{loc}{\\\\contentsline {deleted}{" + m[1] + "}}"),
  "\\\\pgfsyspdfmark {pgfid1}{" + Math.floor(Math.random() * 1e6) + "}{1}",
  "\\\\gdef \\\\@abspage@last{1}",
].join("\\n") + "\\n";
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "main.pdf"), args.includes("--reruns") ? "fast" : "full");
fs.writeFileSync(path.join(out, "main.aux"), aux);
fs.writeFileSync(path.join(out, "main.log"), "");
fs.writeFileSync(at("--makefile-rules"), "main.pdf: main.tex\\n");
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

describe("one-pass builds", () => {
  let dir: string;
  const DOC = (body: string) => `\\documentclass{article}\\begin{document}\n${body}\n\\end{document}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(root, "project-"));
    writeFileSync(join(dir, "main.tex"), DOC("Some text."));
    writeFileSync(join(dir, "ternlatex.toml"), `root = "main.tex"\ncheckpoints = false\n[tools]\ntectonic = ${JSON.stringify(fakeTectonic(dir))}\n`);
    clearToolCache();
  });

  async function build(builder: Builder, body: string): Promise<{ status: Status; pdf: string; revs: number[] }> {
    writeFileSync(join(dir, "main.tex"), DOC(body));
    const revs: number[] = [];
    const seen = (s: Status) => revs.push(s.rev);
    builder.on("status", seen);
    const [status] = await builder.request();
    builder.off("status", seen);
    const cfg = builder.cfg;
    return { status, pdf: readFileSync(docPaths(cfg, cfg.docs[0]).pdf, "utf8"), revs: [...new Set(revs)] };
  }

  test("a strike-through or a reworded sentence is one pass; a new label shows the one-pass PDF, then the full build's", async () => {
    const builder = new Builder(loadConfig(dir));
    // The first build has no references to start from.
    expect((await build(builder, "Some text."))).toMatchObject({ status: { ok: true, fast: false }, pdf: "full" });
    // Marks change only the list of changes (the document doesn't print one) and pgf's positions.
    expect(await build(builder, "Some \\deleted{old} text.")).toMatchObject({ status: { ok: true, fast: true }, pdf: "fast" });
    expect(await build(builder, "Some \\deleted{old} text, reworded.")).toMatchObject({ status: { fast: true }, pdf: "fast" });
    const label = await build(builder, "Some \\deleted{old} text.\\label{sec:x}");
    expect(label).toMatchObject({ status: { ok: true, fast: false }, pdf: "full" });
    // Two new PDFs: the one-pass one at once, then the settled one (revisions from the "building" status on).
    expect(label.revs[label.revs.length - 1] - label.revs[0]).toBe(2);
  });

  test("a document printing \\listofchanges builds fully when the list changes", async () => {
    const builder = new Builder(loadConfig(dir));
    await build(builder, "\\listofchanges Some text.");
    expect(await build(builder, "\\listofchanges Some \\deleted{old} text.")).toMatchObject({ status: { fast: false }, pdf: "full" });
    expect(await build(builder, "\\listofchanges Some \\deleted{old} text, reworded.")).toMatchObject({ status: { fast: true }, pdf: "fast" });
  });
});
