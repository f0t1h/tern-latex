import { loadConfig, UsageError } from "../config.ts";
import { parseLocation } from "./project.ts";
import { post, runningServer } from "./remote.ts";

/** `table FILE:LINE`: opens the viewer's table editor on the table at that line (the Tern editor's Edit table). */
export async function table(spec: string): Promise<number> {
  const cfg = loadConfig();
  const server = runningServer(cfg);
  if (!server) throw new UsageError("no dev server running for this project; start `ternlatex dev`");
  const res = await post(server, "/table/open", parseLocation(spec));
  const b = res.body;
  if (res.status !== 200) {
    console.error(`ternlatex: ${spec}: ${b && typeof b === "object" && "error" in b ? String(b.error) : `HTTP ${res.status}`}`);
    return 1;
  }
  const viewers = b && typeof b === "object" && "viewers" in b ? b.viewers : 0;
  const at = b && typeof b === "object" && "file" in b && "line" in b ? `${b.file}:${b.line}` : spec;
  console.log(viewers === 0 ? `${at}: no viewer connected to open it in` : `${at}: opened in the viewer`);
  return viewers === 0 ? 1 : 0;
}
