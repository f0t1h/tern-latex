import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { findProject, loadConfig, UsageError } from "../config.ts";
import { resolveTool } from "../tools.ts";

/**
 * Reports whether TeX files (classes, packages, .bst) exist in the bundle, with their declared version.
 * Outside a Tectonic workspace `bundle cat` reads the default bundle, which resolves to the same TeX Live
 * 2022 tarball ternlatex pins.
 */
export async function bundle(files: string[]): Promise<number> {
  if (!files.length) throw new UsageError("bundle needs file names, e.g. `ternlatex bundle IEEEtran.cls acmart.cls`");
  const project = findProject(process.cwd());
  const [tectonic, ...pre] = (await resolveTool("tectonic", project ? loadConfig(project) : undefined)).command;
  let missing = 0;
  for (const file of files) {
    const r = spawnSync(tectonic, [...pre, "-X", "bundle", "cat", file], { cwd: tmpdir(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`cannot run ${tectonic}: ${r.error.message}`);
    if (r.status !== 0) {
      missing++;
      console.log(`${file}: missing`);
      continue;
    }
    // .bst/.tex files carry no \Provides… declaration; anything matched there would be a false version.
    const decl = /\.(cls|sty|def|clo)$/.test(file) ? /\\Provides(?:Class|Package|File)\s*\{[^}]*\}\s*(?:%[^\n]*\n\s*)*\[([^\]]*)\]/.exec(r.stdout) : null;
    console.log(`${file}: found${decl ? ` ${decl[1].replace(/\s+/g, " ").trim()}` : ""}`);
  }
  return missing ? 1 : 0;
}
