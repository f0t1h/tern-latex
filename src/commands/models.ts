import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { CONFIG_FILE, type Config, loadConfig, UsageError } from "../config.ts";
import { ompRoles, roleFor, type Task, TASK_ROLES, TASK_TITLES, TASKS } from "../models.ts";

/** Model lines older projects' ternlatex.toml carry, which are no longer read ([proofread] / [rewrite] `model`). */
function legacyModelKeys(dir: string): string[] {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return [];
  let raw: Record<string, unknown>;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return ["proofread", "rewrite"].filter((t) => {
    const table = raw[t];
    return Boolean(table && typeof table === "object" && "model" in table);
  });
}

/**
 * `ternlatex models`: which omp role, and so which model, each task uses (src/models.ts), and how to change it. Works
 * outside a project too; inside one, a project's own `.omp/config.yml` roles count for the omp block.
 */
export async function models(): Promise<number> {
  let cfg: Config | undefined;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
  }
  const dir = cfg?.dir ?? process.cwd();
  // Proofread and rewrite run omp from outside the project (askOmp), the omp block from inside it.
  const seen: Record<Task, Record<string, string>> = {
    assistant: await ompRoles(dir, cfg),
    proofread: await ompRoles(tmpdir(), cfg),
    rewrite: await ompRoles(tmpdir(), cfg),
  };
  const rows = TASKS.map((task) => {
    const roles = seen[task];
    const own = TASK_ROLES[task][0];
    const used = roleFor(task, roles);
    const model = used === null ? "omp's default model" : `@${used}${roles[used] ? ` = ${roles[used]}` : " (omp's built-in choice)"}`;
    return [TASK_TITLES[task], `@${own}`, used === own ? model : `not defined → ${model}`];
  });
  const width = (i: number) => Math.max(...rows.map((r) => r[i].length));
  for (const r of rows) console.log(`${r[0].padEnd(width(0))}  ${r[1].padEnd(width(1))}  ${r[2]}`);
  const chains = TASKS.map((t) => `${TASK_TITLES[t]}: ${TASK_ROLES[t].join(" → ")}`).join("; ");
  console.log(
    [
      "",
      `Each task uses the first of its omp roles that is defined (${chains}).`,
      "Define them under modelRoles in omp's config.yml (`omp config path` prints its folder), e.g.",
      "  modelRoles:",
      "    latex: anthropic/claude-opus-4-5",
      "    proofread: openai/gpt-5-mini",
      "Proofread and rewrite pick a change up within 30 seconds; reopen the omp block for its model.",
    ].join("\n"),
  );
  const legacy = cfg ? legacyModelKeys(cfg.dir) : [];
  if (legacy.length) {
    console.log(`\n${CONFIG_FILE} still sets model in [${legacy.join("], [")}]; ternlatex no longer reads it (models are omp roles now), so remove those lines.`);
  }
  return 0;
}
