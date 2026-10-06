// Fixture: test/fixtures/synctex/main.synctex.gz was produced by
//   tectonic -X compile --synctex --keep-logs --outdir out main.tex
// in test/fixtures/synctex, with the Input: paths afterwards rewritten from absolute to
// "./main.tex" and "sub" (forms Tectonic also emits) so the fixture is machine-independent.
// Word coordinates below are bbox centres measured with `pdftotext -bbox out/main.pdf -`
// (PDF points, top-left origin).

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { SyncTex } from "../src/synctex.ts";

const dir = resolve(import.meta.dirname, "fixtures/synctex");
const MAIN = join(dir, "main.tex");
const SUB = join(dir, "sub.tex");

interface Word { word: string; page: number; x: number; y: number; file: string; line: number }

const WORDS: Word[] = [
  { word: "Alpha", page: 1, x: 146.919, y: 153.547, file: MAIN, line: 5 },
  // Third output line of a wrapped paragraph whose hbox is tagged with the paragraph-end line 10.
  { word: "lookup", page: 1, x: 181.280, y: 177.458, file: MAIN, line: 8 },
  // Last word of a paragraph: the following \par node belongs to blank line 10.
  { word: "here.", page: 1, x: 353.086, y: 189.413, file: MAIN, line: 9 },
  { word: "Hippogriff.", page: 1, x: 291.572, y: 201.368, file: SUB, line: 1 },
  { word: "Basilisk.", page: 1, x: 436.404, y: 201.368, file: SUB, line: 2 },
  { word: "Zebra", page: 1, x: 167.158, y: 225.139, file: MAIN, line: 16 },
  { word: "mc", page: 1, x: 283.891, y: 248.362, file: MAIN, line: 22 },
  { word: "Quokka.", page: 2, x: 281.763, y: 131.716, file: MAIN, line: 25 },
  { word: "Narwhal.", page: 2, x: 348.234, y: 143.671, file: MAIN, line: 27 },
];

const synctex = await SyncTex.load(join(dir, "main.synctex.gz"), dir);

for (const w of WORDS) {
  test(`reverse(${w.word}) -> ${w.file === SUB ? "sub" : "main"}.tex:${w.line}`, () => {
    assert.deepEqual(synctex.reverse(w.page, w.x, w.y), { file: w.file, line: w.line });
  });

  test(`forward(${w.file === SUB ? "sub" : "main"}.tex:${w.line}) contains ${w.word}`, () => {
    const box = synctex.forward(w.file, w.line);
    assert.ok(box, "expected a box");
    assert.equal(box.page, w.page);
    assert.ok(box.x <= w.x && w.x <= box.x + box.width, `x ${w.x} outside ${JSON.stringify(box)}`);
    assert.ok(box.y <= w.y && w.y <= box.y + box.height, `y ${w.y} outside ${JSON.stringify(box)}`);
  });
}

test("hbox left edge and baseline match pdftotext within 0.01pt", () => {
  // "Alpha" starts the text block: pdftotext xMin 133.768370. Its line's baseline lies inside
  // the glyph bbox (148.566..158.529), so the box must start there and span the glyphs' height.
  const box = synctex.forward(MAIN, 5);
  assert.ok(box);
  assert.ok(Math.abs(box.x - 133.76837) < 0.01, `x ${box.x}`);
  assert.ok(box.y > 148 && box.y + box.height < 159, `y range ${box.y}..${box.y + box.height}`);
});

test("forward of a line without records falls forward to the next line that has some", () => {
  // Line 3 is \begin{document}; line 4 is the \section heading ("Introduction" centre).
  const box = synctex.forward(MAIN, 3);
  assert.ok(box);
  assert.equal(box.page, 1);
  assert.ok(box.x <= 200.62 && 200.62 <= box.x + box.width);
  assert.ok(box.y <= 130.37 && 130.37 <= box.y + box.height);
});

test("reverse outside every box picks the nearest line", () => {
  // Right margin of page 2, level with "Narwhal.".
  assert.deepEqual(synctex.reverse(2, 550, 143.671), { file: MAIN, line: 27 });
});

test("unknown file, page or out-of-range line yields null", () => {
  assert.equal(synctex.forward(join(dir, "missing.tex"), 5), null);
  assert.equal(synctex.forward(SUB, 100), null);
  assert.equal(synctex.reverse(3, 100, 100), null);
});

test("forwardLines spans the whole typeset line of the column, even from a nested box", () => {
  // Two columns of 15000000 sp at x = 4736286 and 20000000 sp; line 12 is an \mbox inside a right-column line.
  const sp = (n: number) => n / 65781.76;
  const two = SyncTex.parse(
    [
      "SyncTeX Version:1", "Input:1:./main.tex", "Output:pdf", "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:",
      "{1",
      "[1,1:0,0:39790000,51800000,0",
      "[1,1:4736286,4736286:15000000,40000000,0", "(1,3:4736286,6000000:15000000,650000,0", "g1,3:6000000,6000000", ")", "]",
      "[1,1:20000000,4736286:15000000,40000000,0", "(1,10:20000000,6000000:15000000,650000,0", "(1,12:22000000,6000000:2000000,650000,0", ")", "g1,10:25000000,6000000", ")", "]",
      "]",
      "}1",
    ].join("\n"),
    dir,
  );
  const box = two.forward(MAIN, 12);
  const lines = two.forwardLines(MAIN, 12);
  assert.ok(box && lines);
  assert.ok(Math.abs(box.width - sp(2000000)) < 0.01, `box width ${box.width}`);
  assert.ok(Math.abs(lines.x - sp(20000000)) < 0.01 && Math.abs(lines.width - sp(15000000)) < 0.01, `lines ${JSON.stringify(lines)}`);
  const left = two.forwardLines(MAIN, 3);
  assert.ok(left && Math.abs(left.x - sp(4736286)) < 0.01 && Math.abs(left.width - sp(15000000)) < 0.01, `left ${JSON.stringify(left)}`);
  assert.equal(two.forwardLines(SUB, 1), null);
});
