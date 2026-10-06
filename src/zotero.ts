import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Config, docPaths, posix } from "./config.ts";

/** One Zotero item as a bib entry whose key is the item's citation key. */
export interface ZoteroEntry {
  key: string;
  bibtex: string;
  title: string;
  creators: string;
  year?: string;
}

/** A failure talking to Zotero; the message says what the user has to do. */
export class ZoteroError extends Error {}

const LOCAL = "http://127.0.0.1:23119";
const WEB = "https://api.zotero.org";
const LOCAL_TIMEOUT = 3_000;
const WEB_TIMEOUT = 10_000;
/** Wording of the preference as documented at zotero.org/support/dev/web_api/v3/local_api. */
const LOCAL_HINT = "start Zotero 7 or later and enable Settings → Advanced → “Allow other applications on this computer to communicate with Zotero”";
const KEY_HINT = "create a read-only key at https://www.zotero.org/settings/keys/new and export it as ZOTERO_API_KEY";
export const IMPORT_HEADER = "% Imported from Zotero by ternlatex";
/** Web API page-size cap; key lookups scan at most WEB_PAGES pages per search term. */
const WEB_PAGE = 100;
const WEB_PAGES = 3;

type Format = "bibtex" | "biblatex";
const BBT_TRANSLATOR: Record<Format, string> = { bibtex: "Better BibTeX", biblatex: "Better BibLaTeX" };
const NON_ENTRY: Record<string, true> = { comment: true, string: true, preamble: true };
const NON_ITEM: Record<string, true> = { note: true, attachment: true, annotation: true };

// ---------------------------------------------------------------- project scanning

/** \cite-family keys used in the project's .tex files, in order of first use. */
export function citedKeys(cfg: Config): string[] {
  return [...new Set(projectFiles(cfg, ".tex").flatMap((f) => parseCiteKeys(readFileSync(join(cfg.dir, f), "utf8"))))];
}

/** Project .bib files (plus the import target, which may live outside the scan), absolute and existing. */
function bibFiles(cfg: Config): string[] {
  return [...new Set([...projectFiles(cfg, ".bib").map((f) => join(cfg.dir, f)), join(cfg.dir, cfg.zotero.bib)])].filter((f) => existsSync(f));
}

/** Keys defined in any .bib file of the project. */
export function definedKeys(cfg: Config): Set<string> {
  const keys = new Set<string>();
  for (const f of bibFiles(cfg)) for (const k of bibKeys(readFileSync(f, "utf8"))) keys.add(k);
  return keys;
}

/** Every entry of the project's .bib files, in file order; a key defined twice keeps its first entry. */
export function projectBibEntries(cfg: Config): ZoteroEntry[] {
  const out = new Map<string, ZoteroEntry>();
  for (const f of bibFiles(cfg)) for (const [key, entry] of splitBib(readFileSync(f, "utf8"))) if (!out.has(key)) out.set(key, entryFromBib(key, entry));
  return [...out.values()];
}

export type CiteStyle = "natbib" | "biblatex" | "plain";

/** The citation package in use: from the documents' last build logs, else from the project's .tex/.sty sources. */
export function citeStyle(cfg: Config): CiteStyle {
  for (const d of cfg.docs) {
    const log = docPaths(cfg, d).log;
    if (!existsSync(log)) continue;
    const text = readFileSync(log, "utf8");
    if (/\bbiblatex\.sty\b/.test(text)) return "biblatex";
    if (/\bnatbib\.sty\b/.test(text)) return "natbib";
  }
  if (bibFormat(cfg) === "biblatex") return "biblatex";
  const natbib = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bnatbib\b/;
  const sources = [...projectFiles(cfg, ".tex"), ...projectFiles(cfg, ".sty")];
  return sources.some((f) => natbib.test(stripComments(readFileSync(join(cfg.dir, f), "utf8")))) ? "natbib" : "plain";
}

function projectFiles(cfg: Config, ext: string): string[] {
  const outdir = posix(relative(cfg.dir, resolve(cfg.dir, cfg.outdir)));
  return readdirSync(cfg.dir, { recursive: true, encoding: "utf8" })
    .map(posix)
    .filter((f) => f.endsWith(ext) && !f.startsWith(`${outdir}/`) && !f.split("/").some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
}

/** biblatex projects get biblatex exports; everything else (natbib, plain \bibliography) gets BibTeX. */
function bibFormat(cfg: Config): Format {
  const uses = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b|\\addbibresource\b/;
  return projectFiles(cfg, ".tex").some((f) => uses.test(stripComments(readFileSync(join(cfg.dir, f), "utf8")))) ? "biblatex" : "bibtex";
}

// ---------------------------------------------------------------- LaTeX parsing

const CITE_CMD = /\\([A-Za-z]*[cC]ite[A-Za-z]*|nocite)\*?(?![A-Za-z])/g;
const NOT_CITE: Record<string, true> = { citestyle: true, citeindextrue: true, citeindexfalse: true };

/** Removes % comments, keeping escaped \% (an even run of backslashes before % still starts a comment). */
function stripComments(tex: string): string {
  return tex.replace(/(?<!\\)((?:\\\\)*)%.*$/gm, "$1");
}

/** Index just past the group that opens at s[i], honouring nesting; -1 when unbalanced. */
export function skipGroup(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Citation keys in TeX source: \cite, natbib (\citet, \citep*, \citealp, \Citet …), biblatex
 * (\parencite, \textcite, \autocite …, and multicite \cites(pre)(post)[pre][post]{a}{b}), \nocite.
 * Optional arguments are skipped; comma lists are split; comments are ignored; \nocite{*} is not a key.
 */
export function parseCiteKeys(tex: string): string[] {
  return citeUses(tex).map((u) => u.key);
}

/** One citation key in TeX source and the 1-based line of its command. */
export interface CiteUse {
  key: string;
  line: number;
}

/** Like parseCiteKeys, with the line of each use (every occurrence, in order). */
export function citeUses(tex: string): CiteUse[] {
  const s = stripComments(tex); // Line structure is unchanged, so line numbers hold.
  const uses: CiteUse[] = [];
  let line = 1;
  let counted = 0;
  for (const m of s.matchAll(CITE_CMD)) {
    const name = m[1];
    if (NOT_CITE[name] === true) continue;
    for (; counted < m.index; counted++) if (s[counted] === "\n") line++;
    const multi = name.endsWith("cites");
    let i = m.index + m[0].length;
    for (;;) {
      while (/\s/.test(s[i] ?? "")) i++;
      const c = s[i];
      const next = c === "[" ? skipGroup(s, i, "[", "]") : c === "(" && multi ? skipGroup(s, i, "(", ")") : c === "{" ? skipGroup(s, i, "{", "}") : -1;
      if (next < 0) break;
      if (c === "{") {
        for (const k of s.slice(i + 1, next - 1).split(",")) {
          const key = k.trim();
          if (key && key !== "*") uses.push({ key, line });
        }
        if (!multi) break;
      }
      i = next;
    }
  }
  return uses;
}

// ---------------------------------------------------------------- bib handling

const ENTRY_HEAD = /@\s*([A-Za-z]+)\s*[{(]\s*([^\s,{}()"#%'=]+)\s*,/g;

/** Keys of the entries in a .bib text; entry types are matched case-insensitively, @comment/@string/@preamble skipped. */
export function bibKeys(bib: string): Set<string> {
  const keys = new Set<string>();
  for (const m of bib.matchAll(ENTRY_HEAD)) if (NON_ENTRY[m[1].toLowerCase()] !== true) keys.add(m[2]);
  return keys;
}

/** The entry text with its key replaced by KEY; null when TEXT has no entry head. */
export function withKey(text: string, key: string): string | null {
  for (const m of text.matchAll(ENTRY_HEAD)) {
    if (NON_ENTRY[m[1].toLowerCase()] === true) continue;
    const start = m.index + m[0].lastIndexOf(m[2]);
    return (text.slice(0, start) + key + text.slice(start + m[2].length)).trim();
  }
  return null;
}

/**
 * Text to append to an existing .bib so that ENTRIES not yet defined in it are added: one header comment,
 * then the new entries. Existing entries are never touched; duplicate keys (in the file or among ENTRIES) are skipped.
 */
export function bibAppendix(existing: string, entries: ZoteroEntry[]): { text: string; added: string[] } {
  const have = bibKeys(existing);
  const blocks: string[] = [];
  const added: string[] = [];
  for (const e of entries) {
    if (have.has(e.key)) continue;
    const block = withKey(e.bibtex, e.key);
    if (!block) continue;
    have.add(e.key);
    added.push(e.key);
    blocks.push(block);
  }
  if (!blocks.length) return { text: "", added };
  const lead = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${lead}${IMPORT_HEADER}\n${blocks.join("\n\n")}\n`, added };
}

/** Balanced value of FIELD in one bib entry, outer braces/quotes removed. */
function bibField(entry: string, field: string): string | undefined {
  const m = new RegExp(`[\\s,]${field}\\s*=\\s*`, "i").exec(entry);
  if (!m) return undefined;
  const i = m.index + m[0].length;
  if (entry[i] === "{") {
    const end = skipGroup(entry, i, "{", "}");
    return end < 0 ? undefined : entry.slice(i + 1, end - 1);
  }
  if (entry[i] === '"') return /^"([^"]*)"/.exec(entry.slice(i))?.[1];
  return /^[^,\s}]+/.exec(entry.slice(i))?.[0];
}

/** Splits an export into entries keyed by citation key. */
function splitBib(bib: string): Map<string, string> {
  const heads = [...bib.matchAll(ENTRY_HEAD)].filter((m) => NON_ENTRY[m[1].toLowerCase()] !== true);
  return new Map(heads.map((m, n) => [m[2], bib.slice(m.index, heads[n + 1]?.index ?? bib.length).trim()]));
}

function summarize(names: string[]): string {
  return names.length > 2 ? `${names[0]} et al.` : names.join(" and ");
}

/** Combining marks for TeX accent commands (\"o, \'{e}, \c{c} …). */
const TEX_ACCENT: Record<string, string> = {
  '"': "\u0308", "'": "\u0301", "`": "\u0300", "^": "\u0302", "~": "\u0303", "=": "\u0304", ".": "\u0307",
  c: "\u0327", v: "\u030C", u: "\u0306", H: "\u030B", r: "\u030A", k: "\u0328",
};
/** Letters TeX spells as commands. */
const TEX_LETTER: Record<string, string> = { ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", TeX: "TeX", LaTeX: "LaTeX" };

/** Bib field text as plain Unicode: accents and letter commands decoded, braces removed, whitespace collapsed. */
function bibPlain(v: string): string {
  return v
    .replace(/\\(["'`^~=.])\s*(?:\{\s*([A-Za-z]|\\i)\s*\}|([A-Za-z]))|\\([cvuHrk])(?:\s*\{\s*([A-Za-z])\s*\}|\s+([A-Za-z]))/g, (all, a1: string | undefined, b1: string | undefined, c1: string | undefined, a2: string | undefined, b2: string | undefined, c2: string | undefined) => {
      const mark = TEX_ACCENT[a1 ?? a2 ?? ""];
      const base = (b1 ?? c1 ?? b2 ?? c2 ?? "").replace("\\i", "i");
      return mark && base ? base + mark : all;
    })
    .replace(/\\([A-Za-z]+)\b\s*(?:\{\})?/g, (all, name: string) => TEX_LETTER[name] ?? all)
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .normalize("NFC")
    .trim();
}

function entryFromBib(key: string, entry: string): ZoteroEntry {
  const plain = (v?: string) => (v === undefined ? "" : bibPlain(v));
  const authors = plain(bibField(entry, "author") ?? bibField(entry, "editor"))
    .split(/\s+and\s+/)
    .filter(Boolean)
    .map((a) => (a.includes(",") ? a.split(",")[0] : (a.split(" ").at(-1) ?? a)).trim());
  const year = /\d{4}/.exec(bibField(entry, "year") ?? bibField(entry, "date") ?? "")?.[0];
  return { key, bibtex: entry, title: plain(bibField(entry, "title")), creators: summarize(authors), year };
}

// ---------------------------------------------------------------- external data narrowing

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------- HTTP

async function request(url: string, init: RequestInit, local: boolean): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(local ? LOCAL_TIMEOUT : WEB_TIMEOUT) });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "connection failed";
    if (local) throw new ZoteroError(`Zotero is not reachable at ${LOCAL} (${why}): ${LOCAL_HINT}`);
    throw new ZoteroError(`${WEB} is not reachable (${why}); check the network connection`);
  }
}

/** The /users/<id> or /groups/<id> prefix for cfg.zotero.library. */
async function libraryPrefix(cfg: Config): Promise<string> {
  const m = /^(user|group)(?::(\d+))?$/.exec(cfg.zotero.library);
  if (!m || (m[1] === "group" && !m[2])) throw new ZoteroError(`ternlatex.toml: [zotero] library must be "user", "user:<id>" or "group:<id>", got "${cfg.zotero.library}"`);
  if (m[1] === "group") return `groups/${m[2]}`;
  if (m[2]) return `users/${m[2]}`;
  if (cfg.zotero.source === "local") return "users/0";
  const key = process.env.ZOTERO_API_KEY;
  if (!key) throw new ZoteroError(`[zotero] library = "user" with source = "web" needs ZOTERO_API_KEY to find your user id (or set library = "user:<id>"); ${KEY_HINT}`);
  const r = await request(`${WEB}/keys/${encodeURIComponent(key)}`, { headers: { "Zotero-API-Version": "3" } }, false);
  if (!r.ok) throw new ZoteroError(`${WEB} rejected ZOTERO_API_KEY (${r.status}); ${KEY_HINT}`);
  const id = rec(await r.json()).userID;
  if (typeof id !== "number") throw new ZoteroError(`${WEB} returned no user id for ZOTERO_API_KEY`);
  return `users/${id}`;
}

/** GET on the Zotero (local or web) API; returns the parsed JSON body and the Total-Results header. */
async function apiGet(cfg: Config, path: string, params: Record<string, string>): Promise<{ body: unknown; total: number }> {
  const local = cfg.zotero.source === "local";
  const url = `${local ? `${LOCAL}/api` : WEB}/${await libraryPrefix(cfg)}/${path}?${new URLSearchParams(params)}`;
  const headers: Record<string, string> = { "Zotero-API-Version": "3" };
  if (!local && process.env.ZOTERO_API_KEY) headers["Zotero-API-Key"] = process.env.ZOTERO_API_KEY;
  const r = await request(url, { headers }, local);
  if (r.ok) return { body: await r.json(), total: Number(r.headers.get("Total-Results") ?? 0) };
  const detail = (await r.text()).trim().slice(0, 200);
  if (local && r.status === 403) throw new ZoteroError(`Zotero refused the local API request: ${LOCAL_HINT}`);
  if (local && r.status === 404 && /no endpoint/i.test(detail)) throw new ZoteroError(`this Zotero has no local API (needs Zotero 7 or later): ${LOCAL_HINT}`);
  if (!local && r.status === 403) {
    const why = process.env.ZOTERO_API_KEY ? `ZOTERO_API_KEY is invalid or has no read access to it (${detail || "forbidden"})` : "it is private and ZOTERO_API_KEY is not set";
    throw new ZoteroError(`${WEB} denied access to library ${cfg.zotero.library} (403): ${why}; ${KEY_HINT}`);
  }
  if (r.status === 404) throw new ZoteroError(`Zotero library ${cfg.zotero.library} not found (404)${local ? "" : `; for a private library set ZOTERO_API_KEY (${KEY_HINT})`}`);
  if (r.status === 429 || r.status === 503) throw new ZoteroError(`Zotero is rate-limiting requests (${r.status}); retry in ${r.headers.get("Retry-After") ?? "a few"} seconds`);
  throw new ZoteroError(`Zotero API ${r.status}: ${detail}`);
}

/** Citation key of an API item: native citationKey field, then an Extra `Citation Key:` line, then the key of Zotero's own export. */
function apiEntry(v: unknown, format: Format): ZoteroEntry | null {
  const item = rec(v);
  const data = rec(item.data);
  const meta = rec(item.meta);
  if (NON_ITEM[text(data.itemType) ?? ""] === true) return null;
  const exported = text(item[format]);
  if (!exported) return null;
  const pinned = /^\s*Citation Key:\s*(\S+)\s*$/im.exec(text(data.extra) ?? "")?.[1];
  const key = text(data.citationKey) ?? pinned ?? bibKeys(exported).values().next().value;
  const bibtex = key ? withKey(exported, key) : null;
  if (!key || !bibtex) return null;
  const creators = Array.isArray(data.creators) ? data.creators.map((c) => text(rec(c).lastName) ?? text(rec(c).name) ?? "").filter(Boolean) : [];
  return {
    key,
    bibtex,
    title: text(data.title) ?? "",
    creators: text(meta.creatorSummary) ?? summarize(creators),
    year: /\d{4}/.exec(text(meta.parsedDate) ?? text(data.date) ?? "")?.[0],
  };
}

async function apiSearch(cfg: Config, q: string, limit: number, format: Format, inCollection: boolean, start = 0): Promise<{ entries: ZoteroEntry[]; total: number }> {
  const scope = inCollection && cfg.zotero.collection ? `collections/${cfg.zotero.collection}/items/top` : "items/top";
  const { body, total } = await apiGet(cfg, scope, { q, limit: String(limit), start: String(start), include: `data,${format}` });
  const entries = (Array.isArray(body) ? body : []).flatMap((v) => apiEntry(v, format) ?? []);
  return { entries, total };
}

/** Quick-search terms likely to find the item behind a citation key: its name-like tokens (author, title word), longest first-seen. */
export function keySearchTerms(key: string): string[] {
  const words = key.split(/[^A-Za-z]+/).flatMap((part) => part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []);
  return [...new Set(words.filter((w) => w.length >= 3).map((w) => w.toLowerCase()))].slice(0, 3);
}

/** Finds items by citation key with quick searches, matching the resolved keys of the results. */
async function apiFetchByKeys(cfg: Config, keys: string[], format: Format): Promise<Map<string, ZoteroEntry>> {
  const want = new Set(keys);
  const found = new Map<string, ZoteroEntry>();
  const tried = new Set<string>();
  for (const key of keys) {
    for (const q of keySearchTerms(key)) {
      if (found.has(key)) break;
      if (tried.has(q)) continue;
      tried.add(q);
      for (let page = 0; page < WEB_PAGES && !found.has(key); page++) {
        const { entries, total } = await apiSearch(cfg, q, WEB_PAGE, format, false, page * WEB_PAGE);
        for (const e of entries) if (want.has(e.key) && !found.has(e.key)) found.set(e.key, e);
        if ((page + 1) * WEB_PAGE >= total) break;
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- Better BibTeX (local only)

let bbtReady: Promise<boolean> | undefined;

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: string; ok: boolean }> {
  const r = await request(`${LOCAL}/better-bibtex/json-rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  }, true);
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  const body = rec(await r.json().catch(() => null));
  const err = rec(body.error);
  return "result" in body ? { ok: true, result: body.result } : { ok: true, error: text(err.message) ?? "unknown error" };
}

/** Whether Better BibTeX answers on the local Zotero; throws (with the local hint) when Zotero itself is unreachable. */
function hasBbt(cfg: Config): Promise<boolean> {
  if (cfg.zotero.source !== "local") return Promise.resolve(false);
  bbtReady ??= rpc("api.ready", []).then((r) => r.ok && r.result !== undefined);
  return bbtReady;
}

function bbtLibrary(cfg: Config): number[] {
  const m = /^group:(\d+)$/.exec(cfg.zotero.library);
  return m ? [Number(m[1])] : [];
}

/** item.export throws on any unknown or ambiguous key; drop those and retry once. */
async function bbtExport(cfg: Config, keys: string[], format: Format): Promise<Map<string, ZoteroEntry>> {
  let want = [...new Set(keys)];
  for (let attempt = 0; attempt < 2 && want.length; attempt++) {
    const r = await rpc("item.export", [want, BBT_TRANSLATOR[format], ...bbtLibrary(cfg)]);
    if (typeof r.result === "string") {
      const out = new Map<string, ZoteroEntry>();
      for (const [key, entry] of splitBib(r.result)) if (want.includes(key)) out.set(key, entryFromBib(key, entry));
      return out;
    }
    const bad = new Set([...(r.error ?? "").matchAll(/(?:not found|duplicates found): ([^\n]*)/g)].flatMap((m) => m[1].split(/,\s*/)));
    if (!bad.size) throw new ZoteroError(`Better BibTeX export failed: ${r.error}`);
    want = want.filter((k) => !bad.has(k));
  }
  return new Map();
}

async function bbtSearch(cfg: Config, query: string, limit: number, format: Format): Promise<ZoteroEntry[]> {
  const r = await rpc("item.search", [query, ...bbtLibrary(cfg)]);
  if (!Array.isArray(r.result)) throw new ZoteroError(`Better BibTeX search failed: ${r.error ?? "unexpected response"}`);
  const hits = r.result.map(rec).filter((h) => text(h.citekey)).slice(0, limit);
  const exported = await bbtExport(cfg, hits.map((h) => text(h.citekey) ?? ""), format);
  return hits.flatMap((h) => {
    const e = exported.get(text(h.citekey) ?? "");
    if (!e) return [];
    const names = (Array.isArray(h.author) ? h.author : []).map((a) => text(rec(a).family) ?? text(rec(a).literal) ?? "").filter(Boolean);
    const parts = rec(h.issued)["date-parts"];
    const year = Array.isArray(parts) && Array.isArray(parts[0]) ? String(parts[0][0] ?? "") : "";
    return [{ ...e, title: text(h.title) ?? e.title, creators: names.length ? summarize(names) : e.creators, year: /^\d{4}$/.test(year) ? year : e.year }];
  });
}

// ---------------------------------------------------------------- public API

/** Quick search (title, creators, year) in the configured library/collection. */
export async function searchZotero(cfg: Config, query: string, limit = 25): Promise<ZoteroEntry[]> {
  const format = bibFormat(cfg);
  if (await hasBbt(cfg)) return bbtSearch(cfg, query, limit, format);
  return (await apiSearch(cfg, query, Math.min(limit, WEB_PAGE), format, true)).entries.slice(0, limit);
}

/** Entries for citation keys; keys that resolve to no item are absent from the map. */
export async function fetchByKeys(cfg: Config, keys: string[]): Promise<Map<string, ZoteroEntry>> {
  if (!keys.length) return new Map();
  const format = bibFormat(cfg);
  return (await hasBbt(cfg)) ? bbtExport(cfg, keys, format) : apiFetchByKeys(cfg, [...new Set(keys)], format);
}

/** Appends Zotero entries for KEYS (default: cited keys no project .bib defines) to cfg.zotero.bib. */
export async function importCitations(cfg: Config, keys?: string[]): Promise<{ added: string[]; missing: string[] }> {
  const defined = definedKeys(cfg);
  const want = [...new Set(keys ?? citedKeys(cfg))].filter((k) => !defined.has(k));
  if (!want.length) return { added: [], missing: [] };
  const found = await fetchByKeys(cfg, want);
  const bib = join(cfg.dir, cfg.zotero.bib);
  const existing = existsSync(bib) ? readFileSync(bib, "utf8") : "";
  const { text: appendix, added } = bibAppendix(existing, want.flatMap((k) => found.get(k) ?? []));
  if (appendix) {
    mkdirSync(dirname(bib), { recursive: true });
    appendFileSync(bib, appendix);
  }
  return { added, missing: want.filter((k) => !added.includes(k)) };
}

/** One `refs find` hit. */
export interface FoundReference {
  key: string;
  year: string;
  creators: string;
  title: string;
  source: "bib" | "zotero";
}

/** JSON result of `refs find --json`. */
export interface FindResult {
  /** The citation command the project's package suggests, and the alternatives to cycle through. */
  cite: string;
  variants: string[];
  items: FoundReference[];
  /** Why Zotero was not searched; the .bib results stand. */
  zotero_error?: string;
}

const CITE_VARIANTS: Record<CiteStyle, string[]> = {
  natbib: ["\\citep", "\\citet", "\\cite"],
  biblatex: ["\\parencite", "\\textcite", "\\cite"],
  plain: ["\\cite"],
};

/** Lower-case, accents and TeX braces/commands removed, for matching. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\\[A-Za-z]+\s*|[{}\\]|\p{M}/gu, "")
    .toLowerCase();
}

/**
 * Bib entries of the project whose key, authors/editors, title or year contain every word of QUERY (case- and
 * accent-insensitive), newest first when QUERY is empty; then Zotero hits for a non-empty QUERY, de-duplicated
 * by key (the project's entry wins). An unreachable Zotero is reported in `zotero_error`, not thrown.
 */
export async function findReferences(cfg: Config, query: string, limit: number): Promise<FindResult> {
  const variants = CITE_VARIANTS[citeStyle(cfg)];
  const words = fold(query).split(/\s+/).filter(Boolean);
  const local = projectBibEntries(cfg).filter((e) => {
    const hay = fold([e.key, e.year ?? "", bibPlain(bibField(e.bibtex, "author") ?? ""), bibPlain(bibField(e.bibtex, "editor") ?? ""), e.title].join(" "));
    return words.every((w) => hay.includes(w));
  });
  if (!words.length) local.sort((a, b) => (b.year ?? "").localeCompare(a.year ?? ""));
  const items: FoundReference[] = local.slice(0, limit).map((e) => ({ key: e.key, year: e.year ?? "", creators: e.creators, title: e.title, source: "bib" }));
  const result: FindResult = { cite: variants[0], variants, items };
  if (!words.length || items.length >= limit) return result;
  try {
    const have = new Set(local.map((e) => e.key));
    for (const e of await searchZotero(cfg, query, limit)) {
      if (have.has(e.key) || items.length >= limit) continue;
      have.add(e.key);
      items.push({ key: e.key, year: e.year ?? "", creators: e.creators, title: e.title, source: "zotero" });
    }
  } catch (e) {
    result.zotero_error = e instanceof Error ? e.message : String(e);
  }
  return result;
}
