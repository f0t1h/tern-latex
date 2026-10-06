import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Config, type DocConfig, docPaths, posix } from "./config.ts";
import { type Diagnostic, mergeDiagnostics, parseLog, parseTectonicOutput } from "./diagnostics.ts";
import { resolveTool, ToolMissingError } from "./tools.ts";

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Files in the staging directory; pdf/synctex only meaningful when ok. */
  pdf: string;
  synctex: string;
  log: string;
  /** Project-relative files this run read; null when the engine cannot tell (latexmk). */
  deps: string[] | null;
}

/** Compiles one document into its staging directory. Never touches the published outputs. */
export async function compile(cfg: Config, doc: DocConfig): Promise<CompileResult> {
  const p = docPaths(cfg, doc);
  await mkdir(p.staging, { recursive: true });
  const staged = p.staged;
  const started = Date.now();
  const args =
    cfg.engine === "tectonic"
      ? ["-X", "compile", "--synctex", "--keep-logs", "--keep-intermediates", "--bundle", cfg.bundle, "--makefile-rules", p.deps, "--outdir", p.staging, doc.root]
      : [...cfg.latexmkArgs, "-synctex=1", "-interaction=nonstopmode", "-file-line-error", `-outdir=${p.staging}`, doc.root];
  let command: string[];
  try {
    command = (await resolveTool(cfg.engine, cfg)).command;
  } catch (e) {
    if (!(e instanceof ToolMissingError)) throw e;
    return { ok: false, ...staged, deps: null, diagnostics: [{ severity: "error", message: e.message }] };
  }
  const cmd = cfg.engine;
  const run = await exec(command, args, cfg.dir);
  if (run.spawnError) return { ok: false, ...staged, deps: null, diagnostics: [{ severity: "error", message: `cannot run ${command[0]}: ${run.spawnError}` }] };
  const fresh = (f: string) => existsSync(f) && statSync(f).mtimeMs >= started - 1000;
  const logText = fresh(staged.log) ? readFileSync(staged.log, "utf8") : "";
  const ok = run.code === 0 && fresh(staged.pdf);
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
  const deps = ok && fresh(p.deps) ? parseDeps(readFileSync(p.deps, "utf8"), cfg.dir, relative(cfg.dir, p.staging)) : null;
  return { ok, ...staged, deps, diagnostics };
}

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
