import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Status } from "../src/builder.ts";
import { devTitle } from "../src/commands/dev.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import { loadConfig } from "../src/config.ts";
import { Builder } from "../src/builder.ts";
import { startServer } from "../src/server.ts";
import { awaitReply, dataConfigFile, installTernPlugin, ipcDir, layoutTab, openSource, pluginCall, popoutViewer } from "../src/ternplugin.ts";
import { clearToolCache, selfCommand } from "../src/tools.ts";
import { version } from "../package.json";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ternlatex-ternplugin-test-")));
const fake = join(root, "fake");
const saved = {
  TERNLATEX_TERN: process.env.TERNLATEX_TERN,
  TERNLATEX_CACHE: process.env.TERNLATEX_CACHE,
  TERNLATEX_DATA: process.env.TERNLATEX_DATA,
  TERN_CONFIG_DIR: process.env.TERN_CONFIG_DIR,
  FAKE_TERN: process.env.FAKE_TERN,
};
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * A stand-in for the tern CLI (TERNLATEX_TERN), driven by fake/state.json: `plugin …` keeps a plugins folder the way
 * Tern does (`<id>.path` links, `<id>/` installed copies); `open` of a request plays the plugin's route (answering
 * `replies` in turn, else `reply`); `open` of a file answers block 50 (and logs TERN_PANE to fake/opens), `split`
 * 60, `browser` 42. Every argv lands in log.
 */
const FAKE_TERN = `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_TERN;
const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const argv = process.argv.slice(2);
appendFileSync(join(dir, "log"), JSON.stringify(argv) + "\\n");
const [cmd, verb, arg] = argv.filter((a) => a !== "--json");
const out = (v) => process.stdout.write(JSON.stringify(v));
if (cmd === "plugin") {
  if (state.noPlugins) { process.stderr.write('tern: unknown command "plugin"\\n'); process.exit(2); }
  const link = join(state.plugins, "ternlatex.path");
  const copy = join(state.plugins, "ternlatex");
  if (verb === "dir") out({ dir: state.plugins });
  else if (verb === "link") { writeFileSync(link, arg); out({ id: "ternlatex", dir: arg }); }
  else if (verb === "unlink") { rmSync(link); out({ removed: link }); }
  else if (verb === "remove") { rmSync(copy, { recursive: true }); out({ removed: copy }); }
  else if (verb === "list" || verb === "reload") {
    if (verb === "reload") writeFileSync(join(dir, "reloaded"), "");
    const loaded = existsSync(link) || existsSync(copy);
    out({ plugins: loaded && !state.problem ? [{ id: "ternlatex", status: state.status ?? "ready" }] : [], problems: state.problem ? [state.problem] : [], jit: false, canvas: true });
    process.exit(verb === "reload" && state.status && state.status !== "ready" ? 1 : 0);
  }
  process.exit(0);
}
if (cmd === "open" && !argv.at(-1).endsWith(".ternlatex")) {
  appendFileSync(join(dir, "opens"), JSON.stringify({ from: process.env.TERN_PANE, argv: argv.filter((a) => a !== "--json").slice(1) }) + "\\n");
  out({ blocks: [50], discarded: false });
  process.exit(0);
}
if (cmd === "split" || cmd === "move") {
  out({ block: cmd === "split" ? 60 : Number(verb) });
  process.exit(0);
}
if (cmd === "open") {
  const claimed = () => { process.stderr.write("tern open: " + verb + " cannot open in a file block\\n"); process.exit(1); };
  if (state.open === "unclaimed") process.exit(0);
  if (state.open === "untilReload" && !existsSync(join(dir, "reloaded"))) process.exit(0);
  if (state.open === "broken") { process.stderr.write("tern open: no window shows pane 1\\n"); process.exit(2); }
  if (state.open === "silent") claimed();
  const req = JSON.parse(readFileSync(verb, "utf8"));
  rmSync(verb);
  const file = join(dir, "requests");
  const n = existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").length : 0;
  appendFileSync(file, JSON.stringify({ ...req, ternPane: process.env.TERN_PANE ?? null }) + "\\n");
  writeFileSync(req.reply, JSON.stringify(state.replies ? state.replies[n] : state.reply));
  claimed();
}
if (cmd === "browser") {
  out({ ok: { block: 42 } });
  process.exit(0);
}
process.stderr.write("fake tern: unexpected " + argv.join(" ") + "\\n");
process.exit(3);
`;

interface FakeState {
  plugins: string;
  noPlugins?: boolean;
  status?: unknown;
  problem?: { dir: string; error: string };
  open?: "reply" | "silent" | "unclaimed" | "untilReload" | "broken";
  reply?: unknown;
  replies?: unknown[];
}

function setState(s: Partial<FakeState>): void {
  writeFileSync(join(fake, "state.json"), JSON.stringify({ plugins: join(root, "plugins"), open: "reply", reply: { ok: true, pane: 7 }, ...s }));
  rmSync(join(fake, "log"), { force: true });
  rmSync(join(fake, "reloaded"), { force: true });
  rmSync(join(fake, "requests"), { force: true });
  rmSync(join(fake, "opens"), { force: true });
}

/** tern argv recorded since the last setState, without --json. */
function calls(): string[][] {
  const file = join(fake, "log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((l): string[] => JSON.parse(l).filter((a: string) => a !== "--json"));
}

/** Calls that change Tern's plugins (everything but dir/list). */
const changes = () => calls().filter((c) => c[0] === "plugin" && c[1] !== "dir" && c[1] !== "list");

beforeAll(() => {
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "tern.ts"), FAKE_TERN);
  let exe = join(fake, "tern");
  if (process.platform === "win32") {
    // Tern is an .exe on Windows; a .cmd stand-in can't take the JSON arguments `tern browser` gets (Bun refuses
    // cmd.exe special characters in arguments to .cmd files).
    exe = join(fake, "tern.exe");
    const built = Bun.spawnSync([process.execPath, "build", "--compile", join(fake, "tern.ts"), "--outfile", exe], { stdout: "ignore", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`cannot compile the fake tern: ${built.stderr.toString()}`);
  } else {
    writeFileSync(exe, `#!/bin/sh\nexec '${process.execPath}' '${join(fake, "tern.ts")}' "$@"\n`);
    chmodSync(exe, 0o755);
  }
  process.env.TERNLATEX_TERN = exe;
  process.env.FAKE_TERN = fake;
  process.env.TERNLATEX_CACHE = join(root, "cache");
  process.env.TERNLATEX_DATA = join(root, "data");
  process.env.TERN_CONFIG_DIR = join(root, "tern-state");
  clearToolCache();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearToolCache();
  rmSync(root, { recursive: true, force: true });
});

describe("install", () => {
  let pkg: string;
  beforeEach(() => {
    rmSync(join(root, "plugins"), { recursive: true, force: true });
    mkdirSync(join(root, "plugins"));
    pkg = join(root, "pkg");
    rmSync(pkg, { recursive: true, force: true });
    setState({});
  });

  test("writes the package, links once, writes config.json, and does nothing on a second run", async () => {
    const first = await installTernPlugin(pkg);
    expect(changes()).toEqual([["plugin", "link", pkg]]); // link reloads by itself
    expect(first.actions).toEqual([`updated the plugin files in ${pkg}`, `linked ${pkg}`]);
    expect(JSON.parse(readFileSync(join(pkg, "config.json"), "utf8"))).toEqual({ bin: selfCommand(), ipc: ipcDir(), version });
    expect(ipcDir()).toBe(join(root, "cache", "tern-ipc"));

    setState({});
    const second = await installTernPlugin(pkg);
    expect(second.actions).toEqual([]);
    expect(changes()).toEqual([]);
  });

  test("a changed config.json is reloaded, not relinked", async () => {
    await installTernPlugin(pkg);
    writeFileSync(join(pkg, "config.json"), "{}");
    setState({});
    await installTernPlugin(pkg);
    expect(changes()).toEqual([["plugin", "reload"]]);
  });

  test("replaces a link to another directory and an installed copy", async () => {
    writeFileSync(join(root, "plugins", "ternlatex.path"), join(root, "elsewhere"));
    mkdirSync(join(root, "plugins", "ternlatex"));
    const r = await installTernPlugin(pkg);
    expect(changes()).toEqual([
      ["plugin", "unlink", "ternlatex"],
      ["plugin", "remove", "ternlatex"],
      ["plugin", "link", pkg],
    ]);
    expect(r.actions).toHaveLength(4);
  });

  test("surfaces Tern's message when the plugin fails or is a problem", async () => {
    setState({ status: { failed: "runtime error: window.luau:3: boom" } });
    await expect(installTernPlugin(pkg)).rejects.toThrow("the ternlatex Tern plugin failed: runtime error: window.luau:3: boom");
    setState({ problem: { dir: pkg, error: "key with no value, expected `=`" } });
    await expect(installTernPlugin(pkg)).rejects.toThrow("Tern cannot load the ternlatex plugin: key with no value, expected `=`");
  });

  test("a Tern without plugins is a clear error", async () => {
    setState({ noPlugins: true });
    await expect(installTernPlugin(pkg)).rejects.toThrow(/this Tern cannot load plugins .*unknown command "plugin".*update Tern/);
  });

  test("the package is the repo's layout, written only when it differs, and loses files no longer shipped", async () => {
    const repo = join(import.meta.dir, "..");
    await installTernPlugin(pkg);
    expect(readdirSync(pkg).sort()).toEqual(["config.json", "plugin.toml", "tern-plugin"]);
    expect(readFileSync(join(pkg, "plugin.toml"))).toEqual(readFileSync(join(repo, "plugin.toml")));
    const shipped = readdirSync(join(repo, "tern-plugin")).filter((f) => f !== "config.json" && !f.startsWith("."));
    expect(readdirSync(join(pkg, "tern-plugin")).sort()).toEqual(shipped.sort());
    const mtime = statSync(join(pkg, "tern-plugin", "window.luau")).mtimeMs;

    setState({});
    const again = await installTernPlugin(pkg);
    expect(again.actions).toEqual([]);
    expect(statSync(join(pkg, "tern-plugin", "window.luau")).mtimeMs).toBe(mtime);

    writeFileSync(join(pkg, "tern-plugin", "stale.luau"), "--!strict\n");
    writeFileSync(join(pkg, "window.luau"), "--!strict\n"); // the layout before plugin.toml moved to the repo root
    setState({});
    await installTernPlugin(pkg);
    expect(existsSync(join(pkg, "tern-plugin", "stale.luau"))).toBe(false);
    expect(existsSync(join(pkg, "window.luau"))).toBe(false);
    expect(changes()).toEqual([["plugin", "reload"]]);
  });

  describe("an installed copy (installed package or compiled ternlatex)", () => {
    const installed = () => join(root, "plugins", "ternlatex");
    const install = (v: string) => {
      mkdirSync(installed());
      writeFileSync(join(installed(), "plugin.toml"), `schema = 1\nid = "ternlatex"\nversion = "${v}"\n`);
    };
    beforeEach(() => rmSync(join(root, "tern-state"), { recursive: true, force: true }));

    test("is left alone, and this ternlatex's config goes to the plugin's data folder", async () => {
      install(version);
      const r = await installTernPlugin(pkg, { keepInstalled: true });
      expect(changes()).toEqual([]);
      expect(readdirSync(join(root, "plugins"))).toEqual(["ternlatex"]); // no ternlatex.path
      expect(readdirSync(installed())).toEqual(["plugin.toml"]);
      expect(existsSync(pkg)).toBe(false);
      expect(dataConfigFile()).toBe(join(root, "tern-state", "plugin-data", "ternlatex", "config.json"));
      expect(JSON.parse(readFileSync(dataConfigFile(), "utf8"))).toEqual({ bin: selfCommand(), ipc: ipcDir(), version });
      expect(r).toEqual({ dir: realpathSync(installed()), actions: [`wrote ${dataConfigFile()}`], warning: undefined });

      setState({});
      expect((await installTernPlugin(pkg, { keepInstalled: true })).actions).toEqual([]);
      expect(changes()).toEqual([]);
    });

    test("of another version is still used, with a warning", async () => {
      install("0.0.1");
      const r = await installTernPlugin(pkg, { keepInstalled: true, reload: true });
      expect(r.warning).toBe(`the ternlatex Tern plugin is 0.0.1, this ternlatex is ${version}; reinstall the plugin from Preferences › Plugins`);
      expect(changes()).toEqual([["plugin", "reload"]]); // setup-tern's reload; nothing removed or linked
      expect(existsSync(join(installed(), "plugin.toml"))).toBe(true);
    });

    test("is replaced by a source checkout's link", async () => {
      install(version);
      await installTernPlugin(pkg);
      expect(changes()).toEqual([
        ["plugin", "remove", "ternlatex"],
        ["plugin", "link", pkg],
      ]);
    });
  });
});

describe("pluginCall", () => {
  const leftovers = () => readdirSync(ipcDir());

  test("writes the request, opens it, and returns the reply's pane ids", async () => {
    setState({ reply: { ok: true, viewer: 3, editor: 4, agent: 5, extra: "x" } });
    const pane = process.env.TERN_PANE;
    process.env.TERN_PANE = "1";
    try {
      expect(await pluginCall("layout", { devPane: 1, dir: "/p" })).toEqual({ viewer: 3, editor: 4, agent: 5 });
    } finally {
      if (pane === undefined) delete process.env.TERN_PANE;
      else process.env.TERN_PANE = pane;
    }
    const [req] = readFileSync(join(fake, "requests"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(req.op).toBe("layout");
    expect(req.args).toEqual({ devPane: 1, dir: "/p" });
    expect(req.ternPane).toBeNull(); // Tern would focus the dev block before routing
    expect(req.reply).toStartWith(join(ipcDir(), ""));
    expect(req.reply).toEndWith(".reply.json");
    expect(calls()[0][0]).toBe("open");
    expect(calls()[0][1]).toEndWith(".ternlatex");
    expect(leftovers()).toEqual([]);
  });

  test("an error reply is thrown with the plugin's message", async () => {
    setState({ reply: { error: "no omp block for this project; run ternlatex restart to bring it back" } });
    await expect(pluginCall("ask", { devPane: 1, dir: "/p", text: "hi" })).rejects.toThrow("no omp block for this project");
    expect(leftovers()).toEqual([]);
  });

  test("a reply caught mid-write is read again once it changes", async () => {
    const reads = ['{"ok": tr', '{"ok": tr', JSON.stringify({ ok: true, pane: 9 })];
    expect(await awaitReply("reply.json", 10_000, async () => reads.shift() ?? "")).toEqual({ pane: 9 });
    const broken = ['{"ok": tr', '{"ok": true, "pa'];
    await expect(awaitReply("reply.json", 10_000, async () => broken.shift() ?? "")).rejects.toThrow(/unreadable answer/);
  });

  test("no reply times out and leaves no request behind", async () => {
    setState({ open: "silent" });
    // The timeout itself is under test, so it runs on the real clock (kept short).
    await expect(pluginCall("popout", { devPane: 1, url: "http://x" }, { timeoutMs: 150 })).rejects.toThrow(/no answer from the ternlatex Tern plugin/);
    expect(leftovers()).toEqual([]);
  });

  test("an open nobody claimed, or a failing tern, is an error", async () => {
    setState({ open: "unclaimed" });
    await expect(pluginCall("review", { dir: "/p" })).rejects.toThrow(/did not take the request, even after reloading.*setup-tern/);
    setState({ open: "broken" });
    await expect(pluginCall("review", { dir: "/p" })).rejects.toThrow("no window shows pane 1");
    expect(leftovers()).toEqual([]);
  });

  test("a window half Tern disabled (its load overran after a restart) is brought back by one plugin reload", async () => {
    setState({ open: "untilReload", reply: { ok: true, pane: 7 } });
    expect(await pluginCall("review", { dir: "/p" })).toEqual({ pane: 7 });
    const log = readFileSync(join(fake, "log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)[0] + " " + JSON.parse(l)[1]);
    expect(log.filter((l) => l === "plugin reload")).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
});

describe("blocks: ternlatex creates them with the tern CLI, the plugin finds and places them", () => {
  const requests = () => readFileSync(join(fake, "requests"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const opens = () => readFileSync(join(fake, "opens"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const browserOps = () => calls().filter((c) => c[0] === "browser").map((c) => JSON.parse(c[1]));
  const plain = { devPane: 1, dir: "/p", url: "http://v/", root: "/p/main.tex" };
  const layout = { ...plain, agent: ["bun", "cli.ts", "agent", "/p"] };

  test("layout creates the viewer, then the editor and omp, asking the plugin to place each", async () => {
    setState({
      replies: [
        { ok: true, needsViewer: true, needsEditor: true, needsAgent: true, tabRows: 40 },
        { ok: true, needsEditor: true, needsAgent: true, viewer: 42, tabRows: 40 },
        { ok: true, viewer: 42, editor: 50, agent: 60 },
      ],
    });
    expect(await layoutTab(layout)).toEqual({ viewer: 42, editor: 50, agent: 60 });
    expect(browserOps()).toEqual([{ op: "open", owner: 1, url: "http://v/" }]);
    expect(opens()).toEqual([{ from: "1", argv: ["--split", "down", "/p/main.tex:1"] }]);
    expect(calls().filter((c) => c[0] === "split")).toEqual([["split", "50", "down", "--cwd", "/p", "--", "bun", "cli.ts", "agent", "/p"]]);
    expect(requests().map((r) => r.args)).toEqual([plain, { ...plain, tabRows: 40, viewer: 42 }, { ...plain, tabRows: 40, editor: 50, agent: 60 }]);
  });

  test("layout keeps the blocks the tab has, navigating its viewer", async () => {
    setState({ replies: [{ ok: true, needsAgent: true, viewer: 3, editor: 4 }, { ok: true, viewer: 3, editor: 4, agent: 60 }] });
    expect(await layoutTab(layout)).toEqual({ viewer: 3, editor: 4, agent: 60 });
    expect(browserOps()).toEqual([{ op: "goto", block: 3, url: "http://v/" }]);
    expect(calls().filter((c) => c[0] === "split")[0].slice(0, 3)).toEqual(["split", "4", "down"]);
    expect(requests().map((r) => r.args)).toEqual([plain, { ...plain, agent: 60 }]);

    setState({ reply: { ok: true, viewer: 3, editor: 4, agent: 5 } });
    expect(await layoutTab(layout)).toEqual({ viewer: 3, editor: 4, agent: 5 });
    expect(calls().map((c) => c[0])).toEqual(["open", "browser"]);
  });

  test("click-to-source opens where the plugin says", async () => {
    setState({ reply: { ok: true, shown: 7 } });
    await openSource(1, "/p/a.tex", 3);
    expect(opens()).toEqual([{ from: "7", argv: ["/p/a.tex:3"] }]);

    setState({ reply: { ok: true, near: 8, above: true } });
    await openSource(1, "/p/a.tex");
    expect(opens()).toEqual([{ from: "8", argv: ["--split", "down", "/p/a.tex"] }]);
    expect(calls().filter((c) => c[0] === "move")).toEqual([["move", "50", "above", "8"]]);

    setState({ reply: { ok: true } });
    await openSource(1, "/p/a.tex", 3);
    expect(opens()).toEqual([{ from: "1", argv: ["--tab", "/p/a.tex:3"] }]);
    expect(requests().map((r) => r.args)).toEqual([{ devPane: 1, path: "/p/a.tex" }]);
  });

  test("popout opens the viewer over the block the plugin names and hands it back to dock", async () => {
    setState({ replies: [{ ok: true, needsViewer: true, owner: 3 }, { ok: true, pane: 42 }] });
    await popoutViewer(1, "http://v/?doc=slides");
    expect(browserOps()).toEqual([{ op: "open", owner: 3, url: "http://v/?doc=slides" }]);
    expect(requests().map((r) => r.args)).toEqual([
      { devPane: 1, url: "http://v/?doc=slides" },
      { devPane: 1, url: "http://v/?doc=slides", pane: 42 },
    ]);

    setState({ reply: { ok: true, pane: 9 } }); // Already open: the plugin focuses it.
    await popoutViewer(1, "http://v/?doc=slides");
    expect(browserOps()).toEqual([]);
  });
});

test("package.json and plugin.toml name the same version", () => {
  expect(parseToml(readFileSync(join(import.meta.dir, "..", "plugin.toml"), "utf8")).version).toBe(version);
});

describe("dev title", () => {
  const status = (doc: string, s: Partial<Status>): Status => ({ doc, root: `${doc}.tex`, build: 1, rev: 1, state: "idle", ok: true, engine: "tectonic", diagnostics: [], ...s });
  const diag = (severity: "error" | "warning", n: number) => Array.from({ length: n }, () => ({ severity, message: "m" }));

  test("building, failed and ok states in the plugin's formats", () => {
    const paper = status("paper", { diagnostics: diag("warning", 2) });
    expect(devTitle([paper, status("slides", { state: "building" })], paper)).toBe("⟳ ternlatex · slides");
    expect(devTitle([status("paper", { ok: null, state: "idle", build: 0 })], paper)).toBe("⟳ ternlatex · paper");
    const broken = status("slides", { ok: false, diagnostics: [...diag("error", 3), ...diag("warning", 1)] });
    expect(devTitle([paper, broken], paper)).toBe("✗ ternlatex · slides · 3 errors");
    expect(devTitle([paper, status("slides", {})], paper)).toBe("✓ ternlatex · paper · 2 warnings");
    expect(devTitle([status("paper", {})], status("paper", {}))).toBe("✓ ternlatex · paper");
  });
});

describe("CLI", () => {
  const project = join(root, "project");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { cwd: project, env: process.env });
  beforeAll(() => {
    mkdirSync(join(project, "build"), { recursive: true });
    writeFileSync(join(project, "ternlatex.toml"), 'root = "main.tex"\n\n[[review.authors]]\nid = "AK"\nname = "Ana K"\ncolor = "violet"\n');
    writeFileSync(join(project, "main.tex"), "\\documentclass{article}\n\\begin{document}\nOne \\added[id=AK]{new} word.\n\\end{document}\n");
  });

  test("changes --json prints authors and items like GET /changes", () => {
    const r = run("changes", "--json");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.authors[0]).toEqual({ id: "AK", name: "Ana K", color: "violet" });
    expect(out.authors.map((a: { id: string }) => a.id)).toContain("omp");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: "added", author: "AK", file: "main.tex", line: 3, text: "new" });
    expect(typeof out.items[0].id).toBe("string");
  });

  test("tern-config --json prints the config.json text the plugin keeps", () => {
    const r = run("tern-config", "--json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(`${JSON.stringify({ bin: selfCommand(), ipc: ipcDir(), version }, null, 2)}\n`);
  });

  test("install-cli writes a launcher of this ternlatex into DIR and says how to put DIR on PATH", () => {
    const dir = join(root, "launcher-bin");
    const env = { ...process.env, SHELL: "/bin/sh" };
    const r = Bun.spawnSync([process.execPath, CLI, "install-cli", dir], { cwd: project, env });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.toString().trim().split("\n");
    const wrote = (process.platform === "win32" ? ["ternlatex", "ternlatex.cmd"] : ["ternlatex"]).map((f) => `wrote ${join(dir, f)}`);
    expect(lines.slice(0, -1)).toEqual(wrote);
    expect(lines.at(-1)).toStartWith(`${dir} is not on PATH`);

    const onPath = Bun.spawnSync([process.execPath, CLI, "install-cli", dir], { cwd: project, env: { ...env, PATH: [dir, process.env.PATH].join(delimiter) } });
    expect(onPath.stdout.toString().trim().split("\n")).toEqual(wrote);

    if (process.platform === "win32") return; // ternlatex.cmd needs cmd.exe; the sh launcher is for Git Bash.
    const launched = Bun.spawnSync([join(dir, "ternlatex"), "tern-config", "--json"], { cwd: project, env: process.env });
    expect(launched.exitCode).toBe(0);
    expect(JSON.parse(launched.stdout.toString())).toEqual({ bin: selfCommand(), ipc: ipcDir(), version });
  });

  test("fix needs a dev server (exit 2)", () => {
    const r = run("fix");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("ternlatex dev");
  });

  test("fix with a dev server and a clean build has nothing to send", async () => {
    let sent = 0;
    const server = await startServer({
      builder: new Builder(loadConfig(project)),
      port: 0,
      open: async () => {},
      editor: false,
      agent: () => async () => {
        sent++;
      },
    });
    try {
      const r = Bun.spawn([process.execPath, CLI, "fix"], { cwd: project, env: process.env, stdout: "pipe" });
      expect(await r.exited).toBe(0);
      expect(await new Response(r.stdout).text()).toBe("nothing to fix\n");
      expect(sent).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("uninstall", () => {
  const base = join(root, "uninstall");
  const at = (...parts: string[]) => join(base, ...parts);
  const plugins = at("plugins");
  const installed = join(plugins, "ternlatex");
  /** Everything ternlatex and Bun write, in base: never the user's real cache, data, Tern or Bun. */
  const overrides: Record<string, string> = {
    TERNLATEX_CACHE: at("cache"),
    TERNLATEX_DATA: at("data"),
    TERN_CONFIG_DIR: at("tern-state"),
    BUN_INSTALL: at("bun"),
    BUN_INSTALL_GLOBAL_DIR: at("bun", "install", "global"),
    BUN_INSTALL_BIN: at("bun", "bin"),
    HOME: at("home"),
    USERPROFILE: at("home"),
    XDG_CONFIG_HOME: at("home", ".config"),
    SHELL: "/bin/sh",
  };
  const env = () => ({ ...process.env, ...overrides });
  const run = (args: string[], o: { cli?: string } = {}) => {
    const r = Bun.spawnSync([process.execPath, o.cli ?? CLI, ...args], { cwd: at("project"), env: env(), stdin: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const bunGlobal = () => Bun.spawnSync([process.execPath, "pm", "ls", "-g"], { env: env() }).stdout.toString();
  const foreign = at("other-bin", "ternlatex");
  /** What a full install leaves outside projects. */
  const parts = () => [at("bin", "ternlatex"), at("cache"), at("data"), at("tern-state", "plugin-data", "ternlatex"), installed, join(plugins, "ternlatex.path")];

  beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    for (const d of ["plugins", "project", "home", "other-bin", "stub"]) mkdirSync(at(d), { recursive: true });
    writeFileSync(at("project", "ternlatex.toml"), 'root = "main.tex"\n');
    setState({ plugins });
  });

  /** A full install: install-cli's launcher (and a recorded file someone replaced), a global Bun install, cache, data, plugin data, the plugin installed and linked. */
  function installEverything(): void {
    expect(run(["install-cli", at("bin")]).code).toBe(0);
    writeFileSync(foreign, "#!/bin/sh\necho not ternlatex\n");
    const recorded = join(overrides.TERNLATEX_DATA, "launchers.json");
    writeFileSync(recorded, JSON.stringify([...JSON.parse(readFileSync(recorded, "utf8")), foreign]));
    writeFileSync(at("stub", "package.json"), JSON.stringify({ name: "ternlatex", version: "0.0.0", bin: { ternlatex: "cli.js" } }));
    writeFileSync(at("stub", "cli.js"), "");
    expect(Bun.spawnSync([process.execPath, "add", "-g", `file:${at("stub")}`], { env: env(), stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    expect(bunGlobal()).toContain("ternlatex@");
    mkdirSync(at("cache", "tools"), { recursive: true });
    writeFileSync(at("cache", "tools", "tectonic"), Buffer.alloc(2048));
    mkdirSync(at("data", "tern-plugin"), { recursive: true });
    mkdirSync(at("tern-state", "plugin-data", "ternlatex"), { recursive: true });
    writeFileSync(at("tern-state", "plugin-data", "ternlatex", "config.json"), "{}");
    mkdirSync(installed);
    writeFileSync(join(installed, "plugin.toml"), 'id = "ternlatex"\n');
    writeFileSync(join(plugins, "ternlatex.path"), at("data", "tern-plugin"));
  }

  test("lists everything with sizes and, with --yes, removes exactly that, the plugin last, never the project", () => {
    installEverything();
    setState({ plugins });
    const r = run(["uninstall", "--yes"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("ternlatex uninstall will remove:");
    expect(lines.find((l) => l.includes(at("bin", "ternlatex")))).toMatch(/^ {2}launcher +\S.*\(\d+ B\)$/);
    expect(lines.find((l) => l.includes(at("cache")))).toEndWith("(2.0 KB)");
    expect(lines.find((l) => /^ {2}Tern plugin {2,}\S/.test(l))).toContain(`${installed}; link to ${at("data", "tern-plugin")}`);
    expect(r.out).not.toContain(foreign);
    // Windows gets two launchers (ternlatex.cmd and a shell one), so compare the kinds in order.
    expect([...new Set(lines.filter((l) => l.startsWith("removed ")).map((l) => l.slice(8, l.indexOf(":"))))]).toEqual([
      "launcher",
      "global Bun install",
      "cache (tools, TeX packages)",
      "data",
      "Tern plugin data",
      "Tern plugin",
    ]);
    expect(changes()).toEqual([
      ["plugin", "unlink", "ternlatex"],
      ["plugin", "remove", "ternlatex"],
    ]);
    for (const p of parts()) expect(existsSync(p)).toBe(false);
    expect(bunGlobal()).not.toContain("ternlatex@");
    expect(existsSync(foreign)).toBe(true);
    expect(readdirSync(at("project"))).toEqual(["ternlatex.toml"]);
    expect(r.out).toContain("git update-ref -d refs/ternlatex/checkpoints");
    expect(lines.at(-2)).toBe("A running `ternlatex dev` keeps running until you stop it (Ctrl-C in its block).");
  });

  test("without a terminal and without --yes it lists, refuses with a hint, and removes nothing", () => {
    installEverything();
    setState({ plugins });
    const r = run(["uninstall"]);
    expect(r.code).toBe(2);
    expect(r.out).toStartWith("ternlatex uninstall will remove:");
    expect(r.err).toContain("ternlatex uninstall --yes");
    for (const p of parts()) expect(existsSync(p)).toBe(true);
    expect(bunGlobal()).toContain("ternlatex@");
    expect(changes()).toEqual([]);
  });

  test("--keep-cache leaves the cache", () => {
    installEverything();
    const r = run(["uninstall", "--yes", "--keep-cache"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(at("cache"));
    expect(existsSync(at("cache", "tools", "tectonic"))).toBe(true);
    expect(existsSync(at("data"))).toBe(false);
  });

  test("asks first: anything but y keeps everything; y removes", async () => {
    installEverything();
    const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
    Object.assign(process.env, overrides);
    try {
      const asked: string[] = [];
      expect(await uninstall({ ask: (q) => (asked.push(q), "") })).toBe(1);
      for (const p of parts()) expect(existsSync(p)).toBe(true);
      expect(await uninstall({ ask: (q) => (asked.push(q), "y") })).toBe(0);
      for (const p of parts()) expect(existsSync(p)).toBe(false);
      expect(asked).toEqual(["Remove these? [y/N]", "Remove these? [y/N]"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("with nothing installed (and no Tern) it says so and still says what stays in projects", () => {
    setState({ plugins, noPlugins: true });
    const r = run(["uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Nothing of ternlatex is installed here.\n");
    expect(r.out).toContain("refs/ternlatex/checkpoints");
  });

  test("a ternlatex running from the Tern-installed plugin folder removes that folder last and finishes", () => {
    const repo = join(import.meta.dir, "..");
    mkdirSync(installed);
    for (const f of ["src", "package.json", "plugin.toml"]) cpSync(join(repo, f), join(installed, f), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(installed, "node_modules"), "junction");
    mkdirSync(at("data"), { recursive: true });
    const r = run(["uninstall", "--yes"], { cli: join(installed, "src", "cli.ts") });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(installed)).toBe(false);
    expect(r.out).toContain(`removed Tern plugin: ${installed}\n`);
    expect(r.out.trim().split("\n").at(-1)).toBe("A running `ternlatex dev` keeps running until you stop it (Ctrl-C in its block).");
  });
});
