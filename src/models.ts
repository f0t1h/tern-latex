import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Config } from "./config.ts";
import { resolveTool } from "./tools.ts";

/**
 * Which model does what. ternlatex has no model settings of its own: each task uses an omp role (`modelRoles` in omp's
 * config), so people pick models where they already set up their providers, and a project shared through git names
 * no provider. A role the user hasn't defined falls back to the next one in its chain.
 */

/** What ternlatex asks a model for: the omp block (the writing assistant), proofreading, rewrite alternatives. */
export type Task = "assistant" | "proofread" | "rewrite";
export const TASKS: Task[] = ["assistant", "proofread", "rewrite"];

/**
 * The omp roles each task uses, most specific first; the first one defined in omp wins. Without a `latex` role the omp
 * block runs omp's default model. Proofread and rewrite end at `smol`, which omp resolves even when unset.
 */
export const TASK_ROLES: Record<Task, string[]> = {
  assistant: ["latex"],
  proofread: ["proofread", "smol"],
  rewrite: ["rewrite", "proofread", "smol"],
};

/** What each task is, for `ternlatex models`. */
export const TASK_TITLES: Record<Task, string> = {
  assistant: "omp block",
  proofread: "proofread",
  rewrite: "rewrite",
};

/** The role TASK uses, given the roles defined in omp; null for the omp block without a `latex` role (omp's default). */
export function roleFor(task: Task, roles: Record<string, string>): string | null {
  const chain = TASK_ROLES[task];
  return chain.find((r) => Object.hasOwn(roles, r)) ?? (task === "assistant" ? null : chain[chain.length - 1]);
}

/** omp's role → selector map from `omp config get modelRoles --json`, `{key, value}`; empty for anything else. */
export function parseRoles(json: string): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return {};
  }
  const value = data && typeof data === "object" && "value" in data ? data.value : null;
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** A change to omp's roles applies within this long; asking omp takes ~0.3 s, too slow for every rewrite. */
const ROLES_TTL_MS = 30_000;
const rolesCache = new Map<string, { at: number; roles: Promise<Record<string, string>> }>();

/**
 * The roles defined in omp, as omp run from CWD sees them (a project's `.omp/config.yml` may add some); empty when omp
 * can't say, so every task falls back to its last role. CFG, when in a project, may name the omp to run ([tools]).
 */
export function ompRoles(cwd: string, cfg?: Config): Promise<Record<string, string>> {
  const hit = rolesCache.get(cwd);
  if (hit && Date.now() - hit.at < ROLES_TTL_MS) return hit.roles;
  const roles = (async () => {
    const [omp, ...pre] = (await resolveTool("omp", cfg)).command;
    const { promise, resolve } = Promise.withResolvers<Record<string, string>>();
    const child = spawn(omp, [...pre, "config", "get", "modelRoles", "--json"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b));
    child.on("error", () => resolve({}));
    child.on("close", (code) => resolve(code === 0 ? parseRoles(out) : {}));
    return promise;
  })().catch(() => ({}));
  rolesCache.set(cwd, { at: Date.now(), roles });
  return roles;
}

/** A model to ask: its omp selector (`--model`) and one print-mode call. */
export interface Model {
  name: string;
  ask(systemPrompt: string, input: string): Promise<string>;
}

/** The model for proofreading or rewriting: its omp role, asked the way askOmp runs omp (from outside the project). */
export async function taskModel(cfg: Config, task: "proofread" | "rewrite"): Promise<Model> {
  const name = `@${roleFor(task, await ompRoles(tmpdir(), cfg))}`;
  return { name, ask: (systemPrompt, input) => askOmp(cfg, name, systemPrompt, input) };
}

/** `--model` for the omp block in project DIR: `@latex` when that role is defined, else none (omp's default). */
export async function assistantModel(dir: string, cfg?: Config): Promise<string | null> {
  const role = roleFor("assistant", await ompRoles(dir, cfg));
  return role ? `@${role}` : null;
}

/**
 * One print-mode omp call: no tools, no session, thinking off, outside the project so no project context
 * loads. INPUT goes in on stdin; resolves with omp's reply text.
 */
export async function askOmp(cfg: Config, model: string, systemPrompt: string, input: string): Promise<string> {
  const [omp, ...pre] = (await resolveTool("omp", cfg)).command;
  const args = [...pre, "-p", "--no-tools", "--no-session", "--thinking", "off", "--model", model, "--system-prompt", systemPrompt];
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // The input goes in on stdin: argv is visible to other users (`ps`) and capped at 32K chars on Windows.
  const child = spawn(omp, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // An omp that fails or exits early reports through `error`/`close`.
  child.stdin.end(input);
  let out = "";
  let err = "";
  child.stdout.on("data", (b: Buffer) => (out += b));
  child.stderr.on("data", (b: Buffer) => (err += b));
  const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
  child.on("error", (e) => reject(new Error(`cannot start ${omp}: ${e.message} (set TERNLATEX_OMP to the omp executable)`)));
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(out);
    else reject(new Error(`omp exited with ${code}: ${(err || out).trim().split("\n").slice(-3).join(" ")}`));
  });
  return promise;
}
