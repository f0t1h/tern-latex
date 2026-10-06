import { loadConfig, resolveDoc, UsageError } from "../config.ts";
import { formatDiagnostic } from "../diagnostics.ts";
import { isProjectStatus } from "./build.ts";
import { post, runningServer } from "./remote.ts";

/**
 * Hands the last build's errors and warnings of every document (or one) to omp through the running dev server,
 * as the viewer's Fix button does; exit 2 without a dev server.
 */
export async function fix(docName?: string): Promise<number> {
  const cfg = loadConfig();
  const doc = docName === undefined ? undefined : resolveDoc(cfg, docName);
  const server = runningServer(cfg);
  if (!server) throw new UsageError("no dev server running for this project; start `ternlatex dev`");
  const status: unknown = await (await fetch(new URL("/status", server.url))).json();
  if (!isProjectStatus(status)) throw new Error(`dev server at ${server.url} answered unexpectedly`);
  const todo = status.docs
    .filter((s) => !doc || s.doc === doc.name)
    .map((s) => ({ s, items: s.diagnostics.filter((d) => d.severity !== "info") }))
    .filter((t) => t.items.length > 0);
  if (!todo.length) {
    console.log("nothing to fix");
    return 0;
  }
  let failed = false;
  for (const { s, items } of todo) {
    const res = await post(server, "/fix", { doc: s.doc, diagnostics: items });
    if (res.status !== 200) {
      const msg = res.body && typeof res.body === "object" && "error" in res.body ? String(res.body.error) : `HTTP ${res.status}`;
      console.error(`ternlatex: ${s.doc}: ${msg}`);
      failed = true;
      continue;
    }
    const sent = res.body && typeof res.body === "object" && "sent" in res.body && typeof res.body.sent === "number" ? res.body.sent : items.length;
    console.log(`sent ${sent} of ${s.doc}'s diagnostics (${s.root}) to omp:`);
    for (const d of items.slice(0, sent)) console.log(`  ${formatDiagnostic(d)}`);
  }
  return failed ? 1 : 0;
}
