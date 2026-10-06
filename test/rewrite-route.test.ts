import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder } from "../src/builder.ts";
import { loadConfig } from "../src/config.ts";
import type { RewriteRequest } from "../src/rewrite.ts";
import { type DevServer, startServer } from "../src/server.ts";

const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "The quick brown fox jumps over the lazy dog. It sleeps.",
  "As \\citet{knuth1984} showed, \\TeX{} typesets batch jobs well, and modern engines are fast. Done.",
  "\\end{document}",
  "",
].join("\n");
const dir = mkdtempSync(join(tmpdir(), "ternlatex-rewrite-route-"));
const asked: RewriteRequest[] = [];
let server: DevServer;

beforeAll(async () => {
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), MAIN);
  mkdirSync(join(dir, "build"));
  server = await startServer({
    builder: new Builder(loadConfig(dir)),
    port: 0,
    open: async () => {},
    editor: false,
    agent: () => undefined,
    rewrite: async (req) => {
      asked.push(req);
      return { file: "main.tex", from: req.at, to: req.to ?? req.at, text: "", model: "stub", alternatives: [], rejected: 0 };
    },
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${server.url}${path.slice(1)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

const SPOT = { page: 1, start: { x: 10, y: 10 }, end: { x: 20, y: 10 } };

test("a viewer selection is rewritten exactly where its words are in the source", async () => {
  const r = await post("/rewrite", { ...SPOT, text: "brown fox jumps over", instruction: "  shorter  " });
  expect(r.status).toBe(200);
  const req = asked.at(-1);
  // Line 3 is the sentence; columns are 1-based, the end exclusive.
  expect(req).toMatchObject({ file: join(dir, "main.tex"), at: { line: 3, col: 11 }, to: { line: 3, col: 31 }, instruction: "shorter" });
});

test("a selection whose edges a macro rendered (a citation, \\TeX) is widened to its whole sentence", async () => {
  // The PDF shows \citet{knuth1984} as "Knuth (1984)" and \TeX{} as "TEX".
  const r = await post("/rewrite", { ...SPOT, text: "Knuth (1984) showed, TEX typesets batch jobs well, and modern engines are fast." });
  expect(r.status).toBe(200);
  const line = MAIN.split("\n")[3];
  const sentence = "As \\citet{knuth1984} showed, \\TeX{} typesets batch jobs well, and modern engines are fast.";
  expect(asked.at(-1)).toMatchObject({ at: { line: 4, col: 1 }, to: { line: 4, col: line.indexOf(" Done.") + 1 } });
  expect(line.slice(0, line.indexOf(" Done."))).toBe(sentence);
});

test("a selection whose words aren't in the source is refused, not guessed", async () => {
  const r = await post("/rewrite", { ...SPOT, text: "nothing like this" });
  expect(r.status).toBe(404);
  expect(String(r.data.error)).toContain("select at least two words");
});

test("applying refuses when the passage changed meanwhile and leaves the file alone", async () => {
  const from = { line: 3, col: 11 };
  const to = { line: 3, col: 31 };
  const r = await post("/rewrite/apply", { file: "main.tex", from, to, text: "brown cat jumps over", replacement: "brown fox leaps over" });
  expect(r.status).toBe(409);
  expect(String(r.data.error)).toContain("changed meanwhile");
  expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(MAIN);
});

test("applying refuses files outside the project", async () => {
  const r = await post("/rewrite/apply", { file: "../elsewhere.tex", from: { line: 1, col: 1 }, to: { line: 1, col: 2 }, text: "x", replacement: "y" });
  expect(r.status).toBe(400);
});
