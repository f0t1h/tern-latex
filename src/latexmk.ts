import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { type Config, type DocConfig, docName, type EngineName, posix } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";
import type { TexEngine } from "./tools.ts";

/**
 * Builds with an installed TeX distribution's pdfLaTeX, XeLaTeX or LuaLaTeX, run by latexmk (engine.ts compile
 * keeps Tectonic's own path): its arguments and environment, the files a run read (latexmk's `-recorder` .fls
 * list), and on TinyTeX the packages a document misses, installed the way Tectonic downloads them.
 */

export type TexEngineName = Exclude<EngineName, "tectonic">;

const FLAG: Record<TexEngineName, string> = { pdflatex: "-pdf", xelatex: "-pdfxe", lualatex: "-pdflua" };

/**
 * latexmk's arguments for DOC. pdfLaTeX's classic fonts store ligatures and accented letters in the PDF text
 * without their Unicode (search finds no "first" or "Karaoğlanoğlu"): `cmap`, loaded before the document,
 * maps them. `-usepretex` names the job after the first file read, so the job name is given.
 */
export function latexmkArgs(cfg: Config, doc: DocConfig, staging: string, engine: TexEngineName): string[] {
  return [
    FLAG[engine],
    ...cfg.latexmkArgs,
    "-recorder",
    "-synctex=1",
    "-interaction=nonstopmode",
    "-file-line-error",
    `-outdir=${staging}`,
    `-jobname=${docName(doc.root)}`,
    ...(engine === "pdflatex" ? ["-usepretex=\\RequirePackage{cmap}"] : []),
    doc.root,
  ];
}

/** The run's environment: the distribution's bin directory first; PLACEHOLDERS on TeX's input path when given. */
export function latexmkEnv(tex: TexEngine, placeholders?: string): Record<string, string> {
  return {
    PATH: [tex.binDir, process.env.PATH ?? ""].join(delimiter),
    // A trailing separator keeps TeX's own search path after the placeholders.
    ...(placeholders ? { TEXINPUTS: `${placeholders}${delimiter}${process.env.TEXINPUTS ?? ""}` } : {}),
  };
}

/** The .fls latexmk's `-recorder` leaves for DOC in STAGING. */
export function flsPath(doc: DocConfig, staging: string): string {
  return join(staging, `${docName(doc.root)}.fls`);
}

/** Project files a run read, from latexmk's `-recorder` list (`PWD dir`, `INPUT path` lines): not its outputs, nor TeX's own. */
export function recordedDeps(fls: string, dir: string, outdir: string): string[] {
  const cwd = /^PWD (.*)$/m.exec(fls)?.[1]?.trim() ?? dir;
  const out = new Set<string>();
  for (const m of fls.matchAll(/^INPUT (.*)$/gm)) {
    const abs = resolve(cwd, m[1].trim());
    const rel = relative(dir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const p = posix(rel);
    if (p === outdir || p.startsWith(`${outdir}/`) || !existsSync(abs)) continue;
    out.add(p);
  }
  return [...out].sort();
}

/** `File `x.sty' not found` errors: the package and class files a document misses. */
export function missingPackages(diagnostics: Diagnostic[]): string[] {
  const names = diagnostics.flatMap((d) => [...d.message.matchAll(/File [`'"]([^`'"]+\.(?:sty|cls|def|cfg|clo|fd|bst))['"] not found/g)].map((m) => m[1]));
  return [...new Set(names)];
}

/** Runs ARGS to the end (asynchronously: a dev server keeps answering while packages install); stdout and exit code. */
async function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout };
}

/**
 * Installs the TeX Live packages holding FILES with TinyTeX's tlmgr (no admin rights needed); returns what it
 * installed, file → package, and the files no package holds or that failed to install.
 */
export async function installPackages(tlmgr: string, files: string[]): Promise<{ installed: Record<string, string>; failed: string[] }> {
  const installed: Record<string, string> = {};
  const failed: string[] = [];
  for (const file of files) {
    const search = await run([tlmgr, "search", "--global", "--file", `/${file}`], 60_000);
    const pkg = /^([A-Za-z0-9_.-]+):$/m.exec(search.stdout)?.[1];
    if (!pkg || (await run([tlmgr, "install", pkg], 300_000)).code !== 0) failed.push(file);
    else installed[file] = pkg;
  }
  return { installed, failed };
}
