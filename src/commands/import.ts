import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { copyAssets } from "../assets.ts";
import { CONFIG_FILE, posix, renderConfig, UsageError } from "../config.ts";
import { setupAgent } from "./agent.ts";
import { build } from "./build.ts";
import { ensureGit } from "./project.ts";
import { resolveTool } from "../tools.ts";

/** Formats pandoc converts to LaTeX; `.tex` is adopted as-is instead. */
const PANDOC_INPUT: Record<string, string> = {
  ".docx": "docx",
  ".odt": "odt",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".rtf": "rtf",
  ".epub": "epub",
};

/** Constructs Tectonic cannot run, with the way out. */
const INCOMPATIBLE: [RegExp, string][] = [
  [/\\usepackage(\[[^\]]*\])?\{minted\}/, "uses minted, which needs shell-escape: switch to listings, or set engine = \"latexmk\""],
  [/\\write18|\\immediate\\write18|\\ShellEscape/, "runs shell commands (\\write18): needs engine = \"latexmk\" with shell-escape"],
  [/\\usepackage(\[(?![^\]]*backend=bibtex)[^\]]*\])?\{biblatex\}/, "uses biblatex with biber, which Tectonic lacks: add backend=bibtex, or move to natbib"],
  [/\\usepackage(\[[^\]]*\])?\{(inputenc|fontenc)\}/, "loads inputenc/fontenc (pdfLaTeX-era); harmless under XeTeX, but fontspec handles fonts"],
];

export async function importProject(src: string, dest: string | undefined): Promise<number> {
  const abs = resolve(src);
  if (!existsSync(abs)) throw new UsageError(`${src} does not exist`);
  const ext = extname(abs).toLowerCase();
  if (!statSync(abs).isDirectory() && PANDOC_INPUT[ext]) return convert(abs, PANDOC_INPUT[ext], resolve(dest ?? basename(abs, extname(abs))));
  if (dest) throw new UsageError("existing .tex projects are adopted in place; drop the DIR argument");

  const [dir, roots] = statSync(abs).isDirectory() ? [abs, findRoots(abs)] : [dirname(abs), [basename(abs)]];
  for (const root of roots) {
    if (!/\\documentclass/.test(readFileSync(join(dir, root), "utf8"))) throw new UsageError(`${root} has no \\documentclass; pass the root file`);
  }
  if (!existsSync(join(dir, CONFIG_FILE))) writeFileSync(join(dir, CONFIG_FILE), renderConfig(roots));
  console.log(`adopted ${dir}: ${roots.length === 1 ? `root = ${roots[0]}` : `${roots.length} documents (${roots.join(", ")}); edit [[documents]] in ${CONFIG_FILE} to drop any`}`);
  for (const w of compatibility(dir)) console.warn(`warning: ${w}`);
  await setupAgent(dir);
  await ensureGit(dir); // After the kit, so the initial commit includes .omp/.
  return build(dir, false);
}

/** Root candidates (.tex files with \documentclass and \begin{document}), each becoming a document; main.tex first. */
function findRoots(dir: string): string[] {
  const candidates = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(posix)
    .filter((f) => f.endsWith(".tex") && f.split("/").length <= 2 && !f.split("/").some((s) => s.startsWith(".") || s === "build"))
    .filter((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return /^[^%\n]*\\documentclass/m.test(text) && /\\begin\{document\}/.test(text);
    })
    .sort((a, b) => Number(basename(b) === "main.tex") - Number(basename(a) === "main.tex") || a.localeCompare(b));
  if (!candidates.length) throw new UsageError(`no root .tex file (with \\documentclass and \\begin{document}) in ${dir}`);
  return candidates;
}

function compatibility(dir: string): string[] {
  const found: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" }).map(posix)) {
    if (!/\.(tex|sty|cls)$/.test(f) || f.split("/").some((s) => s.startsWith(".") || s === "build")) continue;
    const text = readFileSync(join(dir, f), "utf8").replace(/(^|[^\\])%.*$/gm, "$1");
    for (const [re, msg] of INCOMPATIBLE) if (re.test(text)) found.push(`${f} ${msg}`);
  }
  return found;
}

async function convert(src: string, from: string, dir: string): Promise<number> {
  if (existsSync(dir) && readdirSync(dir).length) throw new UsageError(`${dir} exists and is not empty; pass an empty or new DIR`);
  const [pandoc, ...pre] = (await resolveTool("pandoc")).command;
  mkdirSync(dir, { recursive: true });
  const args = [src, "--from", from, "--to", "latex", "--standalone", "--output", "main.tex", "--extract-media", "figures", "--resource-path", dirname(src)];
  if (from === "docx") args.push("--track-changes=accept");
  const r = spawnSync(pandoc, [...pre, ...args], { cwd: dir, encoding: "utf8" });
  if (r.error) throw new Error(`cannot run ${pandoc}: ${r.error.message}`);
  if (r.status !== 0) throw new UsageError(`pandoc failed: ${r.stderr.trim()}`);
  if (r.stderr.trim()) console.warn(r.stderr.trim());
  // The house style comes along so the cleanup skill can move the preamble onto it.
  await copyAssets("templates/_shared/", dir, { force: true });
  writeFileSync(join(dir, CONFIG_FILE), renderConfig(["main.tex"]));
  await setupAgent(dir);
  await ensureGit(dir);
  console.log(`converted ${src} → ${join(dir, "main.tex")}`);
  const code = await build(dir, false);
  console.log(`\nnext: cd ${dir} && ternlatex dev, then in omp: /skill:import-cleanup`);
  return code;
}
