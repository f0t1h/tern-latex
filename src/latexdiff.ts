import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Config, type DocConfig, docPaths, paths, posix } from "./config.ts";
import { type Diagnostic, mergeDiagnostics, parseLog, parseTectonicOutput } from "./diagnostics.ts";
import { extractTar } from "./download.ts";
import { resolveTool } from "./tools.ts";
import { gitOk, resolveRev } from "./vcs.ts";

export interface DiffResult {
  ok: boolean;
  /** The published diff PDF (docPaths(cfg, doc).diff); only fresh when ok. */
  pdf: string;
  diagnostics: Diagnostic[];
}

/**
 * Second attempt when latexdiff's markup breaks the build: no math markup, none inside headings, and
 * TikZ pictures diffed as whole blocks (markup inside node text trips TikZ's parser).
 */
const SAFE_OPTIONS = [
  "--math-markup=0",
  "--exclude-textcmd=chapter,section,subsection,subsubsection,paragraph",
  "--config=PICTUREENV=(?:picture|DIFnomarkup|tikzpicture)[\\w\\d*@]*",
];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function run(command: string[], args: string[], cwd: string): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const child = spawn(command[0], [...command.slice(1), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => (stdout += b));
  child.stderr.on("data", (b: Buffer) => (stderr += b));
  child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError: e.code ?? e.message }));
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

/** One diff build per document at a time: they share the temp .tex and the private outdir. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Redlines document DOC at REV (any git revision) against the working tree: latexdiff --flatten,
 * compiled with Tectonic into docPaths(cfg, doc).diff. The published PDF only changes on success.
 */
export function buildDiff(cfg: Config, doc: DocConfig, rev: string): Promise<DiffResult> {
  const key = `${cfg.dir}\0${doc.name}`;
  const next = (inflight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => diffNow(cfg, doc, rev));
  inflight.set(key, next);
  return next;
}

async function diffNow(cfg: Config, doc: DocConfig, rev: string): Promise<DiffResult> {
  const dp = docPaths(cfg, doc);
  const fail = (message: string): DiffResult => ({ ok: false, pdf: dp.diff, diagnostics: [{ severity: "error", message }] });
  const old = await mkdtemp(join(tmpdir(), "ternlatex-diff-"));
  // Next to the root, so \includegraphics, \usepackage{style/…} and \bibliography resolve as in the real build.
  const texRel = join(dirname(doc.root), `.ternlatex-diff-${doc.name}.tex`);
  const tex = join(cfg.dir, texRel);
  try {
    const sha = await resolveRev(cfg, rev);
    // The project may sit in a subdirectory of the repository; archive just that part.
    const prefix = await gitOk(cfg.dir, ["rev-parse", "--show-prefix"]);
    const tar = join(old, ".rev.tar");
    await gitOk(cfg.dir, ["archive", "--format=tar", "-o", tar, sha, "--", prefix || "."]);
    await extractTar(await readFile(tar), old);
    const oldRoot = join(old, prefix, doc.root);
    if (!existsSync(oldRoot)) return fail(`${doc.root} does not exist at ${rev}`);

    const first = await attempt(cfg, oldRoot, doc, tex, texRel, []);
    if (first.ok || first.latexdiffFailed) return first.result;
    const second = await attempt(cfg, oldRoot, doc, tex, texRel, SAFE_OPTIONS);
    const note: Diagnostic = {
      severity: "info",
      message: second.ok
        ? `latexdiff markup broke the diff build; rebuilt with ${SAFE_OPTIONS.join(" ")}`
        : `the diff does not compile, even with ${SAFE_OPTIONS.join(" ")}`,
    };
    return { ...second.result, diagnostics: [note, ...second.result.diagnostics] };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    await rm(old, { recursive: true, force: true });
    await rm(tex, { force: true });
  }
}

interface Attempt {
  ok: boolean;
  /** latexdiff itself failed: retrying with other markup options will not help. */
  latexdiffFailed: boolean;
  result: DiffResult;
}

async function attempt(cfg: Config, oldRoot: string, doc: DocConfig, tex: string, texRel: string, options: string[]): Promise<Attempt> {
  const dp = docPaths(cfg, doc);
  const failed = (message: string): Attempt => ({
    ok: false,
    latexdiffFailed: true,
    result: { ok: false, pdf: dp.diff, diagnostics: [{ severity: "error", message }] },
  });
  // latexdiff resolves \input/\include relative to each root file's own directory, so each tree flattens itself.
  // A missing tool throws ToolMissingError, which diffNow reports.
  const latexdiff = (await resolveTool("latexdiff", cfg)).command;
  const ld = await run(latexdiff, ["--flatten", "--encoding=utf8", ...options, oldRoot, join(cfg.dir, doc.root)], cfg.dir);
  if (ld.spawnError) return failed(`cannot run ${latexdiff.join(" ")}: ${ld.spawnError}`);
  if (ld.code !== 0 || !ld.stdout.includes("\\begin{document}")) return failed(`latexdiff failed: ${ld.stderr.trim().split("\n").slice(-5).join("\n")}`);
  await writeFile(tex, ld.stdout);

  const stage = join(paths(cfg).out, ".diffstage", doc.name);
  await mkdir(stage, { recursive: true });
  const stem = basename(tex, ".tex");
  const pdf = join(stage, `${stem}.pdf`);
  await rm(pdf, { force: true });
  const tectonic = (await resolveTool("tectonic", cfg)).command;
  const tt = await run(tectonic, ["-X", "compile", "--keep-logs", "--bundle", cfg.bundle, "--outdir", stage, texRel], cfg.dir);
  if (tt.spawnError) return failed(`cannot run ${tectonic[0]}: ${tt.spawnError}`);
  const logFile = join(stage, `${stem}.log`);
  const log = existsSync(logFile) ? await readFile(logFile, "utf8") : "";
  // Parse while the flattened file exists: the parsers only attribute messages to files that exist.
  // Markup in headings always makes hyperref drop it from bookmarks; that is latexdiff's doing, not the user's.
  const diagnostics = mergeDiagnostics(parseTectonicOutput(tt.stdout + tt.stderr, cfg.dir), parseLog(log, cfg.dir))
    .filter((d) => !d.message.includes("Token not allowed in a PDF string"))
    .map((d) => (d.file === posix(texRel) ? { severity: d.severity, message: d.message } : d));
  const ok = tt.code === 0 && existsSync(pdf);
  if (ok) {
    await mkdir(dirname(dp.diff), { recursive: true });
    await rename(pdf, dp.diff);
  } else if (!diagnostics.some((d) => d.severity === "error")) {
    const tail = (tt.stdout + tt.stderr).trim().split("\n").slice(-5).join("\n");
    diagnostics.unshift({ severity: "error", message: `tectonic exited with ${tt.code}${tail ? `: ${tail}` : ""}` });
  }
  return { ok, latexdiffFailed: false, result: { ok, pdf: dp.diff, diagnostics } };
}
