import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config.ts";
import type { Hunk } from "../src/proofread.ts";
import { addPending, pendingChanges, resolveReview } from "../src/suggestions.ts";

const TEXT = "\\section{Work}\nI writes LaTeX every day and teh results are good.\n";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(): Config {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-suggestions-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), TEXT);
  mkdirSync(join(dir, "build"));
  return loadConfig(dir);
}

const hunk = (old: string, replacement: string, why: string): Hunk => {
  const start = TEXT.indexOf(old);
  return { file: "main.tex", start, end: start + old.length, old, new: replacement, why, line: 2 };
};

test("pending suggestions follow their text through unrelated edits, and accept edits only the source", async () => {
  const cfg = project();
  await addPending(cfg, [hunk("writes", "write", "agreement"), hunk("teh", "the", "spelling")], new Map([["main.tex", TEXT]]), "proof");
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT); // nothing applied yet

  // The user inserts a paragraph above: suggestions move with their text.
  writeFileSync(join(cfg.dir, "main.tex"), `New intro.\n\n${TEXT}`);
  const items = pendingChanges(cfg);
  expect(items.map((c) => [c.kind, c.old, c.text, c.line, c.comment])).toEqual([
    ["replaced", "writes", "write", 4, "agreement"],
    ["replaced", "teh", "the", 4, "spelling"],
  ]);

  expect(await resolveReview(cfg, items.map((c) => c.id), "accept")).toBe(2);
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(`New intro.\n\n\\section{Work}\nI write LaTeX every day and the results are good.\n`);
  expect(pendingChanges(cfg)).toEqual([]);
});

test("a suggestion whose text the user already changed is not offered and cannot be applied", async () => {
  const cfg = project();
  await addPending(cfg, [hunk("teh", "the", "spelling")], new Map([["main.tex", TEXT]]), "proof");
  writeFileSync(join(cfg.dir, "main.tex"), TEXT.replace("teh results", "these results"));
  expect(pendingChanges(cfg)).toEqual([]);
});

test("reject drops a pending suggestion without touching the source", async () => {
  const cfg = project();
  await addPending(cfg, [hunk("teh", "the", "spelling")], new Map([["main.tex", TEXT]]), "proof");
  const [item] = pendingChanges(cfg);
  expect(await resolveReview(cfg, [item.id], "reject")).toBe(1);
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT);
  expect(pendingChanges(cfg)).toEqual([]);
});

test("accepting one suggestion keeps its neighbours, even when their saved context overlapped it", async () => {
  const cfg = project();
  // "writes" and "teh" are within each other's 30-character context.
  await addPending(cfg, [hunk("writes", "write", "agreement"), hunk("teh", "the", "spelling")], new Map([["main.tex", TEXT]]), "proof");
  const [first, second] = pendingChanges(cfg);
  expect(await resolveReview(cfg, [first.id], "accept")).toBe(1);
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT.replace("writes", "write"));
  expect(pendingChanges(cfg).map((c) => [c.id, c.old, c.text])).toEqual([[second.id, "teh", "the"]]);
  expect(await resolveReview(cfg, [second.id], "accept")).toBe(1);
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT.replace("writes", "write").replace("teh", "the"));
});

test("pending suggestions keep their author: an accepted dictation inserts its text", async () => {
  const cfg = project();
  const at = TEXT.indexOf(" every day");
  const insertion: Hunk = { file: "main.tex", start: at, end: at, old: "", new: " in Tern", why: "", line: 2 };
  await addPending(cfg, [insertion, hunk("teh", "the", "spelling")], new Map([["main.tex", TEXT]]), "dictation");
  const items = pendingChanges(cfg);
  expect(items.map((c) => [c.kind, c.author, c.text])).toEqual([
    ["added", "dictation", " in Tern"],
    ["replaced", "dictation", "the"],
  ]);
  expect(await resolveReview(cfg, [items[0].id], "accept")).toBe(1);
  expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT.replace("LaTeX every", "LaTeX in Tern every"));
});

test("stores written before authors were recorded read as the proofreader's", async () => {
  const cfg = project();
  const item = { id: "p-12345678", file: "main.tex", line: 2, old: "teh", new: "the", why: "", before: "day and ", after: " results" };
  writeFileSync(join(cfg.dir, "build", "suggestions.json"), JSON.stringify({ items: [item] }));
  expect(pendingChanges(cfg).map((c) => c.author)).toEqual(["proof"]);
});
