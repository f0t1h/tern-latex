import { loadConfig } from "../config.ts";
import { pullOverleaf } from "../overleaf.ts";

/**
 * `pull [--json]`: brings a clone of an Overleaf project up to date with Overleaf (src/overleaf.ts); does nothing in
 * other projects. omp's extension runs it before omp's first edit of each request. Exit 1 when it could not.
 */
export async function pull(json: boolean): Promise<number> {
  const cfg = loadConfig();
  const r = await pullOverleaf(cfg.dir);
  if (json) console.log(JSON.stringify(r));
  else if (!r.overleaf) console.log("not an Overleaf clone (its branch tracks no git.overleaf.com remote); nothing to do");
  else if (r.problem) console.error(`ternlatex: ${r.problem}`);
  else if (!r.pulled) console.log("up to date with Overleaf");
  else console.log(`pulled ${r.pulled} commit(s) from Overleaf: ${r.files.join(", ")}`);
  return r.problem ? 1 : 0;
}
