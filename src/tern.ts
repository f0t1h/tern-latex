import { resolveTool, ToolMissingError } from "./tools.ts";

/** True when running in a Tern block (with a usable tern CLI): the plugin then lays out this block's window. */
export async function inTern(): Promise<boolean> {
  if (!process.env.TERN_PANE || !process.env.TERN_PANE_SOCKET) return false;
  try {
    await resolveTool("tern");
    return true;
  } catch (e) {
    if (e instanceof ToolMissingError) return false;
    throw e;
  }
}

export interface TernResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the tern CLI; a non-zero exit is returned, not thrown (some answers are exit 1 by design). */
export async function ternCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<TernResult> {
  const [bin, ...pre] = (await resolveTool("tern")).command;
  const p = Bun.spawn([bin, ...pre, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 15_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** The message of a failed tern run: what it printed, else its exit code. */
export function ternError(args: string[], r: TernResult): Error {
  return new Error(`tern ${args.join(" ")}: ${(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).replace(/^tern [a-z]+: /, "")}`);
}
