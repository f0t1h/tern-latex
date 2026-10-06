import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { Builder, type Status } from "../builder.ts";
import { loadConfig } from "../config.ts";
import { projectHooks } from "../hooks.ts";
import { buildDiff } from "../latexdiff.ts";
import { listCheckpoints } from "../vcs.ts";
import { resolveReview, reviewList } from "../suggestions.ts";
import { formatHunk, proofread } from "../proofread.ts";
import { formatDiagnostic } from "../diagnostics.ts";
import { startServer } from "../server.ts";
import { inTern } from "../tern.ts";
import { ensureTernPlugin, layoutTab, openSource, pluginCall, popoutViewer, ternKeys } from "../ternplugin.ts";
import { speechStatus, transcribe } from "../speech.ts";
import { openWithDefaultApp, selfCommand } from "../tools.ts";
import { runningServer } from "./remote.ts";

export interface DevOptions {
  port?: number;
  tern: boolean;
  open: boolean;
}

/** Exit code of a supervised dev server asking its supervisor to start a fresh one. */
const RESTART_EXIT = 75;
/** Set in a dev server started by a supervisor (a dev server that restarted), so restarts don't nest. */
const SUPERVISED_ENV = "TERNLATEX_DEV_SUPERVISED";

export async function dev(target: string, o: DevOptions): Promise<number> {
  const cfg = loadConfig(target);
  const existing = runningServer(cfg);
  if (existing) {
    console.error(`ternlatex: a dev server for this project already runs at ${existing.url} (pid ${existing.pid})`);
    return 1;
  }
  // Inside Tern, the ternlatex plugin lays out the window and reaches editor, viewer and omp blocks.
  const tern = o.tern && (await inTern());
  let pluginError: string | undefined;
  if (tern) {
    try {
      const setup = await ensureTernPlugin();
      for (const a of setup.actions) console.log(`tern plugin: ${a}`);
      if (setup.warning) console.error(`ternlatex: warning: ${setup.warning}`);
    } catch (e) {
      pluginError = e instanceof Error ? e.message : String(e);
    }
  }
  const plugin = tern && pluginError === undefined;
  const devPane = Number(process.env.TERN_PANE);
  const dir = realpathSync(cfg.dir); // The plugin compares Tern's resolved paths.
  const builder = new Builder(cfg, projectHooks(cfg));
  const keys = plugin ? await ternKeys() : undefined;
  const server = await startServer({
    builder,
    port: o.port ?? (cfg.port || stablePort(cfg.dir)),
    open: async (file, line) => {
      if (plugin) await openSource(devPane, realpathSync(file), line);
      else console.log(`open ${relative(cfg.dir, file)}${line ? `:${line}` : ""}`);
    },
    editor: plugin,
    agent: () => (plugin ? (text) => pluginCall("ask", { devPane, dir, text }).then(() => {}) : undefined),
    // Dictation runs omp's local Parakeet model in this process; the status check starts now, in the background.
    dictation: { status: () => speechStatus(cfg), transcribe },
    keys,
    // A second viewer block next to the first, e.g. paper beside slides.
    popout: plugin ? (url) => popoutViewer(devPane, url) : undefined,
    history: { checkpoints: (limit) => listCheckpoints(cfg, limit), diff: (doc, rev) => buildDiff(cfg, doc, rev) },
    review: {
      changes: () => reviewList(cfg),
      resolve: (ids, decision) => resolveReview(cfg, ids, decision),
    },
    proofread: async (target) => {
      const r = await proofread(cfg, [target], { direct: false, build: () => builder.request() });
      return { suggestions: r.hunks.length, paragraphs: r.paragraphs, skipped: r.skipped, reverted: r.reverted, pending: r.pending, lines: r.hunks.map(formatHunk) };
    },
    restart: () => stop("restart"),
    stop: () => stop("stop"),
  });

  const title = new DevTitle();
  builder.on("status", (s) => {
    report(s);
    title.update(builder.all(), s);
  });
  builder.watch();
  const docs = cfg.docs.map((d) => (d.name === d.root.replace(/\.tex$/, "") ? d.root : `${d.name} (${d.root})`)).join(", ");
  console.log(`ternlatex dev: ${docs} (${cfg.engine}) → ${server.url}\nwatching ${cfg.dir}; Ctrl-C to stop`);
  if (keys) console.log(`Tern keys: ${keys.map((k) => `${k.display} ${k.title}`).join(" · ")}`);

  if (plugin) {
    // Tern's daemon starts blocks with its own environment, so hand the agent block this PATH explicitly.
    const agent = [...selfCommand(), "agent", dir, "--path", process.env.PATH ?? ""];
    // Starting blocks takes longer than the other requests. `rows`: this block's height, the tab's while dev runs
    // alone in it. A block Tern just created (Start ternlatex here) still reports the default 80×24 before it is
    // sized; that says nothing about the tab, so the plugin's default share applies instead.
    const sized = process.stdout.isTTY && !(process.stdout.rows === 24 && process.stdout.columns === 80);
    const rows = sized ? process.stdout.rows : undefined;
    layoutTab({ devPane, dir, url: server.url, root: join(dir, cfg.docs[0].root), agent, rows }, { timeoutMs: 30_000 }).catch((e: Error) =>
      console.warn(`tern layout failed: ${e.message}; open ${server.url} in a browser block`),
    );
  } else if (pluginError !== undefined) {
    console.warn(`tern plugin unavailable: ${pluginError}; running without the Tern layout — open ${server.url} in a browser block`);
  } else if (o.open) {
    try {
      openWithDefaultApp(server.url);
    } catch (e) {
      console.warn(e instanceof Error ? e.message : String(e));
    }
  }

  const done = Promise.withResolvers<"stop" | "restart">();
  const onSignal = () => stop("stop");
  let stopping = false;
  const stop = (why: "stop" | "restart") => {
    if (stopping) return;
    stopping = true;
    // Once restarting, this process only supervises; signals are the new server's.
    for (const s of SIGNALS) process.off(s, onSignal);
    console.log(why === "restart" ? "\nrestarting…" : "\nstopped");
    builder.close();
    title.reset();
    void server.close().then(() => done.resolve(why));
  };
  for (const s of SIGNALS) process.once(s, onSignal);
  void builder.request();
  if ((await done.promise) === "stop") return 0;
  if (process.env[SUPERVISED_ENV]) return RESTART_EXIT;
  // A fresh process, so a rebuilt binary is picked up. This one stays as its supervisor: there is no
  // portable exec, and leaving would hand the terminal back to the shell. It gets the port bound now (maybe
  // a fallback), so open viewers reconnect.
  return supervise([...selfCommand(), "dev", cfg.dir, "--port", String(server.port), ...(o.tern ? [] : ["--no-tern"])]);
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Runs dev servers one after another for as long as each exits asking for a restart. */
async function supervise(argv: string[]): Promise<number> {
  let child: Bun.Subprocess | undefined;
  // Ctrl-C and hangups reach the child directly (same process group / console); SIGTERM is passed on.
  const ignore = () => {};
  const forward = () => child?.kill("SIGTERM");
  process.on("SIGINT", ignore);
  process.on("SIGHUP", ignore);
  process.on("SIGTERM", forward);
  try {
    for (;;) {
      child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, [SUPERVISED_ENV]: "1" } });
      const code = await child.exited;
      if (code !== RESTART_EXIT) return code;
    }
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGHUP", ignore);
    process.off("SIGTERM", forward);
  }
}

/** Same project → same port across restarts, so an open viewer block reconnects by itself. */
function stablePort(dir: string): number {
  return 4800 + (createHash("sha1").update(dir).digest().readUInt16BE(0) % 1000);
}

/**
 * The dev block's title (OSC 2), set on every build state change when stdout is a terminal. The Tern plugin's
 * status line parses it, so these formats are its contract:
 *   `⟳ ternlatex · DOC` building · `✓ ternlatex · DOC[ · N warnings]` all ok · `✗ ternlatex · DOC · N errors` first failing
 */
export function devTitle(all: Status[], latest: Status): string {
  const building = all.find((s) => s.state === "building") ?? all.find((s) => s.ok === null);
  if (building) return `⟳ ternlatex · ${building.doc}`;
  const failed = all.find((s) => s.ok === false);
  const count = (s: Status, severity: string) => s.diagnostics.filter((d) => d.severity === severity).length;
  if (failed) return `✗ ternlatex · ${failed.doc} · ${count(failed, "error")} errors`;
  const warnings = count(latest, "warning");
  return `✓ ternlatex · ${latest.doc}${warnings ? ` · ${warnings} warnings` : ""}`;
}

/** Writes devTitle to the terminal when it changes; `reset` leaves the plain name behind on exit. */
class DevTitle {
  #shown = "";
  update(all: Status[], latest: Status): void {
    this.#set(devTitle(all, latest));
  }
  reset(): void {
    this.#set("ternlatex");
  }
  #set(title: string): void {
    if (!process.stdout.isTTY || title === this.#shown) return;
    this.#shown = title;
    process.stdout.write(`\x1b]2;${title}\x07`);
  }
}

function report(s: Status): void {
  const t = new Date().toLocaleTimeString();
  if (s.state === "building") {
    // With a note (the first build downloads TeX packages) the line ends here, so download progress gets its own.
    process.stdout.write(s.note ? `[${t}] ${s.doc} #${s.build}… ${s.note}\n` : `[${t}] ${s.doc} #${s.build}…`);
    return;
  }
  const errors = s.diagnostics.filter((d) => d.severity === "error");
  const warnings = s.diagnostics.filter((d) => d.severity === "warning");
  const secs = ((s.durationMs ?? 0) / 1000).toFixed(1);
  if (s.cached) {
    // No "building" line came first: a reused PDF needs no compile.
    console.log(`[${t}] ${s.doc} reused an earlier build of these sources, ${warnings.length} warnings (rev ${s.rev})`);
    return;
  }
  console.log(s.ok ? ` ok ${secs}s, ${warnings.length} warnings (rev ${s.rev})` : ` FAILED ${secs}s, ${errors.length} errors — viewer keeps the last good PDF`);
  for (const d of [...errors, ...warnings].slice(0, 8)) console.log(`  ${formatDiagnostic(d)}`);
}
