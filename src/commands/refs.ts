import { parseArgs } from "node:util";
import { loadConfig, UsageError } from "../config.ts";
import { definedKeys, findReferences, importCitations, searchZotero, ZoteroError } from "../zotero.ts";

/** `refs sync` | `refs search QUERY… [--limit N]` | `refs add KEY…` | `refs find [QUERY…] [--limit N] [--json]`, against the project's .bib files and [zotero] library. */
export async function refs(sub: string, args: string[]): Promise<number> {
  const cfg = loadConfig();
  try {
    switch (sub) {
      case "sync":
      case "add": {
        const keys = parseArgs({ args, allowPositionals: true, options: {} }).positionals;
        if (sub === "sync" && keys.length) throw new UsageError("refs sync takes no arguments; use `refs add KEY…`");
        if (sub === "add" && !keys.length) throw new UsageError("refs add needs one or more citation keys");
        const present = sub === "add" ? keys.filter((k) => definedKeys(cfg).has(k)) : [];
        const { added, missing } = await importCitations(cfg, sub === "add" ? keys : undefined);
        if (present.length) console.log(`present: ${present.join(", ")}`);
        console.log(`added: ${added.join(", ") || "none"}${added.length ? ` (→ ${cfg.zotero.bib})` : ""}`);
        console.log(`missing: ${missing.join(", ") || "none"}`);
        return missing.length ? 1 : 0;
      }
      case "find": {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { limit: { type: "string", default: "25" }, json: { type: "boolean", default: false } } });
        const limit = Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive integer, got "${values.limit}"`);
        const found = await findReferences(cfg, positionals.join(" ").trim(), limit);
        if (values.json) {
          console.log(JSON.stringify(found));
          return 0;
        }
        for (const h of found.items) console.log([h.key, h.year, h.creators, h.title, h.source].map((f) => f.replace(/\s+/g, " ")).join("\t"));
        if (found.zotero_error) console.error(`zotero: ${found.zotero_error}`);
        return found.items.length ? 0 : 1;
      }
      case "search": {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { limit: { type: "string", default: "25" } } });
        const query = positionals.join(" ").trim();
        if (!query) throw new UsageError("refs search needs a query (title words, author, year)");
        const limit = Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive integer, got "${values.limit}"`);
        const hits = await searchZotero(cfg, query, limit);
        for (const h of hits) console.log([h.key, h.year ?? "", h.creators, h.title].map((f) => f.replace(/\s+/g, " ")).join("\t"));
        if (!hits.length) console.error(`no Zotero items match "${query}"`);
        return hits.length ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown refs command "${sub ?? ""}"; use sync, search QUERY…, find [QUERY…] or add KEY…`);
    }
  } catch (e) {
    if (!(e instanceof ZoteroError)) throw e;
    console.error(`ternlatex: ${e.message}`);
    return 1;
  }
}
