import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pullVerdict } from "../omp/extension.ts";
import type { Status } from "../src/builder.ts";
import { withReviewFallback } from "../src/changes.ts";
import { type Config, docPaths, loadConfig } from "../src/config.ts";
import { isOverleafUrl, overleafState, pullOverleaf, pushOverleaf } from "../src/overleaf.ts";
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
  expect(r.problem).toContain("conflict with Overleaf's 1 new commit(s) in main.tex");
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

/** OURS as a ternlatex project (its config untracked, as `adopt` leaves it) with git's identity set. */
async function project(ours: string): Promise<Config> {
  writeFileSync(join(ours, "ternlatex.toml"), 'root = "main.tex"\n[review]\nme = "FK"\n');
  writeFileSync(join(ours, ".git", "info", "exclude"), "ternlatex.toml\nbuild/\n");
  await gitOk(ours, ["config", "user.email", "t@example.com"]);
  await gitOk(ours, ["config", "user.name", "t"]);
  return loadConfig(ours);
}

function builds(ok: boolean | null, partial = false) {
  const calls = { n: 0 };
  const build = async (): Promise<Status[]> => {
    calls.n++;
    return [{ doc: "main", root: "main.tex", build: 1, rev: 1, state: "idle", ok, partial, engine: "tectonic", diagnostics: [] }];
  };
  return { build, calls };
}

const overleafHas = async (dir: string, file: string) => {
  const at = join(dir, "check");
  rmSync(at, { recursive: true, force: true });
  await gitOk(dir, ["clone", "-q", join(dir, "overleaf.git"), at]);
  return readFileSync(join(at, file), "utf8");
};

test("push waits until omp's suggestions are accepted or rejected, then sends only the user's text", async () => {
  const { ours } = await setup("push-omp");
  const cfg = await project(ours);
  writeFileSync(join(ours, "main.tex"), "one \\added[id=omp]{more}\n");
  const refused = await pushOverleaf(cfg, { build: builds(true).build });
  expect(refused.pushed).toBe(0);
  expect(refused.problem).toContain("omp");
  expect(refused.problem).toContain("main.tex:1");
  expect(await overleafHas(join(root, "push-omp"), "main.tex")).toBe("one\n");

  writeFileSync(join(ours, "main.tex"), "one more\n");
  const r = await pushOverleaf(cfg, { build: builds(true).build, message: "More" });
  expect(r).toEqual({ pushed: 1, committed: ["main.tex"], pulled: 0 });
  expect(await overleafHas(join(root, "push-omp"), "main.tex")).toBe("one more\n");
  expect(await gitOk(ours, ["log", "-1", "--format=%s"])).toBe("More");
});

test("a failing or partial build is not pushed, nor its edits committed", async () => {
  const { ours } = await setup("push-broken");
  const cfg = await project(ours);
  writeFileSync(join(ours, "main.tex"), "one \\undefined\n");
  expect((await pushOverleaf(cfg, { build: builds(false).build })).problem).toContain("fails to build");
  expect((await pushOverleaf(cfg, { build: builds(false, true).build })).problem).toContain("only partially");
  expect(await gitOk(ours, ["status", "--porcelain", "--untracked-files=no"])).toBe("M main.tex");
  expect(await overleafHas(join(root, "push-broken"), "main.tex")).toBe("one\n");
});

test("Overleaf's new commits are pulled under the user's before pushing, and the result built again", async () => {
  const { ours, coauthorEdits } = await setup("push-behind");
  const cfg = await project(ours);
  await coauthorEdits("intro.tex", "intro, edited in Overleaf\n");
  writeFileSync(join(ours, "main.tex"), "one, edited here\n");
  const { build, calls } = builds(true);
  expect(await pushOverleaf(cfg, { build })).toMatchObject({ pushed: 1, pulled: 1, committed: ["main.tex"] });
  expect(calls.n).toBe(2);
  expect(await overleafHas(join(root, "push-behind"), "main.tex")).toBe("one, edited here\n");
  expect(await overleafHas(join(root, "push-behind"), "intro.tex")).toBe("intro, edited in Overleaf\n");
});

test("a new file the build reads goes to Overleaf with the edits; other untracked files stay local", async () => {
  const { ours } = await setup("push-figure");
  const cfg = await project(ours);
  mkdirSync(join(ours, "figs"));
  writeFileSync(join(ours, "figs", "plot.pdf"), "%PDF\n");
  writeFileSync(join(ours, "notes.txt"), "mine\n");
  writeFileSync(join(ours, "main.tex"), "one \\includegraphics{figs/plot}\n");
  const deps = docPaths(cfg, cfg.docs[0]).deps;
  mkdirSync(dirname(deps), { recursive: true });
  writeFileSync(deps, `main.pdf: ${join(ours, "main.tex")} ${join(ours, "figs", "plot.pdf")}\n`);
  const r = await pushOverleaf(cfg, { build: builds(true).build });
  expect(r.committed.sort()).toEqual(["figs/plot.pdf", "main.tex"]);
  expect(await overleafHas(join(root, "push-figure"), "figs/plot.pdf")).toBe("%PDF\n");
  expect(await gitOk(ours, ["status", "--porcelain"])).toBe("?? notes.txt");
});

test("co-authors' recent Overleaf edits are counted per person, latest files first, the user's own left out", async () => {
  const { ours, coauthorEdits } = await setup("people");
  const cfg = await project(ours);
  await gitOk(ours, ["config", "user.email", "me@example.com"]);
  await gitOk(ours, ["config", "user.name", "Me"]);
  await coauthorEdits("intro.tex", "intro, edited in Overleaf\n");
  writeFileSync(join(ours, "main.tex"), "one, mine\n");
  expect((await pushOverleaf(cfg, { build: builds(true).build })).pushed).toBe(1);
  const state = await overleafState(ours);
  expect(state?.people.map((p) => ({ name: p.name, commits: p.commits, files: p.files }))).toEqual([
    { name: "t", commits: 2, files: ["intro.tex", "main.tex"] },
  ]);
  expect(Date.now() - Date.parse(state?.people[0].lastAt ?? "")).toBeLessThan(60_000);
});

test("the shared review fallback gains the authors with marks it lacks, keeps a co-author's entry, else stays as is", () => {
  const dir = join(root, "fallback");
  mkdirSync(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), "\n");
  const cfg = loadConfig(dir);
  const me = { id: "FK", name: "F K" };
  const text = [
    "\\InputIfFileExists{style/ternlatex-review.tex}{}{%",
    "  \\def\\tlreviewsetup{\\definechangesauthor[name={Ana}, color=blue]{AK}}}",
    "\\usepackage{changes}\\csname tlreviewsetup\\endcsname",
    "",
  ].join("\n");
  expect(withReviewFallback(text, cfg, ["AK"], me)).toBeNull();
  const out = withReviewFallback(text, cfg, ["AK", "FK", "omp"], me) ?? "";
  expect(out).toContain("\\definechangesauthor[name={Ana}, color=blue]{AK}%");
  expect(out).toContain("\\definechangesauthor[name={F K}, color=");
  expect(out).toContain("]{omp}%");
  expect(out).not.toContain("{proof}");
  expect(out).toContain("\\PassOptionsToPackage{draft,highlightmarkup=uwave}{changes}");
  expect(out.endsWith("}\n\\usepackage{changes}\\csname tlreviewsetup\\endcsname\n")).toBe(true);
  expect(withReviewFallback(out, cfg, ["AK", "FK", "omp"], me)).toBeNull();
  expect(withReviewFallback("\\usepackage{changes}\n", cfg, ["FK"], me)).toBeNull();
});
