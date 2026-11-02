import { Builder } from "../builder.ts";
import { loadConfig } from "../config.ts";
import { projectHooks } from "../hooks.ts";
import { type PushResult, pushOverleaf } from "../overleaf.ts";
import { post, runningServer } from "./remote.ts";

/**
 * `push [-m MESSAGE] [--json]`: sends the clone's edits to Overleaf (src/overleaf.ts pushOverleaf), through the
 * running dev server when there is one (its build queue, and the viewer learns the new state). Exit 1 when nothing
 * could be pushed for a reason the user has to deal with.
 */
export async function push(message: string | undefined, json: boolean): Promise<number> {
  const cfg = loadConfig();
  const server = runningServer(cfg);
  let r: PushResult;
  if (server) {
    const res = await post(server, "/overleaf/push", { message });
    if (!isPushResult(res.body)) throw new Error(`dev server at ${server.url} answered unexpectedly`);
    r = res.body;
  } else {
    const builder = new Builder(cfg, projectHooks(cfg));
    r = await pushOverleaf(cfg, { message, build: () => builder.request() });
  }
  if (json) console.log(JSON.stringify(r));
  else if (r.problem) console.error(`ternlatex: ${r.problem}`);
  else {
    const pulled = r.pulled ? `pulled ${r.pulled} commit(s) from Overleaf first; ` : "";
    const committed = r.committed.length ? ` (committed ${r.committed.join(", ")})` : "";
    console.log(r.pushed ? `${pulled}pushed ${r.pushed} commit(s) to Overleaf${committed}` : `${pulled}nothing to push: Overleaf has all your commits`);
  }
  return r.problem ? 1 : 0;
}

export function isPushResult(v: unknown): v is PushResult {
  return Boolean(v && typeof v === "object" && "pushed" in v && typeof v.pushed === "number" && "committed" in v && Array.isArray(v.committed));
}
