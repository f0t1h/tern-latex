import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type DocConfig, docPaths, loadConfig, paths, resolveDoc, UsageError } from "../config.ts";
import { renderPage } from "../render.ts";
import { SyncTex } from "../synctex.ts";
import { parseLocation } from "./project.ts";

export interface SnapshotOptions {
  page?: number;
  /** FILE:LINE whose PDF page to render. */
  at?: string;
  /** Document name; default: the first, or for FILE:LINE the first document containing that line. */
  doc?: string;
  dpi: number;
  out?: string;
}

/** Renders one page of a document's last good PDF to PNG (for omp to look at) and prints the path. */
export async function snapshot(o: SnapshotOptions): Promise<number> {
  const cfg = loadConfig();
  let doc: DocConfig = resolveDoc(cfg, o.doc);
  let page = o.page;
  if (page === undefined) {
    if (!o.at) throw new UsageError("snapshot needs --page N or FILE:LINE");
    const loc = parseLocation(o.at);
    let found: { doc: DocConfig; page: number; y: number } | undefined;
    for (const d of o.doc ? [doc] : cfg.docs) {
      const st = docPaths(cfg, d).synctex;
      const box = existsSync(st) ? (await SyncTex.load(st, cfg.dir)).forward(loc.file, loc.line) : null;
      if (box) {
        found = { doc: d, page: box.page, y: box.y };
        break;
      }
    }
    if (!found) throw new UsageError(`${o.at} does not appear in ${o.doc ? `document "${o.doc}"` : "any document"} (not compiled, or before \\begin{document})`);
    ({ doc, page } = found);
    console.error(`${o.at} is in ${doc.name}, page ${page} at y≈${Math.round(found.y)}pt`);
  }
  const dp = docPaths(cfg, doc);
  if (!existsSync(dp.pdf)) throw new UsageError(`no PDF for ${doc.name} yet; run \`ternlatex build\``);
  if (!Number.isInteger(page) || page < 1) throw new UsageError(`bad page ${page}`);
  const out = resolve(o.out ?? join(paths(cfg).snapshots, `${doc.name}-page-${page}.png`));
  mkdirSync(dirname(out), { recursive: true });
  let png: Uint8Array;
  try {
    png = await renderPage(dp.pdf, page, o.dpi);
  } catch (e) {
    throw e instanceof RangeError ? new UsageError(e.message) : e;
  }
  writeFileSync(out, png);
  if (lastBuildFailed(paths(cfg).status, doc.name)) console.error("warning: the last build failed; this is the last good PDF");
  console.log(out);
  return 0;
}

function lastBuildFailed(statusFile: string, name: string): boolean {
  if (!existsSync(statusFile)) return false;
  const v: unknown = JSON.parse(readFileSync(statusFile, "utf8"));
  if (!v || typeof v !== "object" || !("docs" in v) || !Array.isArray(v.docs)) return false;
  return v.docs.some((s: unknown) => Boolean(s && typeof s === "object" && "doc" in s && s.doc === name && "ok" in s && s.ok === false));
}
