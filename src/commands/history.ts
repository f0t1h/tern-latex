import { parseArgs } from "node:util";
import { loadConfig, resolveDoc, UsageError } from "../config.ts";
import { formatDiagnostic } from "../diagnostics.ts";
import { buildDiff } from "../latexdiff.ts";
import { openWithDefaultApp } from "../tools.ts";
import { CHECKPOINT_REF, git, listCheckpoints, restore } from "../vcs.ts";

/** `ternlatex checkpoints [--limit N]`, `ternlatex restore REV [PATH…]`, `ternlatex diff [REV] [--doc NAME] [--open]`. */
export async function history(sub: string, args: string[]): Promise<number> {
  const cfg = loadConfig();
  switch (sub) {
    case "checkpoints": {
      const { values } = parseArgs({ args, options: { limit: { type: "string", default: "20" } } });
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive integer, got "${values.limit}"`);
      const list = await listCheckpoints(cfg, limit);
      if (!list.length) console.error("no checkpoints yet (they are taken on every build while `ternlatex dev` runs)");
      for (const c of list) console.log(`${c.sha.slice(0, 7)}  ${c.date}  ${c.message}`);
      return 0;
    }
    case "restore": {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [rev, ...files] = positionals;
      if (!rev) throw new UsageError("restore needs a revision: a checkpoint sha from `ternlatex checkpoints`, or any git revision");
      await restore(cfg, rev, files);
      console.log(`restored ${files.length ? files.join(", ") : "the working tree"} from ${rev} (previous state saved as a checkpoint)`);
      return 0;
    }
    case "diff": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { open: { type: "boolean", default: false }, doc: { type: "string" } } });
      if (positionals.length > 1) throw new UsageError("diff takes at most one revision");
      const doc = resolveDoc(cfg, values.doc);
      const rev = positionals[0] ?? (await defaultRev(cfg.dir));
      const r = await buildDiff(cfg, doc, rev);
      for (const d of r.diagnostics) (d.severity === "error" ? console.error : console.warn)(formatDiagnostic(d));
      if (!r.ok) return 1;
      console.log(r.pdf);
      if (values.open) openWithDefaultApp(r.pdf);
      return 0;
    }
    default:
      throw new UsageError(`unknown history command "${sub}"`);
  }
}

/** HEAD, or the oldest checkpoint while the repository has no commits. */
async function defaultRev(dir: string): Promise<string> {
  if ((await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) return "HEAD";
  const r = await git(dir, ["rev-list", "--max-parents=0", CHECKPOINT_REF, "--"]);
  const oldest = r.code === 0 ? r.stdout.trim().split("\n").at(-1) : undefined;
  if (!oldest) throw new UsageError("nothing to compare against: no commits and no checkpoints yet; pass a revision");
  return oldest;
}
