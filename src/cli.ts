#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runAgent } from "./commands/agent.ts";
import { build } from "./commands/build.ts";
import { bundle } from "./commands/bundle.ts";
import { restartServer, stopServer } from "./commands/control.ts";
import { dev } from "./commands/dev.ts";
import { doctor } from "./commands/doctor.ts";
import { docs } from "./commands/docs.ts";
import { fix } from "./commands/fix.ts";
import { history } from "./commands/history.ts";
import { importProject } from "./commands/import.ts";
import { init } from "./commands/init.ts";
import { installCli } from "./commands/install-cli.ts";
import { models } from "./commands/models.ts";
import { outlineCommand } from "./commands/outline.ts";
import { peek } from "./commands/peek.ts";
import { pull } from "./commands/pull.ts";
import { push } from "./commands/push.ts";
import { refs } from "./commands/refs.ts";
import { rewriteCommand } from "./commands/rewrite.ts";
import { proofreadCommand } from "./commands/proofread.ts";
import { lint } from "./commands/lint.ts";
import { review } from "./commands/review.ts";
import { setupTern, ternConfig } from "./commands/setup-tern.ts";
import { show } from "./commands/show.ts";
import { table } from "./commands/table.ts";
import { searchCommand } from "./commands/search.ts";
import { snapshot } from "./commands/snapshot.ts";
import { tool } from "./commands/tool.ts";
import { uninstall } from "./commands/uninstall.ts";
import { UsageError } from "./config.ts";
import { initToolEnv, ToolMissingError } from "./tools.ts";

initToolEnv();

const HELP = `ternlatex — live LaTeX → PDF in Tern, with omp as the writing assistant

usage: ternlatex <command> [options]

project setup
  init [DIR] [--template article|report|letter|beamer] [--force]
                          new project from a template (default: article in the current directory)
  import SRC [DIR]        adopt an existing .tex project in place (SRC = root .tex or its directory),
                          or convert .docx/.odt/.md/.html/.rtf/.epub with pandoc into DIR
  setup-tern              link (or update) the ternlatex Tern plugin and reload Tern's plugins;
                          dev inside Tern does this by itself. A plugin installed from Tern's Plugins
                          page is kept and pointed at this ternlatex
  tern-config [--json]    how the Tern plugin runs this ternlatex: {bin, ipc, version}
  install-cli [DIR]       put a ternlatex command for this ternlatex into DIR (default: Bun's global bin
                          folder, \`bun pm bin -g\`); says how to add DIR to PATH when it is not on it
  uninstall [--keep-cache] [--yes]
                          remove ternlatex: the Tern plugin and its data folder, install-cli's launchers,
                          a global Bun install, the cache (unless --keep-cache) and the data folder; lists
                          them and asks first (--yes: don't ask). Projects are left as they are

writing
  dev [DIR] [--port N] [--no-tern] [--open]
                          watch, rebuild on save, serve the live viewer; inside Tern the ternlatex
                          plugin lays out editor | viewer and an omp block; Ctrl-C stops it
  stop [DIR]              stop the project's running dev server (its blocks stay open)
  restart [DIR]           restart it in its own block as a fresh process, on the same port, picking up a
                          rebuilt ternlatex and ternlatex.toml changes
  docs                    list the project's documents and their last build
  models                  which model each task uses: omp roles latex (the omp block), proofread, rewrite
  pull [--json]           in a clone of an Overleaf project: rebase onto Overleaf's latest (omp's extension
                          runs it before omp's first edit of each request; \`dev\` every minute when safe)
  push [-m MESSAGE] [--json]
                          in a clone of an Overleaf project: commit your edits (and new files the build
                          reads), rebase onto Overleaf's latest and push; refused while omp, the
                          proofreader or dictation have marks in the sources, or a document fails to build
  build [DIR] [--doc NAME] [--all] [--force]
                          build every document (or one), through the running dev server if any;
                          prints diagnostics, exits 1 on errors; --all includes info-level messages.
                          Sources identical to one of the last 8 builds reuse its PDF; --force compiles
  snapshot (--page N | FILE:LINE) [--doc NAME] [--dpi 110] [--out PNG]
                          render one PDF page to PNG and print its path
  show FILE:LINE [--doc NAME]
                          scroll the live viewer to the PDF spot of a source line and highlight it
  table FILE:LINE         open the viewer's table editor on the table (tabular, tabularx, longtable) at a line
  outline [--doc NAME] [--json]
                          sections, figures, tables and labelled equations in reading order, numbered from
                          the last build, then problems: undefined refs, unused/duplicate labels, missing citations
  peek FILE:LINE [--doc NAME] [--width PX] [--json]
                          render the part of the last PDF around a source line (text-block wide) to
                          <outdir>/peek/<doc>.png and print its path
  search QUERY... [--doc NAME] [--json]
                          fuzzy search of the PDF text and the LaTeX prose (no preamble, comments, math,
                          packages or files): each place with its page and source line; exits 1 if none
  fix [--doc NAME]        send the last build's errors and warnings to omp (needs a running dev)
  proofread [FILE[:FROM-TO]...] [--doc NAME] [--direct]
                          proofread prose paragraphs with omp (no tools, thinking off, omp's proofread role);
                          suggestions land as \\replaced[id=proof]{…}{…} tracked changes to accept
  rewrite FILE:LINE:COL [--to LINE:COL] [--count N] [--instruction TEXT] [--json]
                          alternatives for the sentence at LINE:COL (or the range up to --to) from omp
                          (omp's rewrite role); prints them, never writes files
  lint [FILE...]          chktex diagnostics (default: every .tex file in the project)
  agent [DIR] [--path P]  start omp in the project with ternlatex's omp extension (project rules, skills,
                          latex_build/latex_snapshot/latex_show tools), continuing its latest omp session
                          (P: PATH for omp; a ternlatex launcher is put first)
  bundle FILE...          is a class/package/.bst in the pinned TeX Live bundle? prints its version
  tool NAME [ARGS...] | tool --path NAME
                          run (or print) the tectonic/pandoc/latexdiff/perl/git/chktex/latexmk/omp/tern
                          ternlatex uses (found via TERNLATEX_<NAME>, [tools], PATH, or downloaded)

history (every save is checkpointed on refs/ternlatex/checkpoints; HEAD and your index are untouched)
  checkpoints [--limit N] list automatic save checkpoints (newest first)
  restore REV [PATH...]   restore the working tree (or PATHs) from a checkpoint or git revision;
                          the current state is checkpointed first
  diff [REV] [--doc NAME] [--open]
                          redline PDF of REV (default HEAD) against the working tree

references
  refs sync | search QUERY... [--limit N] | add KEY... | find [QUERY...] [--limit N] [--json]
                          import cited keys from Zotero into the [zotero] bib (also automatic on save);
                          search prints key, year, creators, title; find searches the project's .bib first,
                          then Zotero, and names the cite command the project uses

review (changes package: \\added[id=AK]{…}, \\deleted, \\replaced, \\comment; authors in [review])
  changes [--author ID] [--json]
                          open tracked changes and comments: id kind author file:line text;
                          --json prints {authors, items} as the viewer's Review panel gets them
  accept|reject (ID...|--author ID|--all)
                          accept or reject tracked changes; comments are removed either way
  comments import FILE.pdf --author ID [--doc NAME]
                          turn PDF annotations into \\comment[id=ID]{…} on their source lines, then build

  doctor [--warm]         check the toolchain; --warm downloads the pinned tectonic, pandoc and latexdiff
                          and pre-fetches the TeX packages the templates use

Run from anywhere inside a project (a directory with ternlatex.toml) or pass its DIR.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "init": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { template: { type: "string", short: "t", default: "article" }, force: { type: "boolean", default: false } } });
      return init(positionals[0] ?? ".", values.template, values.force);
    }
    case "import": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      if (!positionals[0]) throw new UsageError("import needs a source: a .tex file, a project directory, or a document pandoc can read");
      return importProject(positionals[0], positionals[1]);
    }
    case "setup-tern": {
      parseArgs({ args: rest, allowPositionals: false, options: {} });
      return setupTern();
    }
    case "tern-config": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { json: { type: "boolean", default: false } } });
      return ternConfig(values.json);
    }
    case "install-cli": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return installCli(positionals[0]);
    }
    case "uninstall": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { "keep-cache": { type: "boolean", default: false }, yes: { type: "boolean", short: "y", default: false } } });
      return uninstall({ keepCache: values["keep-cache"], yes: values.yes });
    }
    case "dev": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { port: { type: "string" }, "no-tern": { type: "boolean", default: false }, open: { type: "boolean", default: false } } });
      return dev(positionals[0] ?? ".", { port: values.port ? Number(values.port) : undefined, tern: !values["no-tern"], open: values.open });
    }
    case "stop":
    case "restart": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return (cmd === "stop" ? stopServer : restartServer)(positionals[0] ?? ".");
    }
    case "docs": {
      parseArgs({ args: rest, allowPositionals: false, options: {} });
      return docs();
    }
    case "models": {
      parseArgs({ args: rest, allowPositionals: false, options: {} });
      return models();
    }
    case "pull": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { json: { type: "boolean", default: false } } });
      return pull(values.json);
    }
    case "push": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { message: { type: "string", short: "m" }, json: { type: "boolean", default: false } } });
      return push(values.message, values.json);
    }
    case "build": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: "boolean", default: false }, doc: { type: "string" }, force: { type: "boolean", default: false } } });
      return build(positionals[0] ?? ".", values.all, values.doc, values.force);
    }
    case "snapshot": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { page: { type: "string" }, doc: { type: "string" }, dpi: { type: "string", default: "110" }, out: { type: "string" } } });
      return snapshot({ page: values.page ? Number(values.page) : undefined, at: positionals[0], doc: values.doc, dpi: Number(values.dpi), out: values.out });
    }
    case "show": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { doc: { type: "string" } } });
      if (!positionals[0]) throw new UsageError("show needs FILE:LINE");
      return show(positionals[0], values.doc);
    }
    case "table": {
      if (!rest[0]) throw new UsageError("table needs FILE:LINE");
      return table(rest[0]);
    }
    case "outline":
      return outlineCommand(rest);
    case "peek":
      return peek(rest);
    case "search":
      return searchCommand(rest);
    case "rewrite":
      return rewriteCommand(rest);
    case "fix": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { doc: { type: "string" } } });
      return fix(values.doc);
    }
    case "proofread":
      return proofreadCommand(rest);
    case "lint": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return lint(positionals);
    }
    case "agent": {
      // Tern appends `--restore <session.jsonl>` when it brings an omp block back after a restart.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { path: { type: "string" }, restore: { type: "string" } } });
      return runAgent(positionals[0] ?? ".", { path: values.path, restore: values.restore });
    }
    case "tool":
      return tool(rest);
    case "bundle": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return bundle(positionals);
    }
    case "checkpoints":
    case "restore":
    case "diff":
      return history(cmd, rest);
    case "refs":
      return refs(rest[0] ?? "", rest.slice(1));
    case "changes":
    case "accept":
    case "reject":
    case "comments":
      return review(cmd, rest);
    case "doctor": {
      const { values } = parseArgs({ args: rest, allowPositionals: false, options: { warm: { type: "boolean", default: false } } });
      return doctor(values.warm);
    }
    default:
      throw new UsageError(`unknown command "${cmd}"; see \`ternlatex --help\``);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    // Expected failures the message fully explains: no stack trace.
    const usage = e instanceof UsageError || e instanceof ToolMissingError || (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"));
    console.error(`ternlatex: ${e instanceof Error ? e.message : String(e)}`);
    if (!usage && e instanceof Error && e.stack) console.error(e.stack.split("\n").slice(1).join("\n"));
    process.exit(2);
  },
);
