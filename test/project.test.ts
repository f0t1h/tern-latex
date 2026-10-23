import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptGit } from "../src/commands/project.ts";
import { git, gitOk } from "../src/vcs.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-project-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

/** A repo with one commit holding main.tex (as a clone of an Overleaf project is), in SUB when given. */
async function clone(name: string, sub = ""): Promise<string> {
  const repo = join(root, name);
  const dir = join(repo, sub);
  mkdirSync(dir, { recursive: true });
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
  await gitOk(repo, ["add", "-A"]);
  await gitOk(repo, [...ID, "commit", "-qm", "overleaf"]);
  return dir;
}

test("adopting a repo with commits keeps ternlatex's files untracked without .gitignore or a commit", async () => {
  const dir = await clone("overleaf");
  expect(await adoptGit(dir, "build")).toBe(true);
  // What ternlatex then writes into the project.
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build", "main.pdf"), "");
  mkdirSync(join(dir, "style"));
  writeFileSync(join(dir, "style", "ternlatex-review.tex"), "");
  expect((await git(dir, ["status", "--porcelain"])).stdout).toBe("");
  expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  expect((await gitOk(dir, ["rev-list", "--count", "HEAD"]))).toBe("1");
  // A second adoption adds nothing twice.
  await adoptGit(dir, "build");
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8").match(/\/ternlatex\.toml/g)?.length).toBe(1);
});

test("in a project inside a larger repo, only that folder's files are excluded", async () => {
  const dir = await clone("mono", "papers/one");
  await adoptGit(dir, "out");
  writeFileSync(join(dir, "ternlatex.toml"), "");
  writeFileSync(join(root, "mono", "ternlatex.toml"), ""); // someone else's, at the repo root
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out", "x.pdf"), "");
  expect((await git(dir, ["status", "--porcelain", "--", ":/"])).stdout.trim()).toBe("?? ternlatex.toml");
});

test("a folder without commits gets its own repository, as a new project does", async () => {
  const dir = join(root, "fresh");
  mkdirSync(dir);
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
  expect(await adoptGit(dir, "build")).toBe(false);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("build/");
});
