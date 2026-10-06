import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { resolveTool } from "../tools.ts";

/** chktex over the given files, or every .tex file in the project, in `file:line: severity: message` form. */
export async function lint(files: string[]): Promise<number> {
  const cfg = loadConfig();
  const targets = files.length ? files.map((f) => relative(cfg.dir, resolve(f))) : texFiles(cfg.dir, cfg.outdir);
  if (!targets.length) {
    console.log("no .tex files");
    return 0;
  }
  const [chktex, ...pre] = (await resolveTool("chktex", cfg)).command;
  // -q: no banner; -f: one machine-readable line per finding.
  const r = spawnSync(chktex, [...pre, "-q", "-f", "%f:%l:%c: warning: %m [chktex %n]\n", ...targets], { cwd: cfg.dir, encoding: "utf8" });
  if (r.error) throw new Error(`cannot run ${chktex}: ${r.error.message}`);
  const out = r.stdout.trim();
  console.log(out || "chktex: no findings");
  if (r.stderr.trim()) console.error(r.stderr.trim());
  return 0;
}

/** Project .tex files (native relative paths), skipping the outdir, dot-directories and node_modules. */
function texFiles(dir: string, outdir: string): string[] {
  const out = relative(dir, resolve(dir, outdir));
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tex") && !f.startsWith(out + sep) && !f.split(sep).some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
}
