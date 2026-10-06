import { build } from "./build.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyAssets, listAssets } from "../assets.ts";
import { CONFIG_FILE, renderConfig, UsageError } from "../config.ts";
import { ensureGit } from "./project.ts";
import { setupAgent } from "./agent.ts";

/** Template names: the directories under templates/ ("_shared" and other "_" ones are not templates). */
export function templates(): string[] {
  const dirs = listAssets("templates/").map((rel) => rel.split("/")).filter((parts) => parts.length > 2);
  const names = dirs.map((parts) => parts[1]).filter((t) => !t.startsWith("_") && !t.startsWith("."));
  return [...new Set(names)];
}

export async function init(target: string, template: string, force: boolean): Promise<number> {
  const dir = resolve(target);
  if (!templates().includes(template)) throw new UsageError(`unknown template "${template}"; available: ${templates().join(", ")}`);
  if (existsSync(join(dir, CONFIG_FILE)) && !force) throw new UsageError(`${dir} already has ${CONFIG_FILE} (use --force to overwrite template files)`);
  for (const prefix of ["templates/_shared/", `templates/${template}/`]) await copyAssets(prefix, dir, { force });
  writeFileSync(join(dir, CONFIG_FILE), renderConfig(["main.tex"]));
  await setupAgent(dir);
  await ensureGit(dir); // After the kit, so the initial commit includes .omp/.
  console.log(`created ${template} project in ${dir}\n\nnext:\n  cd ${dir}\n  ternlatex dev`);
  // First build fetches packages; doing it now makes the first `dev` instant.
  return build(dir, false);
}
