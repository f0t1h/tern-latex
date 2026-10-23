/**
 * ternlatex's omp extension. `ternlatex agent` starts omp with `-e <this folder>`, a `ternlatex` launcher first on
 * PATH; omp loads this module and the `skills/` beside it. In a ternlatex project (a folder with ternlatex.toml at
 * or above omp's working directory) it adds AGENTS.md to the system prompt and offers the edit → build → look →
 * show loop as tools. The tools run the ternlatex CLI, so this module imports nothing from ternlatex itself: a
 * compiled ternlatex extracts this folder into its cache and omp loads it from there.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The slice of omp's schema builder (omptype's Zod-compatible `pi.zod`) these tools use. */
export interface Schema {
  optional(): Schema;
  describe(text: string): Schema;
}
export interface SchemaBuilder {
  object(shape: Record<string, Schema>): Schema;
  string(): Schema;
  number(): Schema;
  boolean(): Schema;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  details?: Record<string, unknown>;
}

export interface SessionContext {
  cwd: string;
}

export interface ToolDefinition<P> {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  approval: "read" | "write" | "exec";
  /** "essential": a top-level tool; omp would otherwise mount a new name under xd:// (tools.xdev). */
  loadMode: "essential" | "discoverable";
  execute(toolCallId: string, params: P, signal: AbortSignal | undefined, onUpdate: unknown, ctx: SessionContext): Promise<ToolResult>;
}

export interface BeforeAgentStart {
  systemPrompt: string | string[];
}

/** omp's `tool_call` event: a tool about to run. */
export interface ToolCall {
  toolName: string;
}

/** The slice of omp's ExtensionAPI this extension uses. */
export interface ExtensionAPI {
  zod: SchemaBuilder;
  exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<ExecResult>;
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: SessionContext) => { systemPrompt: string | string[] } | undefined): void;
  on(event: "agent_start", handler: () => void): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: SessionContext) => Promise<{ block: true; reason: string } | undefined>): void;
  registerTool<P>(tool: ToolDefinition<P>): void;
}

/** omp's tools that change files; the first of them in a request waits for `ternlatex pull`. */
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

/** `ternlatex pull --json` (src/overleaf.ts PullResult). */
export interface Pulled {
  overleaf: boolean;
  pulled: number;
  files: string[];
  problem?: string;
}

/** Why omp's first edit of a request must wait, from `ternlatex pull --json`: null when it may go ahead. */
export function pullVerdict(stdout: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null; // Not run (no ternlatex on PATH); the edit itself is unaffected.
  }
  if (!data || typeof data !== "object" || !("overleaf" in data) || data.overleaf !== true) return null;
  const r: Pulled = {
    overleaf: true,
    pulled: "pulled" in data && typeof data.pulled === "number" ? data.pulled : 0,
    files: "files" in data && Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : [],
    problem: "problem" in data && typeof data.problem === "string" ? data.problem : undefined,
  };
  if (r.problem) {
    return `This project is a clone of an Overleaf project and Overleaf's latest version could not be pulled: ${r.problem}. Tell the user before editing, and edit only if they say so.`;
  }
  if (!r.pulled) return null;
  return `Pulled ${r.pulled} new commit(s) from Overleaf before this edit, changing ${r.files.join(", ")}. What you read of those files may be out of date: read the files again, then make the edit again.`;
}

export interface BuildParams {
  doc?: string;
  force?: boolean;
}
export interface SnapshotParams {
  page?: number;
  at?: string;
  doc?: string;
}
export interface ShowParams {
  at: string;
  doc?: string;
}

const CONTEXT = readFileSync(join(import.meta.dir, "AGENTS.md"), "utf8");

/** The ternlatex project holding `dir`: the nearest folder with a ternlatex.toml, else undefined. */
export function projectOf(dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, "ternlatex.toml"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

function text(t: string): ToolContent {
  return { type: "text", text: t };
}

export default function ternlatex(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.on("before_agent_start", (event, ctx) => {
    if (!projectOf(ctx.cwd)) return undefined;
    const base = event.systemPrompt;
    return { systemPrompt: Array.isArray(base) ? [...base, CONTEXT] : `${base}\n\n${CONTEXT}` };
  });

  // A clone of an Overleaf project is rebased onto Overleaf's latest before omp's first edit of each request
  // (co-authors keep editing in the browser). Edit calls that arrive while that pull runs wait for it, and are
  // refused when it brought changes, so omp re-reads before writing; later edits in the request go straight through.
  let pulling: Promise<string | null> | null = null;
  let pulled = false;
  pi.on("agent_start", () => {
    pulling = null;
    pulled = false;
  });
  pi.on("tool_call", async (event, ctx) => {
    const dir = projectOf(ctx.cwd);
    if (pulled || !dir || !Object.hasOwn(EDIT_TOOLS, event.toolName)) return undefined;
    pulling ??= pi.exec("ternlatex", ["pull", "--json"], { cwd: dir }).then(
      (r) => pullVerdict(r.stdout),
      () => null,
    );
    const reason = await pulling;
    pulled = true;
    return reason ? { block: true, reason } : undefined;
  });

  /** Runs `ternlatex ARGS` in the project of `ctx`; throws when there is none or ternlatex did not run. */
  async function run(ctx: SessionContext, args: string[], signal: AbortSignal | undefined): Promise<ExecResult & { dir: string }> {
    const dir = projectOf(ctx.cwd);
    if (!dir) throw new Error(`no ternlatex.toml at or above ${ctx.cwd}`);
    // `ternlatex agent` puts its launcher first on PATH; a session started otherwise needs one there.
    const r = await pi.exec("ternlatex", args, { cwd: dir, signal }).catch((e: unknown) => {
      throw new Error(`cannot run ternlatex (${e instanceof Error ? e.message : String(e)}); Tern palette: Add ternlatex to PATH`);
    });
    if (r.killed) throw new Error(`ternlatex ${args[0]} was cancelled`);
    return { ...r, dir };
  }

  pi.registerTool<BuildParams>({
    name: "latex_build",
    label: "Build LaTeX",
    description:
      "Build the project's documents (or one), through the running dev server when there is one, and return the diagnostics as `file:line: severity: message` lines. Run it after every edit; fix the errors you caused first.",
    parameters: z.object({
      doc: z.string().optional().describe("document name from ternlatex.toml; omit to build every document"),
      force: z.boolean().optional().describe("compile even when the sources match an earlier build"),
    }),
    approval: "write",
    loadMode: "essential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["build", ...(params.doc ? ["--doc", params.doc] : []), ...(params.force ? ["--force"] : [])];
      const r = await run(ctx, args, signal);
      if (r.code > 1) throw new Error((r.stderr || r.stdout).trim() || `ternlatex build exited ${r.code}`);
      const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
      return { content: [text(out || "built, no diagnostics")], details: { ok: r.code === 0 } };
    },
  });

  pi.registerTool<SnapshotParams>({
    name: "latex_snapshot",
    label: "Snapshot PDF page",
    description:
      "Render one page of the built PDF and return it as an image: by page number, or the page showing a source line (`at`: FILE:LINE). Use it to check how an edit looks.",
    parameters: z.object({
      page: z.number().optional().describe("1-based page number"),
      at: z.string().optional().describe("FILE:LINE in the project; renders the page that line lands on"),
      doc: z.string().optional().describe("document name from ternlatex.toml when the project has several"),
    }),
    approval: "write",
    loadMode: "essential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if ((params.page === undefined) === (params.at === undefined)) throw new Error("give exactly one of page or at");
      const args = ["snapshot", ...(params.at ? [params.at] : ["--page", String(params.page)]), ...(params.doc ? ["--doc", params.doc] : [])];
      const r = await run(ctx, args, signal);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `ternlatex snapshot exited ${r.code}`);
      const line = r.stdout.trim().split("\n").pop() ?? "";
      const png = isAbsolute(line) ? line : join(r.dir, line);
      const data = readFileSync(png).toString("base64");
      return { content: [text(png), { type: "image", data, mimeType: "image/png" }], details: { path: png } };
    },
  });

  pi.registerTool<ShowParams>({
    name: "latex_show",
    label: "Show in PDF",
    description: "Scroll the user's PDF viewer to a source line (FILE:LINE) and highlight it, switching document if needed. Needs `ternlatex dev` running.",
    parameters: z.object({
      at: z.string().describe("FILE:LINE in the project"),
      doc: z.string().optional().describe("document name from ternlatex.toml when the line is in several"),
    }),
    approval: "read",
    loadMode: "essential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const r = await run(ctx, ["show", params.at, ...(params.doc ? ["--doc", params.doc] : [])], signal);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `ternlatex show exited ${r.code}`);
      return { content: [text(r.stdout.trim() || `showing ${params.at}`)] };
    },
  });
}
