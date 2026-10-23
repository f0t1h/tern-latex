import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullVerdict } from "../omp/extension.ts";
import { isOverleafUrl, pullOverleaf } from "../src/overleaf.ts";
import { gitOk } from "../src/vcs.ts";

const root = mkdtempSync(join(tmpdir(), "ternlatex-overleaf-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
const PROJECT = "0123456789abcdef01234567";

test("Overleaf Cloud and Server Pro Git URLs are recognised; other remotes are not", () => {
  expect(isOverleafUrl(`https://git.overleaf.com/${PROJECT}`)).toBe(true);
  expect(isOverleafUrl(`https://git@git.overleaf.com/${PROJECT}`)).toBe(true);
  expect(isOverleafUrl(`https://latex.example.edu/git/${PROJECT}`)).toBe(true);
  expect(isOverleafUrl("https://github.com/someone/paper.git")).toBe(false);
  expect(isOverleafUrl("git@github.com:someone/paper.git")).toBe(false);
  expect(isOverleafUrl("https://git.overleaf.com/not-a-project")).toBe(false);
});

/** "Overleaf" (a bare repo reached through an Overleaf URL), a co-author's clone, and ours. */
async function setup(name: string, remoteUrl = `https://git.overleaf.com/${PROJECT}`) {
  const dir = join(root, name);
  const bare = join(dir, "overleaf.git");
  mkdirSync(dir, { recursive: true });
  await gitOk(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  const clone = async (who: string) => {
    const at = join(dir, who);
    await gitOk(dir, ["clone", "-q", bare, at]);
    await gitOk(at, ["config", `url.${bare}.insteadOf`, remoteUrl]);
    await gitOk(at, ["remote", "set-url", "origin", remoteUrl]);
    return at;
  };
  const coauthor = await clone("coauthor");
  writeFileSync(join(coauthor, "main.tex"), "one\n");
  writeFileSync(join(coauthor, "intro.tex"), "intro\n");
  await gitOk(coauthor, ["add", "-A"]);
  await gitOk(coauthor, [...ID, "commit", "-qm", "start"]);
  await gitOk(coauthor, ["push", "-q", "origin", "main"]);
  const ours = await clone("ours");
  const coauthorEdits = async (file: string, text: string) => {
    writeFileSync(join(coauthor, file), text);
    await gitOk(coauthor, [...ID, "commit", "-qam", `edit ${file}`]);
    await gitOk(coauthor, ["push", "-q", "origin", "main"]);
  };
  return { ours, coauthorEdits };
}

test("a clone behind Overleaf is rebased onto it, keeping uncommitted edits to other files", async () => {
  const { ours, coauthorEdits } = await setup("behind");
  expect(await pullOverleaf(ours)).toEqual({ overleaf: true, pulled: 0, files: [] });
  await coauthorEdits("main.tex", "one, edited in Overleaf\n");
  writeFileSync(join(ours, "intro.tex"), "intro, edited here\n");
  expect(await pullOverleaf(ours)).toEqual({ overleaf: true, pulled: 1, files: ["main.tex"] });
  expect(readFileSync(join(ours, "main.tex"), "utf8")).toBe("one, edited in Overleaf\n");
  expect(readFileSync(join(ours, "intro.tex"), "utf8")).toBe("intro, edited here\n");
});

test("uncommitted edits to a file Overleaf also changed stop the pull and stay as they are", async () => {
  const { ours, coauthorEdits } = await setup("clash");
  await coauthorEdits("main.tex", "theirs\n");
  writeFileSync(join(ours, "main.tex"), "mine\n");
  const r = await pullOverleaf(ours);
  expect(r.pulled).toBe(0);
  expect(r.problem).toContain("main.tex");
  expect(readFileSync(join(ours, "main.tex"), "utf8")).toBe("mine\n");
});

test("a local commit that conflicts with Overleaf is left in place, the rebase undone", async () => {
  const { ours, coauthorEdits } = await setup("conflict");
  await coauthorEdits("main.tex", "theirs\n");
  writeFileSync(join(ours, "main.tex"), "mine\n");
  await gitOk(ours, [...ID, "commit", "-qam", "mine"]);
  const r = await pullOverleaf(ours);
  expect(r.problem).toContain("conflicts");
  expect(readFileSync(join(ours, "main.tex"), "utf8")).toBe("mine\n");
  expect(await gitOk(ours, ["status", "--porcelain"])).toBe("");
});

test("a clone of another host is not touched", async () => {
  const { ours, coauthorEdits } = await setup("github", "https://github.com/someone/paper.git");
  await coauthorEdits("main.tex", "theirs\n");
  expect(await pullOverleaf(ours)).toEqual({ overleaf: false, pulled: 0, files: [] });
  expect(readFileSync(join(ours, "main.tex"), "utf8")).toBe("one\n");
});

test("omp's first edit waits only when the pull brought changes or could not run", () => {
  expect(pullVerdict(JSON.stringify({ overleaf: false, pulled: 0, files: [] }))).toBeNull();
  expect(pullVerdict(JSON.stringify({ overleaf: true, pulled: 0, files: [] }))).toBeNull();
  expect(pullVerdict(JSON.stringify({ overleaf: true, pulled: 2, files: ["a.tex"] }))).toContain("read the files again");
  expect(pullVerdict(JSON.stringify({ overleaf: true, pulled: 0, files: [], problem: "x" }))).toContain("Tell the user");
  expect(pullVerdict("ternlatex: not found")).toBeNull();
});
