// SyncTeX parser for Tectonic/XeTeX `.synctex.gz` output.
//
// Coordinates: SyncTeX stores TeX scaled points (sp) measured from the page's
// top-left corner (the 1in TeX origin is already included), v growing
// downward. Conversion to PDF points (big points, 1/72 in):
//   pt = (sp * Unit * Magnification/1000 + Offset * Unit) / 65781.76
// where 65781.76 = 65536 sp/pt * 72.27 pt/in / 72 bp/in.

import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

export interface SourceLoc { file: string /* absolute path */; line: number }
export interface PdfBox { page: number; x: number; y: number; width: number; height: number }

const SP_PER_BP = 65781.76;
/** Max number of following lines searched by forward() when a line has no records. */
const FORWARD_LOOKAHEAD = 20;
const EPS = 1e-3;

const gunzipAsync = promisify(gunzip);

/** A line-level record (kern, glue, math, char, void box, rule) inside an hbox. */
interface Leaf {
  tag: number;
  line: number;
  x: number; // pt, position after the node
  start: number; // pt, position before the node (differs from x for kerns)
}

/** Line-end node inserted by \par: tagged with the paragraph-end line (the hbox's own line,
 * typically a blank line) and sitting at the box's right edge. Carries no content of its own. */
function isParEnd(box: HBox, leaf: Leaf): boolean {
  return leaf.tag === box.tag && leaf.line === box.line && leaf.x >= box.right - EPS;
}

interface HBox {
  tag: number;
  line: number;
  page: number;
  x: number; // left edge, pt
  top: number; // pt
  bottom: number; // pt
  right: number; // pt
  leaves: Leaf[];
  /** Outermost hbox this one is nested in without an intervening vbox (a typeset line); undefined for lines. */
  outer?: HBox;
}

/** Records for one (tag, line): whole hboxes and leaves (with their parent hbox). */
interface LineEntry { boxes: HBox[]; leaves: { box: HBox; index: number }[] }

/** One key per file however it is reached (macOS /tmp is /private/tmp; Tectonic records resolved paths). */
function fileKey(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs; // gone since the build
  }
}

function lineKey(tag: number, line: number): number {
  return tag * 0x10000000 + line;
}

function resolveInput(path: string, baseDir: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
  for (const candidate of [abs, `${abs}.tex`]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable: try next
    }
  }
  return abs;
}

export class SyncTex {
  private readonly files = new Map<number, string>(); // tag -> absolute path
  private readonly tagsByFile = new Map<string, number[]>();
  private readonly pages = new Map<number, HBox[]>();
  private readonly lines = new Map<number, LineEntry>();

  static async load(synctexGzPath: string, baseDir: string): Promise<SyncTex> {
    const buf = await gunzipAsync(await readFile(synctexGzPath));
    return SyncTex.parse(buf.toString("utf8"), baseDir);
  }

  static parse(text: string, baseDir: string): SyncTex {
    const st = new SyncTex();
    st.parseText(text, baseDir);
    return st;
  }

  private parseText(text: string, baseDir: string): void {
    let unit = 1;
    let mag = 1;
    let xOffset = 0;
    let yOffset = 0;
    let scale = 1 / SP_PER_BP;
    let xOff = 0;
    let yOff = 0;
    const recompute = (): void => {
      scale = (unit * mag) / SP_PER_BP;
      xOff = (xOffset * unit) / SP_PER_BP;
      yOff = (yOffset * unit) / SP_PER_BP;
    };

    let page = 0;
    let pageBoxes: HBox[] | null = null;
    // Open boxes: HBox for "(", null for "[" (vbox; its direct leaves are ignored).
    const stack: (HBox | null)[] = [];

    const len = text.length;
    let pos = 0;
    while (pos < len) {
      let end = text.indexOf("\n", pos);
      if (end < 0) end = len;
      let lineEnd = end;
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
      const start = pos;
      pos = end + 1;
      if (lineEnd === start) continue;
      const c = text[start];

      switch (c) {
        case "(":
        case "[":
        case "h":
        case "v":
        case "r":
        case "k":
        case "g":
        case "x":
        case "$": {
          if (pageBoxes === null) break;
          // K tag,line[,column]:x,y[:W,H,D]
          const colon1 = text.indexOf(":", start + 1);
          if (colon1 < 0 || colon1 > lineEnd) break;
          const comma1 = text.indexOf(",", start + 1);
          if (comma1 < 0 || comma1 > colon1) break;
          const tag = parseInt(text.slice(start + 1, comma1), 10);
          const line = parseInt(text.slice(comma1 + 1, colon1), 10); // parseInt stops at an optional ",column"
          const colon2 = text.indexOf(":", colon1 + 1);
          const posEnd = colon2 < 0 || colon2 > lineEnd ? lineEnd : colon2;
          const comma2 = text.indexOf(",", colon1 + 1);
          if (comma2 < 0 || comma2 > posEnd) break;
          const x = Number(text.slice(colon1 + 1, comma2)) * scale + xOff;
          const y = Number(text.slice(comma2 + 1, posEnd)) * scale + yOff;
          let w = 0;
          let h = 0;
          let d = 0;
          if (posEnd < lineEnd) {
            const dims = text.slice(posEnd + 1, lineEnd).split(",");
            w = Number(dims[0]) * scale;
            h = Number(dims[1] ?? 0) * scale;
            d = Number(dims[2] ?? 0) * scale;
          }
          if (c === "[") {
            stack.push(null);
          } else if (c === "(") {
            const parent = stack.length > 0 ? stack[stack.length - 1] : null;
            const box: HBox = {
              tag, line, page, x, top: y - h, bottom: y + d, right: x + w, leaves: [], outer: parent ? (parent.outer ?? parent) : undefined,
            };
            stack.push(box);
            pageBoxes.push(box);
            this.entry(tag, line).boxes.push(box);
          } else {
            const parent = stack.length > 0 ? stack[stack.length - 1] : null;
            if (parent) {
              // Void boxes and rules are recorded at their left edge; others after the node.
              const leafX = c === "h" || c === "v" || c === "r" ? x + w : x;
              const leafStart = c === "k" ? x - w : leafX;
              const index = parent.leaves.push({ tag, line, x: leafX, start: leafStart }) - 1;
              this.entry(tag, line).leaves.push({ box: parent, index });
            }
          }
          break;
        }
        case ")":
        case "]":
          stack.pop();
          break;
        case "{": {
          page = parseInt(text.slice(start + 1, lineEnd), 10);
          pageBoxes = this.pages.get(page) ?? [];
          this.pages.set(page, pageBoxes);
          stack.length = 0;
          break;
        }
        case "}":
          pageBoxes = null;
          stack.length = 0;
          break;
        case "I": {
          if (!text.startsWith("Input:", start)) break;
          const sep = text.indexOf(":", start + 6);
          if (sep < 0 || sep >= lineEnd) break;
          const tag = parseInt(text.slice(start + 6, sep), 10);
          const path = text.slice(sep + 1, lineEnd);
          if (!path || Number.isNaN(tag)) break;
          const abs = resolveInput(path, baseDir);
          this.files.set(tag, abs);
          const key = fileKey(abs);
          const tags = this.tagsByFile.get(key);
          if (tags) tags.push(tag);
          else this.tagsByFile.set(key, [tag]);
          break;
        }
        default: {
          const sep = text.indexOf(":", start);
          if (sep < 0 || sep >= lineEnd) break;
          const key = text.slice(start, sep);
          const value = Number(text.slice(sep + 1, lineEnd));
          if (Number.isNaN(value)) break;
          if (key === "Unit") unit = value || 1;
          else if (key === "Magnification") mag = (value || 1000) / 1000;
          else if (key === "X Offset") xOffset = value;
          else if (key === "Y Offset") yOffset = value;
          else break;
          recompute();
        }
      }
    }
  }

  private entry(tag: number, line: number): LineEntry {
    const key = lineKey(tag, line);
    let e = this.lines.get(key);
    if (!e) {
      e = { boxes: [], leaves: [] };
      this.lines.set(key, e);
    }
    return e;
  }

  private loc(tag: number, line: number): SourceLoc | null {
    const file = this.files.get(tag);
    return file === undefined ? null : { file, line };
  }

  reverse(page: number, x: number, y: number): SourceLoc | null {
    const boxes = this.pages.get(page);
    if (!boxes || boxes.length === 0) return null;

    let best: HBox | null = null;
    let bestArea = Infinity;
    for (const b of boxes) {
      if (x >= b.x - EPS && x <= b.right + EPS && y >= b.top - EPS && y <= b.bottom + EPS) {
        const area = (b.right - b.x) * (b.bottom - b.top);
        if (area < bestArea) {
          bestArea = area;
          best = b;
        }
      }
    }
    if (!best) {
      let bestDy = Infinity;
      let bestDx = Infinity;
      for (const b of boxes) {
        const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
        const dx = x < b.x ? b.x - x : x > b.right ? x - b.right : 0;
        if (dy < bestDy - EPS || (Math.abs(dy - bestDy) <= EPS && dx < bestDx)) {
          bestDy = dy;
          bestDx = dx;
          best = b;
        }
      }
    }
    if (!best) return null;

    const leaves = best.leaves;
    if (leaves.length === 0) return this.loc(best.tag, best.line);
    // The node recorded right after the point (kern/glue following a word) carries the word's line.
    let idx = -1;
    let idxX = Infinity;
    for (let i = 0; i < leaves.length; i++) {
      const lx = leaves[i].x;
      if (lx >= x - EPS && lx < idxX) {
        idxX = lx;
        idx = i;
      }
    }
    if (idx < 0) idx = leaves.length - 1;
    // Line-end nodes inserted by \par carry the paragraph-end line (= the hbox's line, typically
    // a blank line); step back to the last real content node.
    while (idx >= 0) {
      const leaf = leaves[idx];
      if (!isParEnd(best, leaf)) break;
      idx--;
    }
    const leaf = idx >= 0 ? leaves[idx] : best;
    return this.loc(leaf.tag, leaf.line);
  }

  forward(file: string, line: number): PdfBox | null {
    const tags = this.tagsByFile.get(fileKey(file));
    if (!tags) return null;
    for (let l = line; l <= line + FORWARD_LOOKAHEAD; l++) {
      const box = this.forwardExact(tags, l);
      if (box) return box;
    }
    return null;
  }

  /**
   * The typeset lines holding FILE:LINE (same lookahead as forward): the union of the outermost hboxes of its
   * records on its first page, i.e. full text width of the column it is set in.
   */
  forwardLines(file: string, line: number): PdfBox | null {
    const tags = this.tagsByFile.get(fileKey(file));
    if (!tags) return null;
    for (let l = line; l <= line + FORWARD_LOOKAHEAD; l++) {
      const boxes: HBox[] = [];
      for (const tag of tags) {
        const e = this.lines.get(lineKey(tag, l));
        if (!e) continue;
        for (const b of e.boxes) boxes.push(b.outer ?? b);
        for (const { box, index } of e.leaves) if (!isParEnd(box, box.leaves[index])) boxes.push(box.outer ?? box);
      }
      if (boxes.length === 0) continue;
      const page = Math.min(...boxes.map((b) => b.page));
      const on = boxes.filter((b) => b.page === page);
      const left = Math.min(...on.map((b) => b.x));
      const top = Math.min(...on.map((b) => b.top));
      return { page, x: left, y: top, width: Math.max(...on.map((b) => b.right)) - left, height: Math.max(...on.map((b) => b.bottom)) - top };
    }
    return null;
  }

  private forwardExact(tags: number[], line: number): PdfBox | null {
    const boxes: HBox[] = [];
    const leaves: { box: HBox; index: number }[] = [];
    for (const tag of tags) {
      const e = this.lines.get(lineKey(tag, line));
      if (!e) continue;
      boxes.push(...e.boxes);
      leaves.push(...e.leaves);
    }
    // Rects as [page, left, top, right, bottom].
    const rects: [number, number, number, number, number][] = [];
    if (boxes.length > 0) {
      for (const b of boxes) rects.push([b.page, b.x, b.top, b.right, b.bottom]);
    } else {
      for (const { box, index } of leaves) {
        // A leaf covers the material between the previous node (or the box start) and itself.
        const own = box.leaves;
        if (isParEnd(box, own[index])) continue;
        let right = own[index].x;
        const left = index > 0 ? Math.min(own[index - 1].x, right) : Math.min(box.x, right);
        // The last word before \par is closed by the paragraph-end node, not by this leaf.
        if (index + 1 < own.length && isParEnd(box, own[index + 1])) right = Math.max(right, own[index + 1].start);
        rects.push([box.page, left, box.top, right, box.bottom]);
      }
    }
    if (rects.length === 0) return null;
    let page = Infinity;
    for (const r of rects) if (r[0] < page) page = r[0];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      if (r[0] !== page) continue;
      if (r[1] < left) left = r[1];
      if (r[2] < top) top = r[2];
      if (r[3] > right) right = r[3];
      if (r[4] > bottom) bottom = r[4];
    }
    return { page, x: left, y: top, width: right - left, height: bottom - top };
  }
}
