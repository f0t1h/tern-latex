import { parseArgs } from "node:util";
import { type Change, importPdfComments } from "../changes.ts";
import { resolveReview, reviewItems, reviewList } from "../suggestions.ts";
import { loadConfig, resolveDoc, UsageError } from "../config.ts";

/** `changes [--author ID] [--json]`, `accept|reject (ID…|--author ID|--all)`, `comments import FILE.pdf --author ID [--doc NAME]`. */
export async function review(sub: string, args: string[]): Promise<number> {
  const cfg = loadConfig();
  switch (sub) {
    case "changes": {
      const { values } = parseArgs({ args, allowPositionals: false, options: { author: { type: "string" }, json: { type: "boolean", default: false } } });
      if (values.json) {
        // Same shape as the dev server's GET /changes (the Tern plugin's Review block reads it).
        const list = reviewList(cfg);
        console.log(JSON.stringify({ ...list, items: list.items.filter((c) => values.author === undefined || c.author === values.author) }));
        return 0;
      }
      const items = reviewItems(cfg).filter((c) => values.author === undefined || c.author === values.author);
      if (!items.length) {
        console.log(values.author ? `no open changes by ${values.author}` : "no open changes");
        return 0;
      }
      for (const c of items) console.log(`${c.id}  ${c.kind.padEnd(9)}  ${(c.author ?? "-").padEnd(6)}  ${c.file}:${c.line}  ${describe(c)}`);
      const per = new Map<string, number>();
      for (const c of items) per.set(c.author ?? "(anonymous)", (per.get(c.author ?? "(anonymous)") ?? 0) + 1);
      console.error(`${items.length} open: ${[...per].map(([a, n]) => `${a} ${n}`).join(", ")}`);
      return 0;
    }
    case "accept":
    case "reject": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { author: { type: "string" }, all: { type: "boolean", default: false } } });
      const modes = [positionals.length > 0, values.author !== undefined, values.all].filter(Boolean).length;
      if (modes !== 1) throw new UsageError(`${sub} needs exactly one of: change ids, --author ID, --all`);
      const ids = positionals.length ? positionals : reviewItems(cfg).filter((c) => values.all || c.author === values.author).map((c) => c.id);
      if (!ids.length) {
        console.log("nothing to resolve");
        return 0;
      }
      const n = await resolveReview(cfg, ids, sub);
      console.log(`${sub === "accept" ? "accepted" : "rejected"} ${n} change${n === 1 ? "" : "s"}`);
      return 0;
    }
    case "comments": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { author: { type: "string" }, doc: { type: "string" } } });
      if (positionals[0] !== "import" || !positionals[1]) throw new UsageError("usage: ternlatex comments import FILE.pdf --author ID [--doc NAME]");
      if (!values.author) throw new UsageError("comments import needs --author ID (an id from [review] authors)");
      const r = await importPdfComments(cfg, resolveDoc(cfg, values.doc), positionals[1], values.author);
      for (const n of r.notes) console.error(n);
      console.log(`imported ${r.inserted} comment${r.inserted === 1 ? "" : "s"} by ${values.author}${r.unmapped ? `, ${r.unmapped} not on their line` : ""}; list them with \`ternlatex changes --author ${values.author}\``);
      return 0;
    }
    default:
      throw new UsageError(`unknown review command "${sub}"`);
  }
}

function describe(c: Change): string {
  const one = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > 70 ? `${t.slice(0, 69)}…` : t;
  };
  const note = c.comment ? `  [${one(c.comment)}]` : "";
  return c.kind === "replaced" ? `${one(c.text)}  (was: ${one(c.old ?? "")})${note}` : `${one(c.text)}${note}`;
}
