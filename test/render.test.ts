import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPage, renderRegion } from "../src/render.ts";

// A US-letter page (612 × 792 pt) of tectonic output with embedded Type 1 fonts and annotations.
const pdf = resolve(import.meta.dirname, "fixtures/review/annotated.pdf");

test("renderPage gives a PNG sized for the dpi with the page's text drawn on white", async () => {
  const png = await renderPage(pdf, 1, 150);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const img = await loadImage(png);
  assert.deepEqual([img.width, img.height], [Math.round((612 * 150) / 72), Math.round((792 * 150) / 72)]);

  const ctx = createCanvas(img.width, img.height).getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128) dark++;
  assert.deepEqual([px[0], px[1], px[2], px[3]], [255, 255, 255, 255], "paper is white");
  assert.ok(dark > 2000, `expected glyph pixels, got ${dark}`);
});

test("renderPage rejects pages outside the document", async () => {
  await assert.rejects(renderPage(pdf, 2, 72), RangeError);
});

test("renderRegion renders a region clipped to the page at the chosen scale", async () => {
  const { png, region } = await renderRegion(pdf, 1, (w, h) => ({ x: 100, y: h - 50, width: w, height: 200, scale: 2 }));
  assert.deepEqual(region, { x: 100, y: 742, width: 512, height: 50, scale: 2 });
  const img = await loadImage(png);
  assert.deepEqual([img.width, img.height], [1024, 100]);
});
