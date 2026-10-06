import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder } from "../src/builder.ts";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

interface Call {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Raw HTTP, so Host and Origin can be set to anything (fetch forbids overriding Host). */
function call(port: number, c: Call): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request({ host: "127.0.0.1", port, method: c.method ?? "POST", path: c.path ?? "/focus", headers: { host: `127.0.0.1:${port}`, ...c.headers } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
  });
  req.on("error", reject);
  req.end(c.body ?? "{}");
  return promise;
}

test("the server answers only its own origin, with JSON POSTs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-server-guard-"));
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n");
  mkdirSync(join(dir, "build"));
  let stopped = false;
  const server = await startServer({
    builder: new Builder(loadConfig(dir)),
    port: 0,
    open: async () => {},
    editor: false,
    agent: () => undefined,
    stop: () => (stopped = true),
  });
  const { port } = server;
  const json = { "content-type": "application/json" };
  try {
    // The CLI: JSON, no Origin; the viewer: JSON from its own origin, under either loopback name.
    expect(await call(port, { headers: json })).toBe(200);
    expect(await call(port, { headers: { ...json, origin: `http://127.0.0.1:${port}` } })).toBe(200);
    expect(await call(port, { headers: { ...json, host: `localhost:${port}`, origin: `http://localhost:${port}` } })).toBe(200);
    expect(await call(port, { method: "GET", path: "/status", body: "" })).toBe(200);

    // Another site, a no-preflight form-style POST, and a rebinding name pointing at 127.0.0.1.
    expect(await call(port, { headers: { ...json, origin: "https://evil.example" } })).toBe(403);
    expect(await call(port, { method: "GET", path: "/pdf", headers: { origin: "https://evil.example" }, body: "" })).toBe(403);
    expect(await call(port, { headers: { "content-type": "text/plain" } })).toBe(403);
    expect(await call(port, { headers: { ...json, host: `evil.example:${port}` } })).toBe(403);
    expect(await call(port, { method: "GET", path: "/status", headers: { host: `evil.example:${port}` }, body: "" })).toBe(403);
    expect(stopped).toBe(false);

    expect(await call(port, { path: "/stop", headers: json })).toBe(200);
    expect(stopped).toBe(true);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
