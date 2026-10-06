import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeProjectKit } from "../src/commands/agent.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-agent-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("removeProjectKit removes the 0.1 kit and leaves no empty .omp behind", async () => {
  const dir = project("old", {
    ".omp/AGENTS.md": "# ternlatex project\n\nThis is a LaTeX project edited live in Tern.\n",
    ".omp/skills/table/SKILL.md": "---\nname: table\n---\n",
    ".omp/skills/fix-build/SKILL.md": "---\nname: fix-build\n---\n",
    "main.tex": "",
  });
  const removed = await removeProjectKit(dir);
  expect(removed.sort()).toEqual([join(dir, ".omp", "AGENTS.md"), join(dir, ".omp", "skills", "fix-build"), join(dir, ".omp", "skills", "table")]);
  expect(existsSync(join(dir, ".omp"))).toBe(false);
  expect(existsSync(join(dir, "main.tex"))).toBe(true);
});

test("removeProjectKit keeps the user's own AGENTS.md, skills and other .omp files", async () => {
  const dir = project("own", {
    ".omp/AGENTS.md": "# My rules\n",
    ".omp/skills/table/SKILL.md": "---\nname: table\n---\n",
    ".omp/skills/my-skill/SKILL.md": "---\nname: my-skill\n---\n",
    ".omp/config.yml": "model: x\n",
  });
  expect(await removeProjectKit(dir)).toEqual([join(dir, ".omp", "skills", "table")]);
  expect(readdirSync(join(dir, ".omp")).sort()).toEqual(["AGENTS.md", "config.yml", "skills"]);
  expect(readdirSync(join(dir, ".omp", "skills"))).toEqual(["my-skill"]);
});

test("removeProjectKit does nothing in a project without .omp", async () => {
  const dir = project("fresh", { "main.tex": "" });
  expect(await removeProjectKit(dir)).toEqual([]);
  expect(readdirSync(dir)).toEqual(["main.tex"]);
});
