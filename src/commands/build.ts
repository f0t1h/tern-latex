import { Builder, failedPdf, type ProjectStatus, type Status } from "../builder.ts";
import { loadConfig, resolveDoc } from "../config.ts";
import { projectHooks } from "../hooks.ts";
import { formatDiagnostic } from "../diagnostics.ts";
import { post, runningServer } from "./remote.ts";

/** Builds every document, or just `docName`; exit 1 if any failed. Sources an earlier build saw reuse its PDF unless `force`. */
export async function build(target: string, all: boolean, docName?: string, force = false): Promise<number> {
  const cfg = loadConfig(target);
  const doc = docName === undefined ? undefined : resolveDoc(cfg, docName);
  const server = runningServer(cfg);
  let statuses: Status[];
  if (server) {
    // Same queue as the watcher: no concurrent compiles into one staging directory.
    const res = await post(server, "/build", { ...(doc ? { doc: doc.name } : {}), force });
    if (!isProjectStatus(res.body)) throw new Error(`dev server at ${server.url} answered unexpectedly`);
    statuses = res.body.docs;
  } else {
    statuses = await new Builder(cfg, projectHooks(cfg)).request(doc ? [doc.name] : undefined, { force });
  }
  const several = cfg.docs.length > 1;
  for (const status of statuses) {
    const shown = status.diagnostics.filter((d) => all || d.severity !== "info");
    if (several) console.log(`── ${status.doc} (${status.root})`);
    for (const d of shown) console.log(formatDiagnostic(d));
    const count = (s: string) => status.diagnostics.filter((d) => d.severity === s).length;
    const hidden = status.diagnostics.length - shown.length;
    console.log(
      `${status.ok ? "ok" : status.partial ? "PARTIAL" : "FAILED"}: ${status.root} ${status.cached ? "same sources as an earlier build, reused its PDF (--force compiles)" : `in ${((status.durationMs ?? 0) / 1000).toFixed(1)}s`} — ${count("error")} errors, ${count("warning")} warnings${hidden ? `, ${hidden} info (--all)` : ""}${status.ok ? "" : `; ${failedPdf(status)}`}`,
    );
  }
  return statuses.every((s) => s.ok) ? 0 : 1;
}

/** A dev server's /build and /status answer. */
export function isProjectStatus(v: unknown): v is ProjectStatus {
  return Boolean(v && typeof v === "object" && "docs" in v && Array.isArray(v.docs));
}
