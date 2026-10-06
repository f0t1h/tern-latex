import { loadConfig } from "../config.ts";
import { post, runningServer } from "./remote.ts";

/** How long `stop` and `restart` wait for the dev server before giving up. */
const TIMEOUT_MS = 15_000;

/** `ternlatex stop [DIR]`: stops the project's dev server; its blocks stay open. */
export async function stopServer(target: string): Promise<number> {
  const cfg = loadConfig(target);
  const server = runningServer(cfg);
  if (!server) {
    console.log("no dev server is running for this project");
    return 0;
  }
  // Asked over HTTP the server cleans up after itself; on Windows a kill is TerminateProcess, which skips that.
  const asked = await post(server, "/stop").then((r) => r.status === 200, () => false);
  if (!asked) process.kill(server.pid, "SIGTERM");
  if (!(await until(() => (runningServer(cfg) === null ? true : null)))) {
    console.error(`ternlatex: the dev server (pid ${server.pid}) did not stop within ${TIMEOUT_MS / 1000}s`);
    return 1;
  }
  console.log(`stopped the dev server at ${server.url} (pid ${server.pid})`);
  return 0;
}

/**
 * `ternlatex restart [DIR]`: restarts the dev server in its own block, as a fresh process (picking up a
 * rebuilt binary and ternlatex.toml), on the same port so viewers reconnect.
 */
export async function restartServer(target: string): Promise<number> {
  const cfg = loadConfig(target);
  const old = runningServer(cfg);
  if (!old) {
    console.error("ternlatex: no dev server is running for this project; start one with `ternlatex dev`");
    return 1;
  }
  const r = await post(old, "/restart");
  if (r.status !== 200) {
    console.error(`ternlatex: the dev server refused to restart (HTTP ${r.status}); stop it and run \`ternlatex dev\``);
    return 1;
  }
  const fresh = await until(() => {
    const s = runningServer(cfg);
    return s && s.pid !== old.pid ? s : null;
  });
  if (!fresh) {
    console.error(`ternlatex: the dev server did not come back within ${TIMEOUT_MS / 1000}s; see its block for errors`);
    return 1;
  }
  console.log(`restarted the dev server at ${fresh.url} (pid ${fresh.pid})`);
  return 0;
}

/** Polls `get` until it returns non-null or the timeout passes. */
async function until<T>(get: () => T | null): Promise<T | null> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = get();
    if (v !== null || Date.now() >= deadline) return v;
    await Bun.sleep(100);
  }
}
