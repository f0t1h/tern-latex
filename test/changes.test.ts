// Fixtures in test/fixtures/review:
//   markup.tex     changes-package markup with nesting, escapes, % comments, verbatim and optional args.
//   main.tex       built with `tectonic -X compile --synctex main.tex`; the synctex Input: path was
//                  rewritten to "./main.tex" so the fixture is machine-independent.
//   annotated.pdf  that PDF plus three annotations added with pdf-lib at word positions taken from
//                  pdfjs text content: a sticky note on "apples" (line 3), a highlight of
//                  "bananas and cherries" (line 4) and a free-text note on "dates" (line 6).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "bun:test";
import { type Config, loadConfig } from "../src/config.ts";
import { commentBody, readPdfNotes, renderReviewSetup, rewrite, scanText, texFiles } from "../src/changes.ts";
import { SyncTex } from "../src/synctex.ts";

const dir = resolve(import.meta.dirname, "fixtures/review");
const markup = readFileSync(join(dir, "markup.tex"), "utf8");

test("scan finds each command with author, line, args and comment key, skipping escapes, comments and verbatim", () => {
  const got = scanText("markup.tex", markup).map(({ change: { id, before, after, ...c } }) => c);
  assert.deepEqual(got, [
    { kind: "added", author: "AK", file: "markup.tex", line: 3, text: "the median" },
    { kind: "deleted", author: "AK", file: "markup.tex", line: 4, text: "sharply", comment: "too strong, see \\S2" },
    { kind: "replaced", author: "omp", file: "markup.tex", line: 6, text: "improve \\{a lot\\}", old: "get better" },
    { kind: "comment", author: "AK", file: "markup.tex", line: 6, text: "Cite the cache paper." },
    { kind: "highlight", author: "BW", file: "markup.tex", line: 8, text: "Nested \\deleted[id=AK]{old} text" },
    { kind: "deleted", author: "AK", file: "markup.tex", line: 8, text: "old" },
    { kind: "added", author: "AK", file: "markup.tex", line: 13, text: "the median" },
    { kind: "comment", author: "BW", file: "markup.tex", line: 15, text: "A whole-line note." },
    { kind: "added", author: undefined, file: "markup.tex", line: 17, text: "anonymous % brace } in a comment\ntext" },
  ]);
});

test("each change carries a few words around it, as the text reads with other changes accepted, within its paragraph", () => {
  const text = [
    "First paragraph ends here.",
    "",
    "We measured \\replaced[id=proof]{the}{teh} median latency of the cache and \\deleted[id=AK]{very} found that the results",
    "\\added[id=proof]{are} better than expected in most cases. % a comment",
    "",
    "Next paragraph.",
  ].join("\n");
  const [first, second, third] = scanText("x.tex", text).map((l) => l.change);
  // Nothing of the other paragraphs, and no markup: neighbouring changes read as accepted.
  // Each side keeps the space that separates it from the change in the source.
  assert.deepEqual([first.before, first.after], ["We measured ", " median latency of the cache …"]);
  assert.deepEqual([second.before, second.after], ["… latency of the cache and ", " found that the results are …"]);
  assert.deepEqual([third.before, third.after], ["… and found that the results ", " better than expected in most …"]);
  // What the reader sees instead of keys: placeholders for citations and references, logos by name, labels gone.
  const keyed = scanText("y.tex", "\\Citet{k} showed \\cref{sec:a}\\label{x}: \\TeX{} \\added[id=proof]{is} fast.").map((l) => l.change)[0];
  assert.equal(keyed.before, "[cite] showed [ref]: TeX ");
  // No space appears between a change and the punctuation right after it.
  assert.equal(scanText("z.tex", "people \\replaced[id=proof]{write}{writes}. Then").map((l) => l.change)[0].after, ". Then");
});

test("ids are stable when other lines move and distinct for repeated identical changes", () => {
  const ids = scanText("markup.tex", markup).map((l) => l.change.id);
  const shifted = scanText("markup.tex", `% new first line\n\n${markup}`).map((l) => l.change.id);
  assert.deepEqual(shifted, ids);
  assert.equal(new Set(ids).size, ids.length, "the two identical \\added{the median} get different ids");
  assert.notDeepEqual(scanText("other.tex", markup).map((l) => l.change.id), ids, "ids include the file");
});

const all = scanText("markup.tex", markup).map((l) => l.span);

test("accept all keeps new text and drops comments without leaving gaps", () => {
  assert.equal(
    rewrite(markup, all, "accept"),
    `\\section{Markup}

We measured the median latency.
Costs fell by 5\\% overall.
% \\added[id=AK]{commented out}
Results improve \\{a lot\\} with caching.
A literal \\\\added{x} is a line break followed by text.
Nested text stays.
\\verb|\\added{verbatim}| is not markup.
\\begin{verbatim}
\\deleted{inside verbatim}
\\end{verbatim}
the median again.

Trailing anonymous % brace } in a comment
text.
`,
  );
});

test("reject all restores old text and drops additions without leaving gaps", () => {
  assert.equal(
    rewrite(markup, all, "reject"),
    `\\section{Markup}

We measured latency.
Costs fell by 5\\% sharply overall.
% \\added[id=AK]{commented out}
Results get better with caching.
A literal \\\\added{x} is a line break followed by text.
Nested old text stays.
\\verb|\\added{verbatim}| is not markup.
\\begin{verbatim}
\\deleted{inside verbatim}
\\end{verbatim}
again.

Trailing.
`,
  );
});

test("resolving an inner change leaves the enclosing one intact", () => {
  const inner = scanText("markup.tex", markup).filter((l) => l.change.kind === "deleted" && l.change.line === 8);
  const out = rewrite(markup, inner.map((l) => l.span), "accept");
  assert.match(out, /^\\highlight\[id=BW\]\{Nested text\} stays\.$/m);
  assert.equal(scanText("markup.tex", out).length, all.length - 1);
});

test("PDF annotations map to their source lines with the marked text", async () => {
  const notes = await readPdfNotes(join(dir, "annotated.pdf"));
  const sync = await SyncTex.load(join(dir, "main.synctex.gz"), dir);
  const mapped = notes.map((n) => ({ line: sync.reverse(n.page, n.x, n.y)?.line, body: commentBody(n) }));
  assert.deepEqual(mapped, [
    { line: 3, body: "Which kind? 50\\% of \\{readers\\} ask\\_" },
    { line: 4, body: "“bananas and cherries,”: fruit list" },
    { line: 6, body: "Also figs \\& nuts" },
  ]);
  // The suite's first pdf.js load; on Windows runners that alone can exceed the 5 s default.
}, 60_000);

test("review setup passes draft/final before the package loads and gives omp a distinct colour", () => {
  const cfg = (review: Config["review"]): Config => ({ review }) as Config;
  const draft = renderReviewSetup(cfg({ authors: [{ id: "AK", name: "Ana K & Co", color: "violet" }, { id: "BW", name: "Bo W" }], final: false }));
  assert.match(draft, /^\\PassOptionsToPackage\{draft\}\{changes\}$/m);
  assert.match(draft, /\\definechangesauthor\[name=\{Ana K \\& Co\}, color=violet\]\{AK\}/);
  const colors = [...draft.matchAll(/color=([^\]]+)\]\{(\w+)\}/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(colors.map((c) => c[0]), ["AK", "BW", "omp", "proof", "dictation"]);
  assert.equal(new Set(colors.map((c) => c[1])).size, 5, `colours must differ: ${JSON.stringify(colors)}`);
  assert.match(renderReviewSetup(cfg({ authors: [], final: true })), /^\\PassOptionsToPackage\{final\}\{changes\}$/m);
});

test("texFiles lists project sources as /-paths, skipping outdir, dot directories and ignored subtrees only", () => {
  const root = mkdtempSync(join(tmpdir(), "ternlatex-texfiles-"));
  try {
    writeFileSync(join(root, "ternlatex.toml"), 'root = "main.tex"\nignore = ["data"]\n');
    for (const f of ["main.tex", "datasheet.tex", "chapters/one.tex", "data/raw.tex", "build/out.tex", ".omp/x.tex", "node_modules/y.tex"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    assert.deepEqual(texFiles(loadConfig(root)), ["chapters/one.tex", "datasheet.tex", "main.tex"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
