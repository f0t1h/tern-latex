import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import type { Model } from "../src/models.ts";
import { offsetOf, positionOf, rewrite, sentenceAt, validAlternatives } from "../src/rewrite.ts";

const PARA = `We follow Smith et al. in using $x = 1.5$. The method, e.g. the one in Fig.~\\ref{fig:a}, is fast
\\citep{knuth1984}. Results vary! % a comment. Not a sentence
\\Cref{tab:x} shows why. Finally it ends`;

/** The sentence of PARA that contains the first occurrence of NEEDLE. */
function sentenceOf(needle: string): string {
  const [s, e] = sentenceAt(PARA, PARA.indexOf(needle));
  return PARA.slice(s, e);
}

test("sentences end at . ? ! before a capital or command, not after abbreviations, inside math or in comments", () => {
  assert.equal(sentenceOf("follow"), "We follow Smith et al. in using $x = 1.5$.");
  assert.equal(sentenceOf("method"), "The method, e.g. the one in Fig.~\\ref{fig:a}, is fast\n\\citep{knuth1984}.");
  assert.equal(sentenceOf("vary"), "Results vary!");
  assert.equal(sentenceOf("shows"), "\\Cref{tab:x} shows why.");
  assert.equal(sentenceOf("Finally"), "Finally it ends");
});

test("a caret just after a sentence's period belongs to that sentence", () => {
  const end = PARA.indexOf("1.5$.") + "1.5$.".length;
  const [s, e] = sentenceAt(PARA, end);
  assert.equal(PARA.slice(s, e), "We follow Smith et al. in using $x = 1.5$.");
});

test("positions count Unicode characters, not UTF-16 units", () => {
  const text = "a😀b\nsecond";
  assert.equal(offsetOf(text, { line: 1, col: 3 }), 3);
  assert.deepEqual(positionOf(text, 3), { line: 1, col: 3 });
  assert.deepEqual(positionOf(text, text.indexOf("second")), { line: 2, col: 1 });
  assert.throws(() => offsetOf(text, { line: 1, col: 5 }));
});

test("alternatives must keep the protected spans and structure; no-ops and malformed ones are dropped", () => {
  const original = "As \\citet{k} showed, $a$ is \\emph{big}.";
  const reply = `Here you go: ${JSON.stringify([
    { text: "\\citet{k} showed that $a$ is \\emph{large}.", note: "smoother" },
    { text: "As \\citet{k} showed, $b$ is \\emph{big}.", note: "math changed" },
    { text: "As \\citet{k} showed, $a$ is big.", note: "command dropped" },
    { text: "As \\citet{k} showed, $a$ is \\emph{big} {really}.", note: "braces added" },
    { text: original, note: "same" },
    { note: "no text" },
  ])}`;
  assert.deepEqual(validAlternatives(original, reply), { alternatives: [{ text: "\\citet{k} showed that $a$ is \\emph{large}.", note: "smoother" }], rejected: 4 });
  assert.throws(() => validAlternatives(original, "sorry, no"));
});

const dir = mkdtempSync(join(tmpdir(), "ternlatex-rewrite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "ternlatex.toml"), `root = "main.tex"\n[rewrite]\ncount = 2\n`);
writeFileSync(join(dir, "main.tex"), `\\documentclass{article}\n\\begin{document}\nFirst one. Ünïcode sentence\nspans two lines. Last.\n\\end{document}\n`);

/** A model that answers every call with REPLY (and keeps the last input). */
function stub(reply: string): Model & { seen: string } {
  const m = {
    name: "@stub",
    seen: "",
    ask: async (_system: string, input: string) => {
      m.seen = input;
      return reply;
    },
  };
  return m;
}

test("rewrite targets the sentence at the caret and reports its exact range and alternatives", async () => {
  const cfg = loadConfig(dir);
  const model = stub(JSON.stringify([{ text: "A Ünïcode sentence\nacross two lines.", note: "clearer" }]));
  const r = await rewrite(cfg, { file: join(dir, "main.tex"), at: { line: 4, col: 3 }, count: cfg.rewrite.count, instruction: "be brief" }, model);
  assert.deepEqual(r, {
    file: "main.tex",
    from: { line: 3, col: 12 },
    to: { line: 4, col: 17 },
    text: "Ünïcode sentence\nspans two lines.",
    model: "@stub",
    alternatives: [{ text: "A Ünïcode sentence\nacross two lines.", note: "clearer" }],
    rejected: 0,
  });
  assert.match(model.seen, /Number of alternatives: 2/);
  assert.match(model.seen, /be brief/);
});

test("rewrite with --to uses the selection verbatim, whitespace included", async () => {
  const cfg = loadConfig(dir);
  const r = await rewrite(cfg, { file: join(dir, "main.tex"), at: { line: 3, col: 1 }, to: { line: 3, col: 12 }, count: 4 }, stub(JSON.stringify([{ text: "Initial one.", note: "x" }])));
  assert.equal(r.text, "First one. ");
  assert.deepEqual(r.alternatives, [{ text: "Initial one. ", note: "x" }]);
});

test("a caret outside prose is an error", async () => {
  const cfg = loadConfig(dir);
  await assert.rejects(rewrite(cfg, { file: join(dir, "main.tex"), at: { line: 1, col: 1 }, count: 4 }, stub("[]")), /not in a prose paragraph/);
});
