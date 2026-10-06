import { parseArgs } from "node:util";
import { loadConfig, resolveDoc } from "../config.ts";
import { outline } from "../outline.ts";

/** `outline [--doc NAME] [--json]`: the document's sections, floats and labelled equations, then reference problems. */
export function outlineCommand(args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { doc: { type: "string" }, json: { type: "boolean", default: false } } });
  const cfg = loadConfig();
  const o = outline(cfg, resolveDoc(cfg, values.doc));
  if (values.json) {
    console.log(JSON.stringify(o));
    return 0;
  }
  for (const i of o.items) {
    const head = i.kind === "figure" || i.kind === "table" || i.kind === "equation" ? `${i.kind} ` : "";
    console.log(`${"  ".repeat(i.level - 1)}${head}${i.number ? `${i.number} ` : ""}${i.title || "(untitled)"}  ${i.file}:${i.line}${i.label ? ` [${i.label}]` : ""}`);
  }
  if (o.problems.length) console.log(`\nproblems (${o.problems.length}):`);
  for (const p of o.problems) console.log(`${p.file}:${p.line}: ${p.kind}: ${p.key}`);
  return 0;
}
