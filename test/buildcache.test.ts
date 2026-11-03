import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_SIZE, Checksums, entries, find, restore, store } from "../src/buildcache.ts";
import { type Config, docPaths, loadConfig } from "../src/config.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A project whose "compile" writes the staged outputs by hand: the PDF's bytes name the source they came from. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-buildcache-"));
  roots.push(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), "\\input{intro}\n");
  writeFileSync(join(dir, "intro.tex"), "Version A.\n");
  const cfg = loadConfig(dir);
  const doc = cfg.docs[0];
  const p = docPaths(cfg, doc);
  const compile = async (deps = ["main.tex", "intro.tex"]) => {
    const started = Date.now() + 1; // Inputs were written before the compile started.
    mkdirSync(p.staging, { recursive: true });
    writeFileSync(p.staged.pdf, `pdf of ${readFileSync(join(dir, "intro.tex"), "utf8")}`);
    writeFileSync(p.staged.log, "log");
    return store(cfg, doc, { deps, started, diagnostics: [{ severity: "warning", message: "Overfull" }], durationMs: 1000 });
  };
  const hit = () => find(cfg, doc, new Checksums(dir));
  return { dir, cfg, doc, p, compile, hit };
}

test("an edit misses; undoing it, or going back to an earlier variant, finds that build again", async () => {
  const { dir, cfg, doc, p, compile, hit } = project();
  const a = await compile();
  expect(hit()?.key).toBe(a!.key);

  writeFileSync(join(dir, "intro.tex"), "Version B.\n");
  expect(hit()).toBeNull();
  const b = await compile();
  expect(b!.key).not.toBe(a!.key);

  writeFileSync(join(dir, "intro.tex"), "Version A.\n");
  const back = hit();
  expect(back?.key).toBe(a!.key);
  expect(back?.diagnostics).toEqual([{ severity: "warning", message: "Overfull" }]);
  await restore(cfg, doc, back!);
  expect(readFileSync(p.staged.pdf, "utf8")).toBe("pdf of Version A.\n");
});

test("a deleted input, a changed ternlatex.toml or another engine never reuses", async () => {
  const { dir, cfg, doc, compile, hit } = project();
  await compile();
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\noutdir = "build"\n');
  expect(hit()).toBeNull();
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  expect(hit()).not.toBeNull();
  rmSync(join(dir, "intro.tex"));
  expect(hit()).toBeNull();
  writeFileSync(join(dir, "intro.tex"), "Version A.\n");
  expect(find(cfg, { ...doc, engine: "pdflatex" }, new Checksums(dir))).toBeNull();
});

test("an input saved while the build ran is not cached: what the build read is unknown", async () => {
  const { dir, cfg, doc, p } = project();
  mkdirSync(p.staging, { recursive: true });
  writeFileSync(p.staged.pdf, "pdf");
  const started = Date.now() - 10_000;
  utimesSync(join(dir, "intro.tex"), new Date(), new Date()); // modified after `started`
  expect(await store(cfg, doc, { deps: ["main.tex", "intro.tex"], started, diagnostics: [], durationMs: 1 })).toBeNull();
  expect(entries(cfg, doc)).toEqual([]);
});

test(`only the ${CACHE_SIZE} most recently used builds are kept`, async () => {
  const { dir, cfg, doc, compile } = project();
  for (let i = 0; i < CACHE_SIZE + 3; i++) {
    writeFileSync(join(dir, "intro.tex"), `Version ${i}.\n`);
    await compile();
  }
  const kept = entries(cfg, doc);
  expect(kept).toHaveLength(CACHE_SIZE);
  writeFileSync(join(dir, "intro.tex"), "Version 0.\n");
  expect(find(cfg, doc, new Checksums(dir))).toBeNull(); // the oldest went
  writeFileSync(join(dir, "intro.tex"), `Version ${CACHE_SIZE + 2}.\n`);
  expect(find(cfg, doc, new Checksums(dir))).not.toBeNull();
});
