import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Config, type DocConfig, docPaths, posix } from "./config.ts";
import { type Diagnostic, mergeDiagnostics, parseLog, parseTectonicOutput } from "./diagnostics.ts";
import { missingFiles, writePlaceholders } from "./placeholders.ts";
import { resolveTool, ToolMissingError } from "./tools.ts";

export interface CompileResult {
  ok: boolean;
  /**
   * Not ok, yet there is a PDF: built again past the errors (Config.partial), missing images and \input files
   * drawn as placeholders. The diagnostics are the failed build's.
   */
  partial: boolean;
  /** Files in the staging directory; pdf/synctex only meaningful when ok or partial. */
  pdf: string;
  synctex: string;
  log: string;
  diagnostics: Diagnostic[];
  /** Project-relative files this run read; null when the engine cannot tell (latexmk). */
  deps: string[] | null;
  /** Placeholders a partial build used, as the sources name the missing files. */
  placeholders?: string[];
  /**
   * From one TeX run on the last full build's .aux, .bbl and other intermediates, which it reproduced unchanged:
   * the PDF a full build would make, in a third of the time (fastPass).
   */
  fast?: boolean;
}

export interface CompileOptions {
  /** Shows a one-pass PDF whose references changed while the full build that settles them runs. */
  provisional?: (r: CompileResult) => Promise<void>;
}

/** Compiles one document into its staging directory. Never touches the published outputs. */
export async function compile(cfg: Config, doc: DocConfig, o: CompileOptions = {}): Promise<CompileResult> {
  const p = docPaths(cfg, doc);
  await mkdir(p.staging, { recursive: true });
  const staged = p.staged;
  const args =
    cfg.engine === "tectonic"
      ? ["-X", "compile", "--synctex", "--keep-logs", "--keep-intermediates", "--bundle", cfg.bundle, "--makefile-rules", p.deps, "--outdir", p.staging, doc.root]
      : [...cfg.latexmkArgs, "-synctex=1", "-interaction=nonstopmode", "-file-line-error", `-outdir=${p.staging}`, doc.root];
  let command: string[];
  try {
    command = (await resolveTool(cfg.engine, cfg)).command;
  } catch (e) {
    if (!(e instanceof ToolMissingError)) throw e;
    return { ok: false, partial: false, ...staged, deps: null, diagnostics: [{ severity: "error", message: e.message }] };
  }
  const cmd = cfg.engine;
  if (cfg.engine === "tectonic") {
    const fast = await fastPass(cfg, doc, command);
    if (fast?.settled) return fast.result;
    if (fast) await o.provisional?.(fast.result);
  }
  // Since the full run itself, not the fast pass before it: only what this run wrote counts.
  const runStarted = Date.now();
  const run = await exec(command, args, cfg.dir);
  if (run.spawnError) return { ok: false, partial: false, ...staged, deps: null, diagnostics: [{ severity: "error", message: `cannot run ${command[0]}: ${run.spawnError}` }] };
  const isFresh = (f: string, since = runStarted) => fresh(f, since);
  const logText = isFresh(staged.log) ? readFileSync(staged.log, "utf8") : "";
  const ok = run.code === 0 && isFresh(staged.pdf);
  const all = mergeDiagnostics(
    cfg.engine === "tectonic" ? parseTectonicOutput(run.output, cfg.dir) : [],
    parseLog(logText, cfg.dir),
  );
  // A halted run never reads its .aux, so every \ref/\cite looks undefined: noise that buries the real error.
  const diagnostics = ok ? all : all.filter((d) => d.severity === "error" || !/undefined|Rerun/i.test(d.message));
  if (!ok && !diagnostics.some((d) => d.severity === "error")) {
    const tail = run.output.trim().split("\n").slice(-5).join("\n");
    diagnostics.unshift({ severity: "error", message: `${cmd} exited with ${run.code}${tail ? `: ${tail}` : ""}` });
  }
  const depsOf = (since: number) => (fresh(p.deps, since) ? projectDeps(cfg, p.staging, readFileSync(p.deps, "utf8")) : null);
  // A full build's intermediates seed the next save's fast pass.
  if (ok && cfg.engine === "tectonic") await keepSeed(p.staging, runStarted).catch(() => {});
  if (ok || !cfg.partial) return { ok, partial: false, ...staged, deps: ok ? depsOf(runStarted) : null, diagnostics };

  // Partial build: again, past the errors (Tectonic's continue-on-errors, latexmk -f), with stand-ins for the
  // missing files on Tectonic's search path. A run stopped by an error only reports the first missing file, so
  // each pass adds the files the last one reported, up to PARTIAL_PASSES.
  const dir = join(p.staging, "missing");
  const missingErrors = new Map<string, Diagnostic>();
  const noteMissing = (list: Diagnostic[]) => {
    for (const d of list) for (const name of missingFiles([d])) if (!missingErrors.has(name)) missingErrors.set(name, d);
  };
  noteMissing(all);
  let placeholders: string[] = [];
  let result: { partial: boolean; diagnostics: Diagnostic[]; since: number } = { partial: false, diagnostics, since: Date.now() };
  for (let pass = 0; pass < PARTIAL_PASSES; pass++) {
    const since = Date.now();
    const known = missingErrors.size;
    placeholders = cfg.engine === "tectonic" ? await writePlaceholders(dir, [...missingErrors.keys()]) : [];
    const partialArgs =
      cfg.engine === "tectonic"
        ? [...args.slice(0, 2), "-Z", "continue-on-errors", ...(placeholders.length ? ["-Z", `search-path=${dir}`] : []), ...args.slice(2)]
        : ["-f", ...args];
    const again = await exec(command, partialArgs, cfg.dir);
    if (again.spawnError) break;
    const passDiagnostics = mergeDiagnostics(
      cfg.engine === "tectonic" ? parseTectonicOutput(again.output, cfg.dir) : [],
      parseLog(fresh(staged.log, since) ? readFileSync(staged.log, "utf8") : "", cfg.dir),
    ).filter((d) => !PARTIAL_NOISE.test(d.message));
    noteMissing(passDiagnostics);
    result = { partial: fresh(staged.pdf, since), diagnostics: passDiagnostics, since };
    if (cfg.engine !== "tectonic" || missingErrors.size === known) break;
  }
  if (!result.partial) return { ok: false, partial: false, ...staged, deps: null, diagnostics };
  // The partial run's own diagnostics (every error, not just the first), plus what was missing: placeholders
  // hid those errors from it.
  return {
    ok: false,
    partial: true,
    ...staged,
    deps: depsOf(result.since),
    diagnostics: mergeDiagnostics([...missingErrors.values()], result.diagnostics),
    ...(placeholders.length ? { placeholders } : {}),
  };
}

/** The intermediates a full build leaves for the next fast pass: under the staging directory, read through `-Z search-path`. */
const SEED = "seed";
/** Outputs that are not read back by a TeX run: BibTeX's log (.blg) too, which a pass without BibTeX doesn't write. */
const NOT_INTERMEDIATE = /\.(?:pdf|synctex\.gz|log|blg|xdv|fls)$|^deps\.mk$/;

function fresh(f: string, since: number): boolean {
  return existsSync(f) && statSync(f).mtimeMs >= since - 1000;
}

/** Intermediate files of DIR (.aux, .bbl, .toc, .out, …), those written since SINCE when given. */
function intermediates(dir: string, since?: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !NOT_INTERMEDIATE.test(e.name) && (since === undefined || fresh(join(dir, e.name), since)))
    .map((e) => e.name)
    .sort();
}

/** Replaces the seed with the intermediates the full build that started at SINCE wrote. */
async function keepSeed(staging: string, since: number): Promise<void> {
  const seed = join(staging, SEED);
  await rm(seed, { recursive: true, force: true });
  await mkdir(seed, { recursive: true });
  for (const f of intermediates(staging, since)) await copyFile(join(staging, f), join(seed, f));
}

/**
 * One TeX run given the last full build's intermediates (Tectonic otherwise starts from nothing and runs TeX
 * about four times, with BibTeX between). It settles when the run writes back exactly those intermediates:
 * nothing that feeds cross-references, citations, the outline or the list of changes moved, so its PDF is the
 * full build's. Otherwise (a new label, a citation, a page reference that moved) it is provisional and the
 * full build follows. Null when there is no seed yet or the run failed: the full build reports errors.
 */
async function fastPass(cfg: Config, doc: DocConfig, command: string[]): Promise<{ result: CompileResult; settled: boolean } | null> {
  const p = docPaths(cfg, doc);
  const seed = join(p.staging, SEED);
  const seeded = intermediates(seed);
  if (!seeded.some((f) => f.endsWith(".aux"))) return null;
  const started = Date.now();
  const args = ["-X", "compile", "--synctex", "--keep-logs", "--keep-intermediates", "--reruns", "0", "-Z", `search-path=${seed}`, "--bundle", cfg.bundle, "--makefile-rules", p.deps, "--outdir", p.staging, doc.root];
  const run = await exec(command, args, cfg.dir);
  if (run.spawnError || run.code !== 0 || !fresh(p.staged.pdf, started)) return null;
  const deps = fresh(p.deps, started) ? projectDeps(cfg, p.staging, readFileSync(p.deps, "utf8")) : null;
  // The changes package lists every mark (\deleted, \added, …) in .loc and .soc, and in the .aux on their way
  // there: read back only by \listofchanges. A document without it settles whatever marks come or go.
  const listsChanges = deps === null || deps.some((f) => /\.(?:tex|sty|cls)$/.test(f) && existsSync(join(cfg.dir, f)) && readFileSync(join(cfg.dir, f), "utf8").includes("\\listofchanges"));
  const compared = (names: string[]) => names.filter((f) => listsChanges || !/\.(?:loc|soc)$/.test(f));
  const written = compared(intermediates(p.staging, started));
  const base = compared(seeded);
  const same = (f: string) => settledText(readFileSync(join(p.staging, f), "utf8"), listsChanges) === settledText(readFileSync(join(seed, f), "utf8"), listsChanges);
  const settled = written.length === base.length && written.every((f, i) => f === base[i] && same(f));
  const log = fresh(p.staged.log, started) ? readFileSync(p.staged.log, "utf8") : "";
  const diagnostics = mergeDiagnostics(parseTectonicOutput(run.output, cfg.dir), parseLog(log, cfg.dir));
  return { result: { ok: true, partial: false, ...p.staged, deps, diagnostics, fast: true }, settled };
}

/** The project files a run read, from its Makefile rules: not the seed it was given. */
function projectDeps(cfg: Config, staging: string, mk: string): string[] {
  const out = posix(relative(cfg.dir, staging));
  return parseDeps(mk, cfg.dir, relative(cfg.dir, staging)).filter((f) => !f.startsWith(`${out}/`));
}

/**
 * An intermediate as far as settling goes: without the page positions pgf records for `remember picture`
 * overlays (todonotes' lines), which move a little on every run, a full build's included, and only place
 * those drawings; without the list-of-changes entries unless LISTS_CHANGES.
 */
function settledText(text: string, listsChanges: boolean): string {
  // Whole lines, newline included: two runs listing a different number of changes must still compare equal.
  const out = text.replace(/^\\pgfsyspdfmark .*(?:\n|$)/gm, "");
  return listsChanges ? out : out.replace(/^\\@writefile\{loc\}.*(?:\n|$)/gm, "");
}

/** Partial builds a missing file can take: each finds the next missing \input or figure an error stopped at. */
const PARTIAL_PASSES = 4;
/** What a partial run says about running partially: Tectonic's note that errors were ignored, TeX's file prompt. */
const PARTIAL_NOISE = /errors were issued by the TeX engine, but were ignored|File [`'"]\.['"] not found/;

/**
 * Project files named in Tectonic's Makefile rules (`target : dep dep \`, spaces escaped as `\ `), as
 * `/`-separated project-relative paths (the form config roots and the watcher use).
 * Tectonic 0.17 prefixes every dependency but the root with the output directory
 * (`build/.staging/main/sections/a.tex` for `sections/a.tex`); `outPrefix` (native, relative) undoes that.
 */
export function parseDeps(mk: string, dir: string, outPrefix: string): string[] {
  const out = new Set<string>();
  const body = mk.replace(/\\\r?\n/g, " ");
  for (const line of body.split(/\r?\n/)) {
    const colon = line.search(/(?<!\\):\s/);
    if (colon < 0) continue;
    for (const tok of line.slice(colon + 1).match(/(?:\\ |\S)+/g) ?? []) {
      let rel = relative(dir, resolve(dir, tok.replace(/\\ /g, " ")));
      if (rel.startsWith(outPrefix + sep) && !existsSync(resolve(dir, rel))) rel = rel.slice(outPrefix.length + 1);
      if (!rel.startsWith("..") && !isAbsolute(rel)) out.add(posix(rel));
    }
  }
  return [...out];
}

interface ExecResult {
  code: number | null;
  output: string;
  spawnError?: string;
}

function exec(command: string[], args: string[], cwd: string): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const child = spawn(command[0], [...command.slice(1), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (b: Buffer) => (output += b));
  child.stderr.on("data", (b: Buffer) => (output += b));
  child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, output, spawnError: e.code ?? e.message }));
  child.on("close", (code) => resolve({ code, output }));
  return promise;
}
