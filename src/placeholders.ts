import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";
import { loadCanvas } from "./render.ts";

/**
 * Stand-ins for files a build could not find (an image or a section a co-author has not pushed yet), so a
 * partial build shows where they go. The engine finds them on an extra search path; the project is untouched.
 */

/** Size of a placeholder figure: 4 × 2.25 in, so a figure without a width stays inside the text block. */
const WIDTH_PT = 288;
const HEIGHT_PT = 162;

/** Extensions of files that get a placeholder; anything else (a package, a class, a .bib) is left missing. */
const IMAGE = /^\.(pdf|png|jpe?g)$/i;

/**
 * The project files a failed build reported missing, as written in the source: `figs/plot` (graphicx names
 * without an extension), `sections/intro.tex`. Only relative paths inside the project.
 */
export function missingFiles(diagnostics: Diagnostic[]): string[] {
  const names = new Set<string>();
  for (const d of diagnostics) {
    const m = /File [`'"]([^'"`]+)['"] not found/.exec(d.message);
    if (!m) continue;
    const name = m[1].trim();
    const ext = extname(name);
    // "File `.' not found" is TeX asking for another name in nonstop mode, not a file of the project.
    const wanted = /[\p{L}\p{N}]/u.test(name) && (ext === "" || ext.toLowerCase() === ".tex" || IMAGE.test(ext));
    const inside = !isAbsolute(name) && !normalize(name).split(/[\\/]/).includes("..");
    if (wanted && inside) names.add(name);
  }
  return [...names];
}

/** Writes a placeholder for each missing NAME into DIR (emptied first); returns the names it wrote one for. */
export async function writePlaceholders(dir: string, names: string[]): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const name of names) {
    const ext = extname(name).toLowerCase();
    // graphicx tries its extensions in order and .pdf comes first, so a bare name gets a PDF.
    const file = ext === "" ? `${name}.pdf` : name;
    const target = join(dir, file);
    if (!target.startsWith(dir + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    if (ext === ".tex") await writeFile(target, texPlaceholder(name));
    else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") await writeFile(target, await imagePlaceholder(name, ext === ".png" ? "image/png" : "image/jpeg"));
    else await writeFile(target, pdfPlaceholder(name));
    written.push(name);
  }
  return written;
}

/** A missing \input: one framed line naming it. */
export function texPlaceholder(name: string): string {
  return `\\par\\noindent\\fbox{\\ttfamily Missing file: \\detokenize{${name.replace(/[{}]/g, "")}}}\\par\n`;
}

/** The label a placeholder figure carries, shortened from the left to fit. */
function label(name: string): string {
  return name.length > 44 ? `…${name.slice(-43)}` : name;
}

/** A missing figure as a one-page PDF: a grey dashed box with "Missing figure" and the name (Helvetica, base 14). */
export function pdfPlaceholder(name: string): Buffer {
  // PDF strings: escape \ ( ), and keep to ASCII, as Helvetica here has the standard encoding only.
  const pdfString = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    "0.94 g",
    `0 0 ${WIDTH_PT} ${HEIGHT_PT} re f`,
    "0.55 G 1 w [4 3] 0 d",
    `2 2 ${WIDTH_PT - 4} ${HEIGHT_PT - 4} re S`,
    "0.3 g",
    `BT /F1 14 Tf 18 ${HEIGHT_PT / 2 + 8} Td (Missing figure) Tj ET`,
    `BT /F1 10 Tf 18 ${HEIGHT_PT / 2 - 12} Td (${pdfString(label(name))}) Tj ET`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH_PT} ${HEIGHT_PT}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A missing PNG or JPEG figure: the same box as pdfPlaceholder, at 72 dpi (XeTeX's size for images without one). */
async function imagePlaceholder(name: string, mime: "image/png" | "image/jpeg"): Promise<Buffer> {
  const canvas = (await loadCanvas()).createCanvas(WIDTH_PT, HEIGHT_PT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f0f0f0";
  ctx.fillRect(0, 0, WIDTH_PT, HEIGHT_PT);
  ctx.strokeStyle = "#8c8c8c";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(2.5, 2.5, WIDTH_PT - 5, HEIGHT_PT - 5);
  ctx.fillStyle = "#4d4d4d";
  ctx.font = "14px sans-serif";
  ctx.fillText("Missing figure", 18, HEIGHT_PT / 2 - 4);
  ctx.font = "10px sans-serif";
  ctx.fillText(label(name), 18, HEIGHT_PT / 2 + 16);
  return mime === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg");
}
