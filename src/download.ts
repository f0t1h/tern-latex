import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { gunzipSync, unzipSync } from "fflate";

export type ArchiveKind = "tar.gz" | "zip";

/** Fetches URL into memory, printing progress on stderr, and rejects unless its sha256 is SHA256. */
export async function fetchVerified(url: string, sha256: string, label: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download of ${label} failed: HTTP ${res.status} from ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let got = 0;
  let shown = 0;
  const mb = (n: number) => (n / 1e6).toFixed(1);
  const tty = process.stderr.isTTY;
  process.stderr.write(`downloading ${label}${total ? ` (${mb(total)} MB)` : ""}${tty ? "" : "…\n"}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    chunks.push(value);
    got += value.length;
    if (tty && Date.now() - shown > 200) {
      shown = Date.now();
      process.stderr.write(`\rdownloading ${label}: ${mb(got)}${total ? `/${mb(total)}` : ""} MB`);
    }
  }
  if (tty) process.stderr.write(`\rdownloading ${label}: ${mb(got)} MB, done\n`);
  const bytes = Buffer.concat(chunks);
  verifySha256(bytes, sha256, label);
  return bytes;
}

/** Throws unless BYTES hash to the hex sha256 EXPECTED. */
export function verifySha256(bytes: Uint8Array, expected: string, label: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.toLowerCase()) throw new Error(`checksum mismatch for ${label}: expected sha256 ${expected}, got ${actual}`);
}

/** Archive member name → path under DEST; rejects absolute names and `..` escapes. */
function memberPath(dest: string, name: string): string | null {
  const parts = name.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (!parts.length) return null;
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.includes("..")) throw new Error(`unsafe archive member ${JSON.stringify(name)}`);
  return normalize(join(dest, ...parts));
}

async function writeMember(path: string, data: Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  if (process.platform !== "win32" && mode & 0o111) await chmod(path, 0o755);
}

const decoder = new TextDecoder();

/** NUL-terminated header field. */
function field(h: Uint8Array, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const end = raw.indexOf(0);
  return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
}

function octal(h: Uint8Array, start: number, len: number): number {
  // GNU base-256 for sizes past 8 GiB: high bit set, big-endian binary.
  if (h[start] & 0x80) {
    let n = h[start] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + h[start + i];
    return n;
  }
  const s = field(h, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** pax extended header records: "<len> key=value\n". */
function paxPath(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number(decoder.decode(data.subarray(i, space)));
    if (!len) break;
    const rec = decoder.decode(data.subarray(space + 1, i + len - 1));
    if (rec.startsWith("path=")) path = rec.slice(5);
    i += len;
  }
  return path;
}

/**
 * GNU old-format sparse member ('S'): the header holds up to 4 (offset, size) chunks, extension blocks after it
 * hold 21 more each; the stored data is the chunks back to back, and everything else is zero.
 * Tectonic's x86_64-linux-gnu release stores its binary this way. Returns the file and the blocks consumed.
 */
function sparseMember(tar: Uint8Array, headerOff: number): { data: Uint8Array; end: number } {
  const h = tar.subarray(headerOff, headerOff + 512);
  const chunks: [number, number][] = [];
  const read = (block: Uint8Array, at: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const offset = octal(block, at + i * 24, 12);
      const size = octal(block, at + i * 24 + 12, 12);
      if (offset || size) chunks.push([offset, size]);
    }
  };
  read(h, 386, 4);
  let off = headerOff + 512;
  let extended = h[482] !== 0;
  while (extended && off + 512 <= tar.length) {
    const ext = tar.subarray(off, off + 512);
    read(ext, 0, 21);
    extended = ext[504] !== 0;
    off += 512;
  }
  const stored = octal(h, 124, 12);
  const file = new Uint8Array(octal(h, 483, 12));
  let src = off;
  for (const [offset, size] of chunks) {
    file.set(tar.subarray(src, src + size), offset);
    src += size;
  }
  return { data: file, end: off + Math.ceil(stored / 512) * 512 };
}

/**
 * Extracts a ustar/pax/GNU tar into DEST: regular and GNU sparse files (keeping the executable bit) and
 * directories. Links and devices are skipped. Returns the written file paths.
 */
export async function extractTar(tar: Uint8Array, dest: string): Promise<string[]> {
  const written: string[] = [];
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    let data = tar.subarray(off + 512, off + 512 + size);
    const headerOff = off;
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    if (type === "S") ({ data, end: off } = sparseMember(tar, headerOff));
    // Only POSIX ustar ("ustar\0") has a name prefix at 345; GNU's "ustar  " keeps atime/ctime there.
    const prefix = field(h, 257, 6) === "ustar" ? field(h, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = undefined;
    const path = memberPath(dest, name);
    if (!path) continue;
    if (type === "5") await mkdir(path, { recursive: true });
    else if (type === "0" || type === "7" || type === "S") {
      await writeMember(path, data, octal(h, 100, 8));
      written.push(path);
    }
  }
  return written;
}

/** Extracts every file of a zip into DEST. Zip carries no portable mode bits; callers chmod what they run. */
export async function extractZip(zip: Uint8Array, dest: string): Promise<string[]> {
  const written: string[] = [];
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    const path = memberPath(dest, name);
    if (!path) continue;
    if (name.endsWith("/")) await mkdir(path, { recursive: true });
    else {
      await writeMember(path, data, 0);
      written.push(path);
    }
  }
  return written;
}

export interface InstallSpec {
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** Path of the executable (or script) inside the extracted tree, `/`-separated. */
  bin: string;
  /** Shown in progress and errors, e.g. "tectonic 0.17.0". */
  label: string;
}

/**
 * Makes DIR hold SPEC's verified, extracted contents and returns the path of its `bin`. Works in a sibling
 * temp directory renamed into place, so an interrupted run never leaves a half-installed DIR.
 */
export async function install(spec: InstallSpec, dir: string): Promise<string> {
  const bin = join(dir, ...spec.bin.split("/"));
  if (existsSync(bin)) return bin;
  const bytes = await fetchVerified(spec.url, spec.sha256, spec.label);
  const tmp = `${dir}.${process.pid}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    if (spec.archive === "zip") await extractZip(bytes, tmp);
    else await extractTar(gunzipSync(bytes), tmp);
    const tmpBin = join(tmp, ...spec.bin.split("/"));
    if (!existsSync(tmpBin)) throw new Error(`${spec.label}: ${spec.bin} is missing from ${spec.url}`);
    if (process.platform !== "win32") await chmod(tmpBin, 0o755);
    await mkdir(dirname(dir), { recursive: true });
    try {
      await rename(tmp, dir);
    } catch (e) {
      // Another process installed it first; theirs is just as verified.
      if (!existsSync(bin)) throw e;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return bin;
}
