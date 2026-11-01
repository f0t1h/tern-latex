import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { docPaths, loadConfig, resolveDoc, UsageError } from "../config.ts";
import { SearchIndex } from "../search.ts";
import { SyncTex } from "../synctex.ts";

/** `search QUERY… [--doc NAME] [--json]`: fuzzy search of the last build's PDF text and the document's LaTeX prose. */
export async function searchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { doc: { type: "string" }, json: { type: "boolean", default: false } } });
  const query = positionals.join(" ");
  if (!query.trim()) throw new UsageError("search needs a QUERY");
  const cfg = loadConfig();
  const doc = resolveDoc(cfg, values.doc);
  const p = docPaths(cfg, doc);
  const synctex = existsSync(p.synctex) ? await SyncTex.load(p.synctex, cfg.dir) : null;
  const result = await new SearchIndex(cfg).search(doc, query, synctex);
  if (values.json) {
    console.log(JSON.stringify(result));
    return 0;
  }
  if (!existsSync(p.pdf)) console.error("no PDF yet: searching the source only; run `ternlatex build`");
  for (const h of result.hits) {
    const where = [h.page === undefined ? undefined : `p.${h.page}`, h.source ? `${h.source.file}:${h.source.line}` : undefined].filter(Boolean).join("  ");
    console.log(`${where}  ${h.in === "both" ? "" : `(${h.in} only) `}${h.before}[${h.match}]${h.after}`);
  }
  if (result.truncated) console.log(`… more than ${result.hits.length} places; narrow the query`);
  return result.hits.length ? 0 : 1;
}
