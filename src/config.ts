import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse } from "smol-toml";

export const CONFIG_FILE = "ternlatex.toml";

/** Tectonic resolves this relay to a fixed TeX Live 2022 tarball; pinning the target keeps builds reproducible. */
export const DEFAULT_BUNDLE = "https://data1b.fullyjustified.net/tlextras-2022.0r0.tar";

export type EngineName = "tectonic" | "latexmk";

export interface DocConfig {
  /** Short id: output file names, `--doc NAME`, the viewer's switcher. */
  name: string;
  /** Root .tex file, project-relative. */
  root: string;
}

export interface Config {
  /** Absolute project directory (where ternlatex.toml lives). */
  dir: string;
  /** The project's documents, each built to its own PDF; the first is the default. */
  docs: DocConfig[];
  outdir: string;
  engine: EngineName;
  bundle: string;
  /** Extra args for latexmk, e.g. ["-xelatex"]. */
  latexmkArgs: string[];
  port: number;
  /** Project-relative path prefixes the watcher ignores, on top of outdir and dot-directories. */
  ignore: string[];
  zotero: ZoteroConfig;
  review: ReviewConfig;
  proofread: ProofreadConfig;
  rewrite: RewriteConfig;
  /** `[tools]` overrides: tool name → executable path (else env TERNLATEX_<NAME>, PATH, managed download). */
  tools: Record<string, string>;
  /** Snapshot the working tree onto refs/ternlatex/checkpoints at every build (i.e. every save). */
  checkpoints: boolean;
}

export interface ZoteroConfig {
  /** "local": the Zotero 7 desktop app's local API; "web": api.zotero.org (ZOTERO_API_KEY for private libraries). */
  source: "local" | "web";
  /** "user" (local), or "user:<id>" / "group:<id>" (web). */
  library: string;
  /** Optional collection key to search in. */
  collection?: string;
  /** Project-relative .bib file that imported entries are appended to. */
  bib: string;
  /** Import entries for undefined citations automatically after a build. */
  autoImport: boolean;
}

export interface ReviewAuthor {
  id: string;
  name: string;
  color?: string;
}

export interface ReviewConfig {
  /** Authors for the `changes` package (\added[id=…] etc.). */
  authors: ReviewAuthor[];
  /** Typeset as if every change were accepted, without markup (changes' `final` option). */
  final: boolean;
}

export function findProject(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadConfig(start = process.cwd()): Config {
  const dir = findProject(start);
  if (!dir) throw new UsageError(`no ${CONFIG_FILE} in ${resolve(start)} or its parents; run \`ternlatex init\` or \`ternlatex import\``);
  const raw = parse(readFileSync(join(dir, CONFIG_FILE), "utf8")) as Record<string, unknown>;
  const engine = str(raw.engine, "tectonic");
  if (engine !== "tectonic" && engine !== "latexmk") throw new UsageError(`${CONFIG_FILE}: engine must be "tectonic" or "latexmk", got "${engine}"`);
  const cfg: Config = {
    dir,
    docs: docsConfig(raw),
    outdir: str(raw.outdir, "build"),
    engine,
    bundle: str(raw.bundle, DEFAULT_BUNDLE),
    latexmkArgs: isStrList(raw.latexmk_args) ? raw.latexmk_args : ["-xelatex"],
    port: typeof raw.port === "number" ? raw.port : 0,
    ignore: isStrList(raw.ignore) ? raw.ignore : [],
    zotero: zoteroConfig(raw.zotero),
    review: reviewConfig(raw.review),
    proofread: proofreadConfig(raw.proofread),
    rewrite: rewriteConfig(raw.rewrite),
    tools: Object.fromEntries(Object.entries(table(raw.tools)).flatMap(([k, v]) => (typeof v === "string" && v ? [[k, v]] : []))),
    checkpoints: raw.checkpoints !== false,
  };
  for (const d of cfg.docs) if (!existsSync(join(dir, d.root))) throw new UsageError(`${CONFIG_FILE}: root file ${d.root} (document "${d.name}") does not exist`);
  return cfg;
}

/** A document by name, or the default (first) one. */
export function resolveDoc(cfg: Config, name?: string): DocConfig {
  if (name === undefined || name === "") return cfg.docs[0];
  const doc = cfg.docs.find((d) => d.name === name);
  if (!doc) throw new UsageError(`no document "${name}"; documents: ${cfg.docs.map((d) => d.name).join(", ")}`);
  return doc;
}

/** Default document name: the root file's stem. */
export function docName(root: string): string {
  return basename(root).replace(/\.tex$/, "");
}

/** `root = "x.tex"` (one document) or `[[documents]]` tables with `root` and optional `name`. */
function docsConfig(raw: Record<string, unknown>): DocConfig[] {
  if (raw.documents === undefined) return [{ name: docName(str(raw.root, "main.tex")), root: str(raw.root, "main.tex") }];
  if (raw.root !== undefined) throw new UsageError(`${CONFIG_FILE}: use either root or [[documents]], not both`);
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) throw new UsageError(`${CONFIG_FILE}: [[documents]] needs at least one entry`);
  const docs: DocConfig[] = [];
  for (const entry of raw.documents) {
    const t = table(entry);
    if (typeof t.root !== "string" || !t.root.endsWith(".tex")) throw new UsageError(`${CONFIG_FILE}: every [[documents]] entry needs root = "<file>.tex"`);
    const name = str(t.name, docName(t.root));
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError(`${CONFIG_FILE}: document name "${name}" may only use letters, digits, . _ -`);
    if (docs.some((d) => d.name === name)) throw new UsageError(`${CONFIG_FILE}: two documents are named "${name}"; set distinct name = "…"`);
    docs.push({ name, root: t.root });
  }
  return docs;
}

/** A new project's config; one root gives `root = …`, several give `[[documents]]` tables. */
export function renderConfig(roots: string[]): string {
  // Stems collide for a/main.tex and b/main.tex; those get their path as the name instead.
  const stems = roots.map(docName);
  const names = roots.map((r, i) => (stems.filter((s) => s === stems[i]).length > 1 ? r.replace(/\.tex$/, "").replace(/[^A-Za-z0-9._-]+/g, "-") : stems[i]));
  const lines = [
    `# ternlatex project — see ${"`ternlatex --help`"}`,
    ...(roots.length === 1 ? [`root = ${JSON.stringify(roots[0])}`] : []),
    `outdir = "build"`,
    `# "tectonic" (bundled, reproducible) or "latexmk" (uses a host TeX Live; not contained)`,
    `engine = "tectonic"`,
    `bundle = ${JSON.stringify(DEFAULT_BUNDLE)}`,
    `# latexmk_args = ["-xelatex"]`,
    `# port = 4820   # 0 = pick a free port`,
    `# ignore = ["data/raw"]`,
    `# checkpoints = true   # snapshot every save onto refs/ternlatex/checkpoints`,
    ``,
    ...(roots.length === 1
      ? [`# more documents (paper, supplement, slides…): replace root with [[documents]] tables, e.g.`, `# [[documents]]`, `# name = "supplement"`, `# root = "supplement.tex"`, ``]
      : roots.flatMap((r, i) => [`[[documents]]`, `name = ${JSON.stringify(names[i])}`, `root = ${JSON.stringify(r)}`, ``])),
    `[zotero]`,
    `source = "local"      # Zotero desktop app; "web" = api.zotero.org (ZOTERO_API_KEY for private libraries)`,
    `library = "user"      # web: "user:<id>" or "group:<id>"`,
    `bib = "refs.bib"`,
    `auto_import = true    # fetch undefined \\cite keys from Zotero after a build`,
    ``,
    `[review]              # authors for the changes package: \\added[id=AK]{…}, \\comment[id=AK]{…}`,
    `authors = []          # e.g. [{ id = "AK", name = "Ana K", color = "orange" }]`,
    `final = false         # true: typeset with all changes accepted and no markup`,
    ``,
    `# Models are omp roles, set per person in omp's config (not here, so collaborators keep their own):`,
    `# "latex" for the omp block, "proofread" and "rewrite"; \`ternlatex models\` shows what each uses.`,
    `[proofread]           # \`ternlatex proofread\`: one omp call per paragraph, thinking off, no tools`,
    `parallel = 4`,
    ``,
    `[rewrite]             # Tern's "Rewrite sentence" / \`ternlatex rewrite\`: alternatives for one sentence`,
    `count = 4             # alternatives per request (1–9)`,
  ];
  return lines.join("\n") + "\n";
}

/** Project-wide output paths. */
export function paths(cfg: Config) {
  const out = join(cfg.dir, cfg.outdir);
  return {
    out,
    status: join(out, "status.json"),
    server: join(out, ".server.json"),
    snapshots: join(out, "snapshots"),
  };
}

/** One document's outputs: build/<name>.pdf etc., compiled in its own staging directory. */
export function docPaths(cfg: Config, doc: DocConfig) {
  const out = join(cfg.dir, cfg.outdir);
  const stem = docName(doc.root); // What the engine names its outputs.
  const staging = join(out, ".staging", doc.name);
  return {
    name: doc.name,
    staging,
    staged: { pdf: join(staging, `${stem}.pdf`), synctex: join(staging, `${stem}.synctex.gz`), log: join(staging, `${stem}.log`) },
    pdf: join(out, `${doc.name}.pdf`),
    synctex: join(out, `${doc.name}.synctex.gz`),
    log: join(out, `${doc.name}.log`),
    /** The last run's .aux in the staging directory (labels, numbers); absent before the first build. */
    aux: join(staging, `${stem}.aux`),
    diff: join(out, `${doc.name}-diff.pdf`),
    /** Makefile-format dependency list from the last Tectonic run: which files feed this document. */
    deps: join(staging, "deps.mk"),
  };
}

/** Native relative path to the `/`-separated form config values, deps and diagnostics use (Windows yields backslashes). */
export function posix(p: string): string {
  return p.split(sep).join("/");
}

export class UsageError extends Error {}

function str(v: unknown, d: string): string {
  return typeof v === "string" && v !== "" ? v : d;
}
function isStrList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function table(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function zoteroConfig(v: unknown): ZoteroConfig {
  const t = table(v);
  const source = str(t.source, "local");
  if (source !== "local" && source !== "web") throw new UsageError(`${CONFIG_FILE}: [zotero] source must be "local" or "web"`);
  return {
    source,
    library: str(t.library, "user"),
    collection: typeof t.collection === "string" && t.collection ? t.collection : undefined,
    bib: str(t.bib, "refs.bib"),
    autoImport: t.auto_import !== false,
  };
}

export interface ProofreadConfig {
  /** Concurrent omp calls. */
  parallel: number;
}

function proofreadConfig(v: unknown): ProofreadConfig {
  const t = table(v);
  const parallel = typeof t.parallel === "number" && Number.isInteger(t.parallel) && t.parallel > 0 ? t.parallel : 4;
  return { parallel: Math.min(parallel, 16) };
}

export interface RewriteConfig {
  /** Alternatives per request. */
  count: number;
}

function rewriteConfig(v: unknown): RewriteConfig {
  const t = table(v);
  const count = typeof t.count === "number" && Number.isInteger(t.count) && t.count > 0 ? Math.min(t.count, 9) : 4;
  return { count };
}

function reviewConfig(v: unknown): ReviewConfig {
  const t = table(v);
  const authors: ReviewAuthor[] = [];
  for (const a of Array.isArray(t.authors) ? t.authors : []) {
    const e = table(a);
    if (typeof e.id !== "string" || !/^[A-Za-z0-9]+$/.test(e.id)) throw new UsageError(`${CONFIG_FILE}: [review] authors need an alphanumeric id`);
    authors.push({ id: e.id, name: str(e.name, e.id), color: typeof e.color === "string" ? e.color : undefined });
  }
  return { authors, final: t.final === true };
}
