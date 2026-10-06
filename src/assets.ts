import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Files shipped with ternlatex, addressed by a logical path ("viewer/viewer.js", "pdfjs/pdf.min.mjs").
 * From source they live in the repo (and pdfjs-dist); in the compiled binary `scripts/build.ts` embeds
 * each root with `--asset`, which places it under the bundle's `import.meta.dir` with its sub-paths kept.
 */
export interface AssetRoot {
  /** Where the root lives when running from source: a repo directory, or a pdfjs-dist sub-directory. */
  source: { repo: string } | { pdfjs: string };
  /** Only these file names are shipped (default: all). */
  only?: RegExp;
  /** Only these top-level entries (files or directories) of the source directory are shipped (default: all). */
  include?: string[];
}

export const ASSET_ROOTS: Record<string, AssetRoot> = {
  "viewer/": { source: { repo: "viewer" } },
  "templates/": { source: { repo: "templates" } },
  "agent/": { source: { repo: "agent" } },
  // The Tern plugin package, laid out as the repo root is: plugin.toml and tern-plugin/. Its config.json is
  // written per machine at install, never shipped.
  "tern-package/": { source: { repo: "." }, include: ["plugin.toml", "tern-plugin"], only: /^(?!config\.json$)/ },
  // The legacy build polyfills newer JS (Map.prototype.getOrInsertComputed, …) that Tern's WebKit lacks.
  "pdfjs/": { source: { pdfjs: "legacy/build" }, only: /^pdf(\.worker)?\.min\.mjs$/ },
  "pdfjs-cmaps/": { source: { pdfjs: "cmaps" } },
  "pdfjs-fonts/": { source: { pdfjs: "standard_fonts" } },
  // Decoders for JBIG2 and JPEG 2000 images; render.ts runs pdf.js in-process, where ICC (qcms) stays off.
  "pdfjs-wasm/": { source: { pdfjs: "wasm" }, only: /^(jbig2|openjpeg)\.wasm$/ },
};

const EMBEDDED = Bun.isStandaloneExecutable;

let pdfjsDir: string | undefined;

/** Splits a logical path ("/"-separated) into its root's directory and the parts below it; refuses anything that could escape the root. */
function locate(rel: string): { dir: string; only?: RegExp; include?: string[]; parts: string[] } | null {
  const [first, ...parts] = rel.split("/");
  const root = `${first}/`;
  const def = ASSET_ROOTS[root];
  if (!def || parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes(":"))) return null;
  if (def.include && parts.length && !def.include.includes(parts[0])) return null;
  let dir: string;
  if (EMBEDDED) dir = join(import.meta.dir, root);
  else if ("repo" in def.source) dir = join(import.meta.dir, "..", def.source.repo);
  else {
    pdfjsDir ??= dirname(Bun.resolveSync("pdfjs-dist/package.json", import.meta.dir));
    dir = join(pdfjsDir, def.source.pdfjs);
  }
  return { dir, only: def.only, include: def.include, parts };
}

function fsPath(rel: string): string | null {
  const l = locate(rel);
  const name = l?.parts.at(-1);
  if (!l || !name || (l.only && !l.only.test(name))) return null;
  return join(l.dir, ...l.parts);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function assetBytes(rel: string): Promise<Uint8Array | null> {
  const path = fsPath(rel);
  return path && isFile(path) ? new Uint8Array(await readFile(path)) : null;
}

export async function assetText(rel: string): Promise<string | null> {
  const path = fsPath(rel);
  return path && isFile(path) ? readFile(path, "utf8") : null;
}

/** Shipped files under `prefix` (a directory such as "templates/" or "templates/article"), sorted. */
export function listAssets(prefix: string): string[] {
  const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const l = locate(dir.slice(0, -1));
  if (!l) return [];
  const base = join(l.dir, ...l.parts);
  const out: string[] = [];
  // A root with `include` lists only those entries, never the rest of its directory (the repo root's node_modules).
  for (const top of l.include && !l.parts.length ? l.include : [""]) {
    const path = join(base, top);
    if (!existsSync(path)) continue;
    const entries = isFile(path) ? [""] : readdirSync(path, { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      const sub = [top, entry.replaceAll("\\", "/")].filter(Boolean).join("/");
      // Dotfiles (.DS_Store, editor state) are never assets, also when running from a working tree.
      if (sub.split("/").some((p) => p.startsWith("."))) continue;
      if (l.only && !l.only.test(sub.slice(sub.lastIndexOf("/") + 1))) continue;
      if (isFile(join(base, sub))) out.push(dir + sub);
    }
  }
  return out.sort();
}

/** Copies the files under `prefix` into `dest`, keeping their paths below the prefix. Existing files are kept unless `force`. */
export async function copyAssets(prefix: string, dest: string, o: { force?: boolean } = {}): Promise<string[]> {
  const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const written: string[] = [];
  for (const rel of listAssets(dir)) {
    const target = join(dest, ...rel.slice(dir.length).split("/"));
    if (!o.force && existsSync(target)) continue;
    const bytes = await assetBytes(rel);
    if (!bytes) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(target);
  }
  return written;
}
