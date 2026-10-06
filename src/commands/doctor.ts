import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAssets, listAssets } from "../assets.ts";
import { DEFAULT_BUNDLE, findProject, loadConfig } from "../config.ts";
import { inTern } from "../tern.ts";
import { ternPluginState } from "../ternplugin.ts";
import { cacheDir, MANAGED, type ResolvedTool, resolveTool, ToolMissingError, type ToolName, toolVersion } from "../tools.ts";
import { templates } from "./init.ts";

interface Check {
  name: ToolName;
  /** Required tools fail the doctor; optional ones only inform. */
  required: boolean;
  /** What ternlatex uses it for. */
  use: string;
}

const CHECKS: Check[] = [
  { name: "tectonic", required: true, use: "builds" },
  { name: "git", required: true, use: "checkpoints, history" },
  { name: "pandoc", required: false, use: "import" },
  { name: "latexdiff", required: false, use: "diff" },
  { name: "perl", required: false, use: "runs latexdiff" },
  { name: "chktex", required: false, use: "lint" },
  { name: "latexmk", required: false, use: 'engine = "latexmk"' },
  { name: "omp", required: false, use: "agent, proofread" },
  { name: "tern", required: false, use: "editor and viewer layout" },
];

/**
 * Reports every tool ternlatex runs and where it comes from; nothing is downloaded unless WARM, which
 * also fetches the pinned managed tools and compiles every template so their TeX packages are cached.
 */
export async function doctor(warm: boolean): Promise<number> {
  const project = findProject(process.cwd());
  const cfg = project ? loadConfig(project) : undefined;
  const missingRequired: string[] = [];
  let tectonic: ResolvedTool | undefined;
  console.log(`runtime: Bun ${Bun.version} (${process.platform}-${process.arch})`);
  for (const c of CHECKS) {
    try {
      const t = await resolveTool(c.name, cfg, { download: warm && MANAGED[c.name] !== undefined });
      if (c.name === "tectonic") tectonic = t;
      const version = t.version ?? toolVersion(t) ?? "version unknown";
      const where = c.name === "tern" && (await inTern()) ? ", inside a Tern block" : "";
      console.log(`✓ ${c.name}: ${version} (${t.source}${where})`);
      if (c.name === "tern") {
        const p = await ternPluginState().catch((e: Error) => ({ ok: false, detail: e.message }));
        console.log(`${p.ok ? "✓" : "-"} tern plugin: ${p.detail}`);
      }
    } catch (e) {
      if (c.required) missingRequired.push(c.name);
      const hint = e instanceof ToolMissingError ? e.hint : e instanceof Error ? e.message : String(e);
      console.log(`- ${c.name}: not found — ${hint} [${c.required ? "required" : `optional: ${c.use}`}]`);
    }
  }
  const viewer = listAssets("pdfjs/").length;
  console.log(`${viewer ? "✓" : "-"} viewer assets: ${viewer ? `${viewer} pdf.js files` : "missing — this ternlatex build lacks pdf.js"}`);
  if (!viewer) missingRequired.push("viewer assets");
  console.log(`  ternlatex cache: ${cacheDir()}`);
  console.log(`  TeX package cache (TECTONIC_CACHE_DIR): ${process.env.TECTONIC_CACHE_DIR ?? "tectonic's default"}`);
  if (missingRequired.length) {
    console.log(`\nmissing required: ${missingRequired.join(", ")}${warm ? "" : "; `ternlatex doctor --warm` downloads tectonic"}`);
    return 1;
  }
  if (!warm || !tectonic) return 0;
  // Compiling every template fetches the packages most documents need, so later builds work offline.
  const [bin, ...pre] = tectonic.command;
  let warmFailed = false;
  for (const t of templates()) {
    const dir = mkdtempSync(join(tmpdir(), `ternlatex-warm-${t}-`));
    try {
      await copyAssets("templates/_shared/", dir);
      await copyAssets(`templates/${t}/`, dir);
      mkdirSync(join(dir, "build"));
      process.stdout.write(`warming ${t}… `);
      const r = spawnSync(bin, [...pre, "-X", "compile", "--bundle", DEFAULT_BUNDLE, "--outdir", "build", "main.tex"], { cwd: dir, encoding: "utf8" });
      const ok = r.status === 0;
      console.log(ok ? "ok" : `failed\n${(r.error?.message ?? r.stderr).trim().split("\n").slice(-5).join("\n")}`);
      if (!ok) warmFailed = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return warmFailed ? 1 : 0;
}
