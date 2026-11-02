import type { BuildHooks } from "./builder.ts";
import { syncReviewFallback, writeReviewSetup } from "./changes.ts";
import { type Config, loadConfig } from "./config.ts";
import { checkpoint } from "./vcs.ts";
import { importCitations, ZoteroError } from "./zotero.ts";

/** natbib and LaTeX both report `Citation `key' on page N undefined`. */
const UNDEFINED_CITATION = /Citation [`'"]([^`'"]+)['"] .*undefined/;

/** Steps every build of a project runs, whether started by the watcher, the viewer or `ternlatex build`. */
export function projectHooks(cfg: Config): BuildHooks {
  return {
    beforeBatch: async () => {
      // [review] is re-read so toggling `final` or adding an author applies without restarting `dev`.
      const review = (() => {
        try {
          return loadConfig(cfg.dir).review;
        } catch {
          return cfg.review; // A half-edited ternlatex.toml keeps the last good settings.
        }
      })();
      await writeReviewSetup({ ...cfg, review });
      // The tracked fallback (for Overleaf, which has no review setup) learns new authors before a mark of theirs is pushed.
      await syncReviewFallback({ ...cfg, review }).catch(() => []);
    },
    afterBuild: async (_doc, status) => {
      if (!cfg.zotero.autoImport || !status.ok) return {};
      const keys = [...new Set(status.diagnostics.flatMap((d) => UNDEFINED_CITATION.exec(d.message)?.[1] ?? []))];
      if (!keys.length) return {};
      try {
        const { added, missing } = await importCitations(cfg, keys);
        const notes = added.length ? [{ severity: "info" as const, message: `imported from Zotero: ${added.join(", ")}` }] : [];
        if (missing.length) notes.push({ severity: "info", message: `not in Zotero: ${missing.join(", ")}` });
        return { rebuild: added.length > 0, notes };
      } catch (e) {
        if (e instanceof ZoteroError) return { notes: [{ severity: "warning", message: `Zotero auto-import: ${e.message}` }] };
        throw e;
      }
    },
    afterBatch: async (built) => {
      if (!cfg.checkpoints || !built.length) return;
      const summary = built.map((s) => `${s.doc} ${s.ok ? "ok" : "failed"}`).join(", ");
      await checkpoint(cfg, `save: ${summary}`);
    },
  };
}
