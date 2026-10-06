import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyHunks, hunksFor, paragraphs, protectedSpans, replyArray } from "../src/proofread.ts";

const SOURCE = `\\documentclass{article}
\\title{A Title}
\\begin{document}
Fast feedback change how people writes, see~\\citep{knuth1984}. % a coment here
Second line of the same paragrah.

\\begin{equation}
  E = mc^2 \\label{eq:teh}
\\end{equation}

Another paragraph with $x = teh$ math.
\\end{document}
`;

test("paragraphs skip the preamble and non-prose environments", () => {
  const ps = paragraphs(SOURCE, "main.tex");
  assert.deepEqual(
    ps.map((p) => [p.line, p.text.split("\n")[0].slice(0, 20)]),
    [
      [4, "Fast feedback change"],
      [11, "Another paragraph wi"],
    ],
  );
  assert.equal(SOURCE.slice(ps[0].start, ps[0].end), ps[0].text);
});

test("a sentence-level suggestion becomes minimal word hunks, written as tracked changes", () => {
  const [p] = paragraphs(SOURCE, "main.tex");
  const r = hunksFor(p, { find: "Fast feedback change how people writes", replace: "Fast feedback changes how people write", why: "agreement" }, protectedSpans(p.text));
  assert.ok(Array.isArray(r));
  assert.deepEqual(
    r.map((h) => [h.old, h.new, h.line]),
    [
      ["change", "changes", 4],
      ["writes", "write", 4],
    ],
  );
  const out = applyHunks(SOURCE, r, false, "proof");
  assert.match(out, /Fast feedback \\replaced\[id=proof,comment=\{agreement\}\]\{changes\}\{change\} how people \\replaced\[id=proof,comment=\{agreement\}\]\{write\}\{writes\},/);
  assert.equal(applyHunks(SOURCE, r, true, "proof").split("\n")[3].startsWith("Fast feedback changes how people write,"), true);
});

test("edits touching keys, labels, math or comments are refused", () => {
  const ps = paragraphs(SOURCE, "main.tex");
  const [p, q] = ps;
  const spans = protectedSpans(p.text);
  assert.equal(hunksFor(p, { find: "knuth1984", replace: "knuth1985", why: "" }, spans), "touches LaTeX markup");
  assert.equal(hunksFor(p, { find: "coment", replace: "comment", why: "" }, spans), "touches LaTeX markup");
  assert.equal(hunksFor(q, { find: "teh", replace: "the", why: "" }, protectedSpans(q.text)), "touches LaTeX markup");
  assert.equal(hunksFor(p, { find: "paragrah", replace: "paragraph \\emph{x}", why: "" }, spans), "structural characters");
  // Prose next to markup is still fixable.
  const ok = hunksFor(p, { find: "paragrah", replace: "paragraph", why: "spelling" }, spans);
  assert.ok(Array.isArray(ok) && ok[0].line === 5);
});

test("ambiguous or invented find strings are refused", () => {
  const [p] = paragraphs(SOURCE, "main.tex");
  const spans = protectedSpans(p.text);
  assert.equal(hunksFor(p, { find: "e", replace: "a", why: "" }, spans), "find ambiguous");
  assert.equal(hunksFor(p, { find: "not there", replace: "x", why: "" }, spans), "find not in paragraph");
});

test("text inside unknown macros (moderncv's \\cventry) is prose; data-like arguments stay protected", () => {
  const src = "\\begin{document}\n\\cventry{Jan 2019 -- 2024}{PhD in Computng Science}{Example University}{}{}{Advisor: Dr.\\ Example}\n\\email{me@example.org} \\href{https://example.org}{my home page}\n\\end{document}\n";
  const [p] = paragraphs(src, "cv.tex");
  const spans = protectedSpans(p.text);
  const fix = hunksFor(p, { find: "Computng", replace: "Computing", why: "spelling" }, spans);
  assert.ok(Array.isArray(fix) && fix[0].new === "Computing");
  assert.equal(hunksFor(p, { find: "2019", replace: "2020", why: "" }, spans), "numbers, addresses or paths");
  assert.equal(hunksFor(p, { find: "me@example", replace: "me@exemple", why: "" }, spans), "touches LaTeX markup");
  assert.equal(hunksFor(p, { find: "https://example", replace: "https://exampel", why: "" }, spans), "touches LaTeX markup");
  const text = hunksFor(p, { find: "my home page", replace: "my homepage", why: "" }, spans);
  assert.ok(Array.isArray(text), "href's text argument is prose");
});

test("a model reply yields its suggestion list whether bare, fenced or wrapped in prose; anything else is unreadable", () => {
  const one = [{ find: "teh", replace: "the", why: "spelling" }];
  assert.deepEqual(replyArray(JSON.stringify(one)), one);
  assert.deepEqual(replyArray("```json\n" + JSON.stringify(one) + "\n```"), one);
  assert.deepEqual(replyArray(`Here are the fixes: ${JSON.stringify(one)} Hope this helps.`), one);
  assert.deepEqual(replyArray("[]"), []);
  assert.equal(replyArray('[{"find": "teh", "replace": "the"'), null);
  assert.equal(replyArray("The paragraph has no errors."), null);
});
