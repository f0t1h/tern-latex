import { loadConfig, resolveDoc, UsageError } from "../config.ts";
import { parseLocation } from "./project.ts";
import { post, runningServer } from "./remote.ts";

/** Forward search: scrolls the live viewer to a source line (switching document if needed) and highlights it. */
export async function show(spec: string, docName?: string): Promise<number> {
  const cfg = loadConfig();
  const server = runningServer(cfg);
  if (!server) throw new UsageError("no dev server running for this project; start `ternlatex dev`");
  const loc = parseLocation(spec);
  const res = await post(server, "/forward", docName === undefined ? loc : { ...loc, doc: resolveDoc(cfg, docName).name });
  if (res.status !== 200) {
    const msg = res.body && typeof res.body === "object" && "error" in res.body ? String(res.body.error) : `HTTP ${res.status}`;
    console.error(`ternlatex: ${spec}: ${msg}`);
    return 1;
  }
  const b = res.body;
  const page = b && typeof b === "object" && "page" in b ? b.page : "?";
  const doc = b && typeof b === "object" && "doc" in b ? b.doc : "?";
  const viewers = b && typeof b === "object" && "viewers" in b ? b.viewers : 0;
  console.log(`${spec} → ${cfg.docs.length > 1 ? `${doc}, ` : ""}page ${page}${viewers === 0 ? " (no viewer connected)" : ""}`);
  return 0;
}
