import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Builder, type ProjectStatus, type Status } from "../builder.ts";
import { type Config, docPaths, loadConfig, resolveDoc, UsageError } from "../config.ts";
import { parseDeps } from "../engine.ts";
import { projectHooks } from "../hooks.ts";
import { formatHunk, type ProofreadResult, proofread, type Target } from "../proofread.ts";
import { post, runningServer } from "./remote.ts";

/** `ternlatex proofread [FILE[:FROM[-TO]]...] [--doc NAME] [--direct]` */
export async function proofreadCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { doc: { type: "string" }, direct: { type: "boolean", default: false } } });
  const cfg = loadConfig();
  const targets = positionals.length ? positionals.map((p) => parseTarget(cfg, p)) : values.doc ? docTargets(cfg, values.doc) : [];
  const server = runningServer(cfg);
  const build = async (): Promise<Status[]> => {
    if (!server) return new Builder(cfg, projectHooks(cfg)).request();
    const res = await post(server, "/build");
    return isProjectStatus(res.body) ? res.body.docs : [];
  };
  const result = await proofread(cfg, targets, {
    direct: values.direct,
    build,
    progress: (done, total) => process.stderr.write(`\rproofreading: ${done}/${total} paragraphs`),
  });
  process.stderr.write("\n");
  return report(result, values.direct);
}

function report(r: ProofreadResult, direct: boolean): number {
  for (const h of r.hunks) console.log(formatHunk(h));
  const skipped = Object.entries(r.skipped).map(([why, n]) => `${n} ${why}`).join(", ");
  if (r.reverted) {
    console.error(`ternlatex: ${r.reverted}`);
    return 1;
  }
  console.log(
    `${r.hunks.length} ${direct ? "corrections applied" : "suggestions"} in ${r.paragraphs} paragraphs${skipped ? `; skipped: ${skipped}` : ""}`,
  );
  if (r.hunks.length && !direct) console.log("review them in the viewer (✎ Review), or: ternlatex changes --author proof / ternlatex accept --author proof");
  if (r.hunks.length && r.pending) {
    console.log("the document doesn't load the changes package, so the sources are untouched until you accept; add \\usepackage{changes} to see suggestions marked in the PDF");
  }
  return 0;
}

/** FILE, FILE:LINE or FILE:FROM-TO, relative to the current directory. */
function parseTarget(cfg: Config, spec: string): Target {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec)!;
  const abs = resolve(m[1]);
  if (!existsSync(abs)) throw new UsageError(`${m[1]} does not exist`);
  const file = relative(cfg.dir, abs);
  if (file.startsWith("..")) throw new UsageError(`${m[1]} is outside the project`);
  return { file, from: m[2] ? Number(m[2]) : undefined, to: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : undefined };
}

/** The .tex files a document read in its last successful build (just its root before the first one). */
function docTargets(cfg: Config, name: string): Target[] {
  const doc = resolveDoc(cfg, name);
  const p = docPaths(cfg, doc);
  const deps = existsSync(p.deps) ? parseDeps(readFileSync(p.deps, "utf8"), cfg.dir, relative(cfg.dir, p.staging)) : [doc.root];
  return deps.filter((f) => f.endsWith(".tex")).map((file) => ({ file }));
}

function isProjectStatus(v: unknown): v is ProjectStatus {
  return Boolean(v && typeof v === "object" && "docs" in v && Array.isArray(v.docs));
}
