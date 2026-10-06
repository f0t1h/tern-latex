import { existsSync, readFileSync } from "node:fs";
import { loadConfig, paths } from "../config.ts";

/** Lists documents with their last build result from build/status.json. */
export function docs(): number {
  const cfg = loadConfig();
  const file = paths(cfg).status;
  const v: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const statuses = v && typeof v === "object" && "docs" in v && Array.isArray(v.docs) ? v.docs : [];
  for (const d of cfg.docs) {
    const s: unknown = statuses.find((x: unknown) => Boolean(x && typeof x === "object" && "doc" in x && x.doc === d.name));
    const ok = s && typeof s === "object" && "ok" in s ? s.ok : null;
    const errors = s && typeof s === "object" && "diagnostics" in s && Array.isArray(s.diagnostics) ? s.diagnostics.filter((x: unknown) => Boolean(x && typeof x === "object" && "severity" in x && x.severity === "error")).length : 0;
    const state = ok === true ? "ok" : ok === false ? `FAILED (${errors} errors)` : "not built";
    console.log(`${d.name}\t${d.root}\t${state}`);
  }
  return 0;
}
