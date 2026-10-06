import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, UsageError } from "../config.ts";
import { askOmp } from "../proofread.ts";
import { type Position, rewrite } from "../rewrite.ts";

/** `rewrite FILE:LINE:COL [--to LINE:COL] [--count N] [--instruction TEXT] [--json]`; see src/rewrite.ts. */
export async function rewriteCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { to: { type: "string" }, count: { type: "string" }, instruction: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const m = positionals.length === 1 ? /^(.+):(\d+):(\d+)$/.exec(positionals[0]) : null;
  if (!m) throw new UsageError("rewrite needs FILE:LINE:COL");
  const file = resolve(m[1]);
  if (!existsSync(file)) throw new UsageError(`${m[1]} does not exist`);
  const cfg = loadConfig();
  const rel = relative(cfg.dir, file);
  if (rel.startsWith("..") || resolve(cfg.dir, rel) !== file) throw new UsageError(`${m[1]} is not in the project ${cfg.dir}`);
  let to: Position | undefined;
  if (values.to !== undefined) {
    const t = /^(\d+):(\d+)$/.exec(values.to);
    if (!t) throw new UsageError(`--to needs LINE:COL, got "${values.to}"`);
    to = { line: Number(t[1]), col: Number(t[2]) };
  }
  const count = values.count === undefined ? cfg.rewrite.count : Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new UsageError(`--count must be from 1 to 9, got "${values.count}"`);
  const result = await rewrite(cfg, { file, at: { line: Number(m[2]), col: Number(m[3]) }, to, count, instruction: values.instruction?.trim() || undefined }, (system, input) =>
    askOmp(cfg, cfg.rewrite.model, system, input),
  );
  if (values.json) {
    console.log(JSON.stringify(result));
    return 0;
  }
  console.log(`${result.file}:${result.from.line}:${result.from.col}–${result.to.line}:${result.to.col}\n  ${result.text.replace(/\s+/g, " ")}\n`);
  result.alternatives.forEach((a, i) => console.log(`${i + 1}. ${a.text.replace(/\s+/g, " ")}${a.note ? `  (${a.note})` : ""}`));
  if (result.rejected) console.log(`(${result.rejected} rejected: they changed LaTeX markup)`);
  return result.alternatives.length ? 0 : 1;
}
