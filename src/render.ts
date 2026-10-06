import { readFile } from "node:fs/promises";
import type * as NapiCanvasModule from "@napi-rs/canvas";
import type * as PdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { assetBytes } from "./assets.ts";

export type Pdfjs = typeof PdfjsModule;
type NapiCanvas = typeof NapiCanvasModule;

let loaded: Promise<{ pdfjs: Pdfjs; canvas: NapiCanvas }> | undefined;

async function load(): Promise<{ pdfjs: Pdfjs; canvas: NapiCanvas }> {
  // Dynamic: the native canvas addon is only loaded by commands that read or render PDFs.
  const canvas = await import("@napi-rs/canvas");
  // pdf.js require()s "@napi-rs/canvas" by name for its DOMMatrix/ImageData/Path2D polyfills and canvases; the
  // compiled binary can't resolve bare names at runtime, so hand it the bundled copy as a virtual module.
  Bun.plugin({ name: "napi-canvas", setup: (b) => void b.module("@napi-rs/canvas", () => ({ exports: { ...canvas }, loader: "object" })) });
  // Dynamic: pdf.js polyfills from that require at module load, so a static import crashes the compiled binary before the module above exists.
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.mjs")]);
  // pdf.js runs its worker in-process ("fake worker") and takes it from here instead of importing a file by URL.
  Object.assign(globalThis, { pdfjsWorker: worker });
  return { pdfjs, canvas };
}

/** pdf.js, with the canvas polyfills and the in-process worker it needs under Bun. */
export async function loadPdfjs(): Promise<Pdfjs> {
  loaded ??= load();
  return (await loaded).pdfjs;
}

/** pdf.js asks for cMaps, standard fonts and wasm decoders by kind; they come from the shipped pdf.js assets. */
const DATA_ROOT: Record<string, string> = { cMapUrl: "pdfjs-cmaps/", standardFontDataUrl: "pdfjs-fonts/", wasmUrl: "pdfjs-wasm/" };

class AssetDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const root = DATA_ROOT[kind];
    const bytes = root ? await assetBytes(root + filename) : null;
    if (!bytes) throw new Error(`pdf.js data not shipped: ${kind} ${filename}`);
    return bytes;
  }
}

/** getDocument options that make pdf.js load cMaps, standard fonts and wasm decoders from the shipped assets. */
export const PDF_DATA = { BinaryDataFactory: AssetDataFactory, ...DATA_ROOT };

/** Renders one page (1-based) of a PDF to PNG at `dpi`, on white, like the PDF's paper. */
export async function renderPage(pdfPath: string, page: number, dpi: number): Promise<Uint8Array> {
  return (await renderRegion(pdfPath, page, (w, h) => ({ x: 0, y: 0, width: w, height: h, scale: dpi / 72 }))).png;
}

/** A page region in PDF points from the top-left corner, and the scale (pixels per point) to render it at. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * Renders the region of one page (1-based) that PICK chooses from the page size (points), clipped to the
 * page; returns the PNG and the clipped region.
 */
export async function renderRegion(pdfPath: string, page: number, pick: (pageWidth: number, pageHeight: number) => Region): Promise<{ png: Uint8Array; region: Region }> {
  loaded ??= load();
  const { pdfjs, canvas } = await loaded;
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), verbosity: 0, ...PDF_DATA });
  try {
    const doc = await task.promise;
    if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw new RangeError(`page ${page} out of range (1–${doc.numPages})`);
    const p = await doc.getPage(page);
    const full = p.getViewport({ scale: 1 });
    const want = pick(full.width, full.height);
    const x = Math.max(0, Math.min(want.x, full.width));
    const y = Math.max(0, Math.min(want.y, full.height));
    const region = { x, y, width: Math.min(want.width, full.width - x), height: Math.min(want.height, full.height - y), scale: want.scale };
    const viewport = p.getViewport({ scale: region.scale, offsetX: -region.x * region.scale, offsetY: -region.y * region.scale });
    const out = canvas.createCanvas(Math.max(1, Math.round(region.width * region.scale)), Math.max(1, Math.round(region.height * region.scale)));
    // The napi context implements the DOM 2D context API pdf.js draws with; only its declared type differs.
    const canvasContext = out.getContext("2d") as unknown as CanvasRenderingContext2D;
    await p.render({ canvas: null, canvasContext, viewport }).promise;
    return { png: await out.encode("png"), region };
  } finally {
    await task.destroy();
  }
}
