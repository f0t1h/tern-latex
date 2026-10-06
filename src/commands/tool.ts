import { spawn } from "node:child_process";
import { findProject, loadConfig, UsageError } from "../config.ts";
import { resolveTool, TOOL_NAMES } from "../tools.ts";

/**
 * `ternlatex tool NAME [ARGS...]` runs the resolved tool with inherited stdio and returns its exit code;
 * `ternlatex tool --path NAME` prints the resolved command instead.
 */
export async function tool(args: string[]): Promise<number> {
  const print = args[0] === "--path";
  const name = TOOL_NAMES.find((n) => n === args[print ? 1 : 0]);
  const rest = args.slice(print ? 2 : 1);
  if (!name) throw new UsageError(`tool needs a tool name: ${TOOL_NAMES.join(", ")}`);
  const project = findProject(process.cwd());
  const t = await resolveTool(name, project ? loadConfig(project) : undefined);
  if (print) {
    console.log(t.command.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return 0;
  }
  const child = spawn(t.command[0], [...t.command.slice(1), ...rest], { stdio: "inherit" });
  const { promise, resolve } = Promise.withResolvers<number>();
  child.on("error", (e) => {
    console.error(`ternlatex: cannot run ${t.command[0]}: ${e.message}`);
    resolve(127);
  });
  child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  return promise;
}
