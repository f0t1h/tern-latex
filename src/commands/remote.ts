import { existsSync, readFileSync } from "node:fs";
import { type Config, paths } from "../config.ts";
import type { ServerInfo } from "../server.ts";

/** The dev server serving this project, if one is alive. */
export function runningServer(cfg: Config): ServerInfo | null {
  const file = paths(cfg).server;
  if (!existsSync(file)) return null;
  const v: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!v || typeof v !== "object" || !("url" in v) || !("pid" in v) || typeof v.url !== "string" || typeof v.pid !== "number") return null;
  try {
    process.kill(v.pid, 0);
  } catch {
    return null; // Stale file from a crashed server.
  }
  return { url: v.url, pid: v.pid };
}

/** POSTs JSON to a running dev server; returns status code and parsed body. */
export async function post(server: ServerInfo, path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
