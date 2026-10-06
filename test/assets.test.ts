import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { assetBytes, assetText, copyAssets, listAssets } from "../src/assets.ts";

const tmp = mkdtempSync(join(tmpdir(), "ternlatex-assets-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("listAssets lists files under a prefix, sorted, with and without the trailing slash", () => {
  const article = listAssets("templates/article/");
  assert.ok(article.includes("templates/article/main.tex"));
  assert.ok(article.includes("templates/article/sections/introduction.tex"));
  assert.deepEqual(article, [...article].sort());
  assert.deepEqual(listAssets("templates/article"), article);
  assert.deepEqual(listAssets("viewer/"), ["viewer/index.html", "viewer/viewer.css", "viewer/viewer.js"]);
});

test("pdf.js prefixes map into pdfjs-dist and ship only the browser build files", () => {
  assert.deepEqual(listAssets("pdfjs/"), ["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]);
  assert.ok(listAssets("pdfjs-cmaps/").includes("pdfjs-cmaps/78-H.bcmap"));
  assert.ok(listAssets("pdfjs-fonts/").includes("pdfjs-fonts/FoxitSerif.pfb"));
});

test("the plugin package root ships plugin.toml and tern-plugin/ from the repo root, nothing else", async () => {
  const pkg = listAssets("tern-package/");
  assert.ok(pkg.includes("tern-package/plugin.toml"));
  assert.ok(pkg.includes("tern-package/tern-plugin/window.luau"));
  assert.ok(pkg.every((f) => f === "tern-package/plugin.toml" || f.startsWith("tern-package/tern-plugin/")), pkg.join(", "));
  assert.ok(!pkg.some((f) => f.endsWith("/config.json")));
  assert.deepEqual(listAssets("tern-package/tern-plugin"), pkg.filter((f) => f.startsWith("tern-package/tern-plugin/")));
  assert.match((await assetText("tern-package/tern-plugin/keys.json")) ?? "", /"commands"/);
  for (const bad of ["tern-package/package.json", "tern-package/src/cli.ts", "tern-package/config.json"]) assert.equal(await assetBytes(bad), null, bad);
  assert.deepEqual(listAssets("tern-package/src"), []);
});

test("assetBytes/assetText read shipped files and refuse unknown roots and escapes", async () => {
  assert.match((await assetText("viewer/index.html")) ?? "", /<html/i);
  assert.ok(((await assetBytes("pdfjs/pdf.min.mjs")) ?? new Uint8Array()).length > 100_000);
  for (const bad of ["viewer/../package.json", "viewer/", "src/cli.ts", "pdfjs/pdf.mjs", "pdfjs-cmaps/../package.json", "viewer/nope.js"]) {
    assert.equal(await assetBytes(bad), null, bad);
  }
  assert.deepEqual(listAssets("viewer/../src"), []);
  assert.deepEqual(listAssets("nope/"), []);
});

test("copyAssets copies a prefix's files below dest and keeps existing files unless forced", async () => {
  const dest = join(tmp, "copy");
  const written = await copyAssets("templates/article/", dest);
  assert.ok(written.includes(join(dest, "sections", "results.tex")));
  assert.equal(readFileSync(join(dest, "main.tex"), "utf8"), await assetText("templates/article/main.tex"));

  writeFileSync(join(dest, "main.tex"), "mine");
  assert.ok(!(await copyAssets("templates/article", dest)).includes(join(dest, "main.tex")));
  assert.equal(readFileSync(join(dest, "main.tex"), "utf8"), "mine");
  assert.ok((await copyAssets("templates/article", dest, { force: true })).includes(join(dest, "main.tex")));
  assert.notEqual(readFileSync(join(dest, "main.tex"), "utf8"), "mine");
  assert.ok(!existsSync(join(dest, "article")));
});
