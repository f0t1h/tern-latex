import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { loadConfig, type Config } from "../src/config.ts";
import { CHECKPOINT_REF, checkpoint, initialCommit, listCheckpoints, restore } from "../src/vcs.ts";

let root: string;
let dir: string;
let cfg: Config;
const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
const sh = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
/** Everything a checkpoint must leave alone. */
const userState = () => ({
  head: sh("rev-parse", "HEAD"),
  index: sh("ls-files", "--stage"),
  status: sh("status", "--porcelain"),
  stash: sh("stash", "list"),
  branches: sh("for-each-ref", "refs/heads", "refs/stash"),
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ternlatex-vcs-"));
  // No user identity: checkpoints and the first commit must fall back to ternlatex's own.
  writeFileSync(join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\nOne.\n\\end{document}\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  sh("init", "-q");
  await initialCommit(dir);
  cfg = loadConfig(dir);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

test("initialCommit commits the project once, with the fallback identity", async () => {
  assert.equal(sh("log", "--format=%s %an"), "ternlatex: initial project ternlatex");
  assert.deepEqual(sh("ls-tree", "--name-only", "HEAD").split("\n"), [".gitignore", "main.tex", "ternlatex.toml"]);
  await initialCommit(dir);
  assert.equal(sh("rev-list", "--count", "HEAD"), "1");
});

test("checkpoints snapshot untracked files, skip ignored ones and leave HEAD, index, status and stash alone", async () => {
  writeFileSync(join(dir, "stashed.tex"), "x\n");
  sh("add", "stashed.tex");
  sh("stash", "-q");
  writeFileSync(join(dir, "staged.tex"), "staged\n");
  sh("add", "staged.tex");
  writeFileSync(join(dir, "main.tex"), readFileSync(join(dir, "main.tex"), "utf8").replace("One.", "Two."));
  writeFileSync(join(dir, "notes.tex"), "untracked\n");
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build/main.pdf"), "pdf");
  const before = userState();

  const sha = await checkpoint(cfg, "first");
  assert.ok(sha);
  assert.deepEqual(userState(), before);
  const files = sh("ls-tree", "-r", "--name-only", CHECKPOINT_REF).split("\n");
  assert.ok(files.includes("notes.tex") && files.includes("staged.tex"));
  assert.ok(!files.some((f) => f.startsWith("build/")), "gitignored output stays out");
  assert.match(sh("show", `${CHECKPOINT_REF}:main.tex`), /Two\./);
  assert.equal(await checkpoint(cfg, "unchanged"), null);
  assert.deepEqual(userState(), before);
});

test("concurrent checkpoints form one linear chain", async () => {
  const shas = await Promise.all(
    [1, 2, 3].map((i) => {
      writeFileSync(join(dir, `c${i}.tex`), `${i}\n`);
      return checkpoint(cfg, `c${i}`);
    }),
  );
  // The first one sees all three files; the others then find nothing new.
  assert.equal(shas.filter(Boolean).length, 1);
  const list = await listCheckpoints(cfg);
  assert.deepEqual(
    list.map((c) => c.message),
    ["c1", "first"],
  );
  assert.equal(sh("rev-list", "--count", CHECKPOINT_REF), "2");
  assert.match(list[0].date, /^\d{4}-\d\d-\d\dT/);
});

test("restore brings back old content, removes files created since, checkpoints first and keeps the index", async () => {
  const index = sh("ls-files", "--stage");
  writeFileSync(join(dir, "main.tex"), "changed after\n");
  await restore(cfg, `${CHECKPOINT_REF}~1`);
  assert.match(readFileSync(join(dir, "main.tex"), "utf8"), /Two\./);
  assert.ok(!existsSync(join(dir, "c1.tex")), "file absent at the restored revision is removed");
  assert.ok(existsSync(join(dir, "notes.tex")));
  assert.ok(existsSync(join(dir, "build/main.pdf")), "ignored files are left alone");
  assert.equal(sh("ls-files", "--stage"), index);
  const [latest] = await listCheckpoints(cfg, 1);
  assert.equal(latest.message, `before restore to ${CHECKPOINT_REF}~1`);
  assert.equal(sh("show", `${latest.sha}:main.tex`), "changed after");

  await restore(cfg, latest.sha, ["main.tex"]);
  assert.equal(readFileSync(join(dir, "main.tex"), "utf8"), "changed after\n");
  assert.ok(!existsSync(join(dir, "c1.tex")), "a path-limited restore touches only those paths");
});

test("outside a git repository checkpoint returns null and there are no checkpoints", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ternlatex-nogit-"));
  try {
    writeFileSync(join(bare, "ternlatex.toml"), 'root = "main.tex"\n');
    writeFileSync(join(bare, "main.tex"), "x\n");
    const plain = loadConfig(bare);
    assert.equal(await checkpoint(plain, "x"), null);
    assert.deepEqual(await listCheckpoints(plain), []);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
