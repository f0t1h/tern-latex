import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { type DocConfig, docPaths, loadConfig, paths, posix, resolveDoc, UsageError } from "../config.ts";
import { renderRegion } from "../render.ts";
import { type PdfBox, SyncTex } from "../synctex.ts";
import { parseLocation } from "./project.ts";

/** Margin above and below the source line's box, in typeset lines. */
const MARGIN_LINES = 4;
/** Fallback line height (pt) when the box is shorter than a line. */
const MIN_LINE = 12;
/** Horizontal padding (pt) around the text block. */
const PAD_X = 6;

/** JSON result of `peek --json`. */
export interface PeekResult {
  png: string;
  doc: string;
  page: number;
  /** The rendered region in PDF points from the page's top-left corner. */
  box: { x: number; y: number; width: number; height: number };
}

/**
 * `peek FILE:LINE [--doc NAME] [--width PX] [--json]`: renders the part of the last good PDF around a source
 * line — full text-block (column) width, the line's box ± a few lines — to <outdir>/peek/<doc>.png.
 */
export async function peek(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { doc: { type: "string" }, width: { type: "string", default: "900" }, json: { type: "boolean", default: false } } });
  if (positionals.length !== 1) throw new UsageError("peek needs FILE:LINE");
  const width = Number(values.width);
  if (!Number.isInteger(width) || width < 50 || width > 8000) throw new UsageError(`--width must be an integer from 50 to 8000, got "${values.width}"`);
  const cfg = loadConfig();
  const loc = parseLocation(positionals[0]);
  let found: { doc: DocConfig; box: PdfBox; lines: PdfBox | null } | undefined;
  for (const doc of values.doc ? [resolveDoc(cfg, values.doc)] : cfg.docs) {
    const st = docPaths(cfg, doc).synctex;
    if (!existsSync(st)) continue;
    const sync = await SyncTex.load(st, cfg.dir);
    const box = sync.forward(loc.file, loc.line);
    if (box) {
      found = { doc, box, lines: sync.forwardLines(loc.file, loc.line) };
      break;
    }
  }
  const docName = resolveDoc(cfg, values.doc).name;
  if (!found) {
    console.error(`ternlatex: line ${loc.line} of ${posix(relative(cfg.dir, loc.file))} is not in ${docName}.pdf`);
    return 1;
  }
  const { doc, box, lines } = found;
  const pdf = docPaths(cfg, doc).pdf;
  if (!existsSync(pdf)) throw new UsageError(`no PDF for ${doc.name} yet; run \`ternlatex build\``);
  const lineHeight = Math.max(MIN_LINE, Math.min(box.height, 3 * MIN_LINE));
  const { png, region } = await renderRegion(pdf, box.page, (pageWidth) => {
    // The column's typeset lines give the text-block width (one column of a multi-column page); else the whole page.
    const x = lines && lines.page === box.page ? lines.x - PAD_X : 0;
    const w = lines && lines.page === box.page ? lines.width + 2 * PAD_X : pageWidth;
    const y = box.y - MARGIN_LINES * lineHeight;
    return { x, y, width: w, height: box.height + 2 * MARGIN_LINES * lineHeight, scale: width / w };
  });
  const out = join(paths(cfg).out, "peek", `${doc.name}.png`);
  await mkdir(join(paths(cfg).out, "peek"), { recursive: true });
  const tmp = join(paths(cfg).out, "peek", `.${basename(out)}.${process.pid}.tmp`);
  await writeFile(tmp, png);
  await rename(tmp, out);
  const result: PeekResult = {
    png: out,
    doc: doc.name,
    page: box.page,
    box: { x: round(region.x), y: round(region.y), width: round(region.width), height: round(region.height) },
  };
  console.log(values.json ? JSON.stringify(result) : out);
  return 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
