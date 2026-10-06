import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, zipSync } from "fflate";
import { loadConfig } from "../src/config.ts";
import { extractTar, extractZip, install, verifySha256 } from "../src/download.ts";
import { cacheDir, clearToolCache, initToolEnv, rememberPath, resolveTool, selfCommand, ToolMissingError } from "../src/tools.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-tools-test-"));
const saved = {
  PATH: process.env.PATH,
  TERNLATEX_CACHE: process.env.TERNLATEX_CACHE,
  TERNLATEX_DATA: process.env.TERNLATEX_DATA,
  TECTONIC_CACHE_DIR: process.env.TECTONIC_CACHE_DIR,
  TERNLATEX_TECTONIC: process.env.TERNLATEX_TECTONIC,
  TERN_BIN: process.env.TERN_BIN,
  TERNLATEX_TERN: process.env.TERNLATEX_TERN,
};

/** An empty executable named NAME in DIR (what PATH lookup needs; it is never run). */
function fakeTool(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "");
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearToolCache();
}

beforeAll(() => {
  process.env.TERNLATEX_CACHE = join(root, "cache");
});
afterEach(() => {
  restoreEnv();
  process.env.TERNLATEX_CACHE = join(root, "cache");
});
afterAll(() => {
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveTool", () => {
  test("precedence: env > config > PATH", async () => {
    const onPath = fakeTool(join(root, "path"), "tectonic");
    const configured = fakeTool(join(root, "configured"), "tectonic");
    const fromEnv = fakeTool(join(root, "env"), "tectonic");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "main.tex"), "\\documentclass{article}\n");
    writeFileSync(join(project, "ternlatex.toml"), `root = "main.tex"\n[tools]\ntectonic = ${JSON.stringify(configured)}\n`);
    const cfg = loadConfig(project);
    process.env.PATH = [join(root, "path"), saved.PATH].join(delimiter);
    delete process.env.TERNLATEX_TECTONIC;

    clearToolCache();
    expect(await resolveTool("tectonic")).toMatchObject({ source: "path", command: [onPath] });
    clearToolCache();
    expect(await resolveTool("tectonic", cfg)).toMatchObject({ source: "config", command: [configured] });
    clearToolCache();
    process.env.TERNLATEX_TECTONIC = fromEnv;
    expect(await resolveTool("tectonic", cfg)).toMatchObject({ source: "env", command: [fromEnv] });
  });

  test("results are cached per process", async () => {
    process.env.TERNLATEX_TECTONIC = fakeTool(join(root, "cached-a"), "tectonic");
    const first = await resolveTool("tectonic");
    process.env.TERNLATEX_TECTONIC = fakeTool(join(root, "cached-b"), "tectonic");
    expect(await resolveTool("tectonic")).toBe(first);
  });

  test("TERN_BIN stays an alias for tern", async () => {
    delete process.env.TERNLATEX_TERN;
    process.env.TERN_BIN = fakeTool(join(root, "tern-alias"), "tern");
    expect(await resolveTool("tern")).toMatchObject({ source: "env", command: [process.env.TERN_BIN] });
  });

  test("a bad override is reported, not skipped", async () => {
    process.env.TERNLATEX_TECTONIC = join(root, "nowhere", "tectonic");
    await expect(resolveTool("tectonic")).rejects.toThrow(/TERNLATEX_TECTONIC.*is not an executable/);
  });

  test("download: false never downloads a missing managed tool", async () => {
    process.env.PATH = join(root, "empty-path");
    const err = await resolveTool("pandoc", undefined, { download: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolMissingError);
    expect(String(err)).toContain("ternlatex doctor --warm");
    expect(String(err)).toContain("TERNLATEX_PANDOC");
    expect(existsSync(join(cacheDir(), "tools"))).toBe(false);
  });
});

test("cacheDir honours TERNLATEX_CACHE", () => {
  expect(cacheDir()).toBe(join(root, "cache"));
});

test("a run started with a bare PATH (Tern's daemon) gains the PATH remembered at setup", async () => {
  process.env.TERNLATEX_DATA = join(root, "data");
  const shellPath = join(root, "shell-bin");
  const omp = fakeTool(shellPath, "omp");
  process.env.PATH = [join(root, "bare"), shellPath].join(delimiter);
  rememberPath();
  process.env.PATH = join(root, "bare");
  initToolEnv();
  expect(process.env.PATH).toBe([join(root, "bare"), shellPath].join(delimiter));
  expect((await resolveTool("omp")).command).toEqual([omp]);
});

test("selfCommand re-runs this source checkout through the runtime", () => {
  const cmd = selfCommand();
  expect(cmd).toHaveLength(2);
  expect(cmd[0]).toBe(process.execPath);
  expect(isAbsolute(cmd[1])).toBe(true);
  expect(cmd[1].endsWith(join("src", "cli.ts"))).toBe(true);
  expect(existsSync(cmd[1])).toBe(true);
});

/** Minimal ustar writer for fixtures; TYPE "x" makes a pax header carrying `path`. */
function tarEntry(name: string, data: Uint8Array, type: string, mode = 0o644): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
  put(name.slice(0, 99), 0);
  put(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  put("        ", 148);
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(data);
  const out = new Uint8Array(512 + body.length);
  out.set(h);
  out.set(body, 512);
  return out;
}

function tar(...entries: Uint8Array[]): Uint8Array {
  return Buffer.concat([...entries, new Uint8Array(1024)]);
}

const text = (s: string) => new TextEncoder().encode(s);

function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len++;
  return text(`${len}${body}`);
}

describe("archives", () => {
  test("tar: files, directories, exec bits, pax long names; links skipped", async () => {
    const dest = join(root, "untar");
    const long = `deep/${"d".repeat(120)}/file.txt`;
    const archive = tar(
      tarEntry("pkg/", new Uint8Array(), "5", 0o755),
      tarEntry("pkg/bin/tool", text("tool"), "0", 0o755),
      tarEntry("pkg/readme", text("hello"), "0"),
      tarEntry("pax", paxRecord("path", long), "x"),
      tarEntry("truncated-name", text("long"), "0"),
      tarEntry("pkg/link", new Uint8Array(), "2"),
    );
    const written = await extractTar(archive, dest);
    expect(written).toHaveLength(3);
    expect(readFileSync(join(dest, "pkg", "readme"), "utf8")).toBe("hello");
    expect(readFileSync(join(dest, ...long.split("/")), "utf8")).toBe("long");
    expect(existsSync(join(dest, "pkg", "link"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(dest, "pkg", "bin", "tool")).mode & 0o111).not.toBe(0);
  });

  test("tar: members escaping the destination are rejected", async () => {
    await expect(extractTar(tar(tarEntry("../evil", text("x"), "0")), join(root, "evil"))).rejects.toThrow(/unsafe archive member/);
  });

  test("tar: GNU sparse members (Tectonic's linux-gnu release) are rebuilt with their holes", async () => {
    // Old-GNU 'S' header: chunks (0, 4) and (1000, 4) of a 1004-byte file; stored data is "headtail".
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(text(s), off);
    const oct = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;
    put("tool", 0);
    put(oct(0o755, 8), 100);
    put(oct(0, 8), 108);
    put(oct(0, 8), 116);
    put(oct(8, 12), 124);
    put(oct(0, 12), 136);
    put("S", 156);
    put("ustar  \0", 257);
    put(oct(0, 12), 386);
    put(oct(4, 12), 398);
    put(oct(1000, 12), 410);
    put(oct(4, 12), 422);
    put(oct(1004, 12), 483);
    put("        ", 148);
    put(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    const body = new Uint8Array(512);
    body.set(text("headtail"));
    const dest = join(root, "sparse");
    const written = await extractTar(tar(h, body, tarEntry("after", text("next"), "0")), dest);
    expect(written).toHaveLength(2);
    const file = readFileSync(join(dest, "tool"));
    expect(file.length).toBe(1004);
    expect(file.subarray(0, 4).toString()).toBe("head");
    expect(file.subarray(1000).toString()).toBe("tail");
    expect(file.subarray(4, 1000).every((b) => b === 0)).toBe(true);
    expect(readFileSync(join(dest, "after"), "utf8")).toBe("next");
  });

  test("zip: nested files", async () => {
    const dest = join(root, "unzip");
    const written = await extractZip(zipSync({ "pkg/bin/tool.exe": text("exe"), "pkg/a.txt": text("a") }), dest);
    expect(written.sort()).toEqual([join(dest, "pkg", "a.txt"), join(dest, "pkg", "bin", "tool.exe")]);
    expect(readFileSync(join(dest, "pkg", "bin", "tool.exe"), "utf8")).toBe("exe");
  });
});

describe("install", () => {
  const archive = gzipSync(tar(tarEntry("tool-1.0/bin/tool", text("binary"), "0", 0o644)));
  const sha256 = createHash("sha256").update(archive).digest("hex");
  // Loopback only: the tests never reach the network.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(archive) });
  const url = `http://127.0.0.1:${server.port}/tool.tar.gz`;
  afterAll(() => server.stop(true));

  test("checksum mismatch rejects and installs nothing", async () => {
    const dir = join(root, "install-bad");
    await expect(install({ url, sha256: "0".repeat(64), archive: "tar.gz", bin: "tool-1.0/bin/tool", label: "tool 1.0" }, dir)).rejects.toThrow(/checksum mismatch/);
    expect(() => verifySha256(text("x"), "0".repeat(64), "x")).toThrow(/checksum mismatch/);
    expect(existsSync(dir)).toBe(false);
  });

  test("verified archive is extracted in place with an executable bin", async () => {
    const dir = join(root, "install-ok");
    const bin = await install({ url, sha256, archive: "tar.gz", bin: "tool-1.0/bin/tool", label: "tool 1.0" }, dir);
    expect(bin).toBe(join(dir, "tool-1.0", "bin", "tool"));
    expect(readFileSync(bin, "utf8")).toBe("binary");
    if (process.platform !== "win32") expect(statSync(bin).mode & 0o111).not.toBe(0);
  });
});
