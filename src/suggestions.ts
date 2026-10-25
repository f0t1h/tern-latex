import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUILTIN_AUTHORS, type Change, contextAround, PROOF_AUTHOR, resolveChanges, scanChanges } from "./changes.ts";
import { type Config, paths, type ReviewAuthor } from "./config.ts";
import type { Hunk } from "./proofread.ts";

/**
 * Suggestions (proofreading, dictation) kept outside the sources, for documents that don't load the `changes`
 * package (e.g. moderncv CVs, venue classes). They show in the Review panel like tracked changes; accepting one
 * edits the source, rejecting one drops it. Each keeps a little surrounding text to find its place again after
 * other edits.
 */

const CONTEXT = 30;
/** Pending ids are prefixed so resolve requests can be routed between these and in-source markup. */
const ID_PREFIX = "p-";

export interface Pending {
  id: string;
  file: string;
  /** 1-based line when suggested. */
  line: number;
  old: string;
  new: string;
  why: string;
  before: string;
  after: string;
  /** Review author id (src/changes.ts); stores written before authors were recorded hold proofreading only. */
  author?: string;
}

function storeFile(cfg: Config): string {
  return join(paths(cfg).out, "suggestions.json");
}

export function readPending(cfg: Config): Pending[] {
  const file = storeFile(cfg);
  if (!existsSync(file)) return [];
  const v: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!v || typeof v !== "object" || !("items" in v) || !Array.isArray(v.items)) return [];
  return v.items.filter((p: unknown): p is Pending => {
    if (!p || typeof p !== "object" || !("id" in p) || !("file" in p) || !("old" in p) || !("new" in p)) return false;
    if (typeof p.id !== "string" || typeof p.file !== "string") return false;
    return !("author" in p) || p.author === undefined || typeof p.author === "string";
  });
}

async function writePending(cfg: Config, items: Pending[]): Promise<void> {
  const file = storeFile(cfg);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ items }, null, 2) + "\n");
  await rename(tmp, file);
}

/** Stores hunks by AUTHOR (offsets into `texts`, the file contents they were computed on); returns how many are new. */
export async function addPending(cfg: Config, hunks: Hunk[], texts: Map<string, string>, author: string): Promise<number> {
  const items = readPending(cfg);
  const known = new Set(items.map((p) => p.id));
  let added = 0;
  for (const h of hunks) {
    const text = texts.get(h.file) ?? "";
    const before = text.slice(Math.max(0, h.start - CONTEXT), h.start);
    const after = text.slice(h.end, h.end + CONTEXT);
    const id = ID_PREFIX + createHash("sha1").update([h.file, before, h.old, h.new, after].join("\0")).digest("hex").slice(0, 8);
    if (known.has(id)) continue;
    known.add(id);
    items.push({ id, file: h.file, line: h.line, old: h.old, new: h.new, why: h.why, before, after, author });
    added++;
  }
  await writePending(cfg, items);
  return added;
}

/** Where a suggestion's old text is in the current file, or null once that text has changed. */
function locate(text: string, p: Pending): number | null {
  const needle = p.before + p.old + p.after;
  const at = text.indexOf(needle);
  if (at >= 0 && text.indexOf(needle, at + 1) < 0) return at + p.before.length;
  return null;
}

/** Pending suggestions as Review items, on their current lines; ones whose text has changed are left out. */
export function pendingChanges(cfg: Config): Change[] {
  const texts = new Map<string, string | null>();
  const out: Change[] = [];
  for (const p of readPending(cfg)) {
    if (!texts.has(p.file)) texts.set(p.file, existsSync(join(cfg.dir, p.file)) ? readFileSync(join(cfg.dir, p.file), "utf8") : null);
    const text = texts.get(p.file);
    const at = text ? locate(text, p) : null;
    if (at === null || !text) continue;
    const line = text.slice(0, at).split("\n").length;
    const kind = p.old && p.new ? "replaced" : p.new ? "added" : "deleted";
    out.push({
      id: p.id,
      kind,
      author: p.author ?? PROOF_AUTHOR,
      file: p.file,
      line,
      text: p.new || p.old,
      old: kind === "replaced" ? p.old : undefined,
      comment: p.why || undefined,
      ...contextAround(text, at, at + p.old.length),
    });
  }
  return out;
}

export function isPendingId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/**
 * Accepts (edits the source) or rejects (drops) pending suggestions. Suggestions whose text changed since are
 * dropped either way: there is nothing left to apply them to. Returns how many were resolved.
 */
export async function resolvePending(cfg: Config, ids: string[], decision: "accept" | "reject"): Promise<number> {
  const wanted = new Set(ids);
  const items = readPending(cfg);
  let rest = items.filter((p) => !wanted.has(p.id));
  if (decision === "reject") {
    await writePending(cfg, rest);
    return items.length - rest.length;
  }
  let resolved = 0;
  for (const file of new Set(items.filter((p) => wanted.has(p.id)).map((p) => p.file))) {
    const abs = join(cfg.dir, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    // Every suggestion in the file is placed before editing, so the ones left open can be re-anchored.
    const placed = items.flatMap((p) => {
      const at = p.file === file ? locate(text, p) : null;
      return at === null ? [] : [{ p, at, end: at + p.old.length }];
    });
    const accepted = placed.filter((x) => wanted.has(x.p.id)).sort((a, b) => a.at - b.at);
    let out = "";
    let from = 0;
    for (const x of accepted) {
      if (x.at < from) continue; // Overlaps one accepted just before it.
      out += text.slice(from, x.at) + x.p.new;
      from = x.end;
      resolved++;
    }
    out += text.slice(from);
    // Where an unedited offset of `text` lands in `out`.
    const shift = (offset: number) => offset + accepted.filter((x) => x.end <= offset).reduce((d, x) => d + x.p.new.length - x.p.old.length, 0);
    const refreshed = new Map<string, Pending>();
    for (const x of placed) {
      if (wanted.has(x.p.id) || accepted.some((a) => x.at < a.end && a.at < x.end)) continue;
      const at = shift(x.at);
      const end = at + x.p.old.length;
      refreshed.set(x.p.id, { ...x.p, line: out.slice(0, at).split("\n").length, before: out.slice(Math.max(0, at - CONTEXT), at), after: out.slice(end, end + CONTEXT) });
    }
    // Open suggestions overlapping an accepted one, or no longer found, are dropped.
    rest = rest.flatMap((p) => (p.file !== file ? [p] : refreshed.has(p.id) ? [refreshed.get(p.id)!] : []));
    const tmp = `${abs}.${process.pid}.accept.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, abs);
  }
  await writePending(cfg, rest);
  return resolved;
}

/** Everything the Review panel and `ternlatex changes` list: in-source markup plus pending suggestions. */
export function reviewItems(cfg: Config): Change[] {
  return [...scanChanges(cfg), ...pendingChanges(cfg)];
}

/** GET /changes and `ternlatex changes --json`. */
export interface ReviewList {
  authors: ReviewAuthor[];
  items: Change[];
}

/** Review items with every author they may name: configured ones (winning on id clashes), then the built-ins, in the PDF markup's colours. */
export function reviewList(cfg: Config): ReviewList {
  const authors = cfg.review.authors;
  return { authors: [...authors, ...BUILTIN_AUTHORS.filter((b) => !authors.some((a) => a.id === b.id))], items: reviewItems(cfg) };
}

/** Accepts or rejects review items of either kind; returns how many were resolved. */
export async function resolveReview(cfg: Config, ids: string[], decision: "accept" | "reject"): Promise<number> {
  const pending = ids.filter(isPendingId);
  const marked = ids.filter((id) => !isPendingId(id));
  return (pending.length ? await resolvePending(cfg, pending, decision) : 0) + (marked.length ? await resolveChanges(cfg, marked, decision) : 0);
}
