import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Status } from "./builder.ts";
import { escapeLatex, PROOF_AUTHOR, texFiles } from "./changes.ts";
import { type Config, docPaths, paths, posix, UsageError } from "./config.ts";
import { addPending } from "./suggestions.ts";
import { resolveTool } from "./tools.ts";
import { checkpoint } from "./vcs.ts";

/**
 * Proofreading without reasoning: every prose paragraph goes to omp in print mode with tools and thinking
 * off; the model only proposes `{find, replace, why}` edits. Everything else is deterministic here:
 * splitting, refusing edits that touch commands, math, keys or comments, word-level diffing, and writing
 * the result as `\replaced[id=proof]{…}{…}` tracked changes the user accepts or rejects.
 */

const SYSTEM_PROMPT = `You proofread one paragraph of LaTeX source.
Fix only clear errors: spelling, grammar, agreement, punctuation, doubled or missing words, a/an.
Keep the author's wording, tone and spelling variety (British or American). Do not rephrase for style.
Never change LaTeX command names, math, citation keys, labels, references, URLs, numbers, dates, people's or organisations' names, or comments.
Text inside commands such as \\section{...}, \\item, \\caption{...} or \\cventry{...}{...} is prose: correct it like any other text.
Reply with ONLY a JSON array, no prose: [{"find": "<exact substring of the paragraph>", "replace": "<corrected text>", "why": "<2-5 words>"}].
"find" must be copied exactly from the paragraph and be as short as possible. Reply [] when there is nothing to fix.`;

/** Environments whose content is not prose. */
const SKIP_ENV = /\\begin\{(equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|array|verbatim|Verbatim|lstlisting|minted|tabular|tabularx|tabular\*|longtable|tikzpicture|forest)\*?\}/;

/**
 * Commands whose arguments are keys, paths, code, units or definitions: protected as a whole. Every other
 * command's arguments count as prose (e.g. \section, \caption, moderncv's \cventry/\cvitem, the user's own
 * macros), so text inside them is proofread.
 */
export const NON_PROSE = new Set([
  "cite", "citet", "citep", "citealt", "citealp", "citeauthor", "citeyear", "nocite", "parencite", "textcite", "autocite", "footcite",
  "ref", "cref", "Cref", "autoref", "eqref", "pageref", "nameref", "vref", "label",
  "input", "include", "includeonly", "includegraphics", "includepdf", "subfile", "bibliography", "bibliographystyle", "addbibresource",
  "url", "path", "nolinkurl", "verb", "lstinline", "mintinline", "texttt", "code",
  "begin", "end", "documentclass", "usepackage", "RequirePackage", "PassOptionsToPackage",
  "newcommand", "renewcommand", "providecommand", "def", "edef", "gdef", "let", "newenvironment", "renewenvironment", "DeclareMathOperator",
  "setlength", "addtolength", "setcounter", "addtocounter", "hspace", "vspace", "rule", "raisebox", "resizebox", "scalebox",
  "color", "colorbox", "fcolorbox", "definecolor", "colorlet", "pagecolor",
  "SI", "si", "num", "qty", "unit", "ang", "numrange", "SIrange",
  "email", "homepage", "social", "phone", "photo", "name", "author", "address", "date",
  "definechangesauthor", "added", "deleted", "replaced", "comment", "highlight",
]);
/** Commands whose first argument is a key or target and whose later arguments are prose. */
const FIRST_ARG_ONLY = new Set(["href", "textcolor", "hyperref", "hyperlink", "hypertarget"]);

/** Characters a correction may not introduce: they would change LaTeX structure, not prose. */
const STRUCTURAL = /[\\{}$%&#^_~]/;
/** Text that looks like data, not prose: numbers, e-mail addresses, URLs, paths, file names. */
const IDENTIFIER = /\d|@|:\/\/|\/|\b\w+\.\w{2,}\b/;

export interface Paragraph {
  /** Project-relative file. */
  file: string;
  /** Offsets into the file's text. */
  start: number;
  end: number;
  text: string;
  /** 1-based line of `start`. */
  line: number;
}

export interface Suggestion {
  find: string;
  replace: string;
  why: string;
}

/** A minimal edit at absolute file offsets. */
export interface Hunk {
  file: string;
  start: number;
  end: number;
  old: string;
  new: string;
  why: string;
  line: number;
}

export interface Target {
  /** Project-relative file. */
  file: string;
  /** Inclusive 1-based line range; whole file when absent. */
  from?: number;
  to?: number;
}

export interface ProofreadResult {
  paragraphs: number;
  hunks: Hunk[];
  /** Reason → count of model suggestions that were refused. */
  skipped: Record<string, number>;
  /** Set when the edits broke the build and were reverted. */
  reverted?: string;
  /**
   * True when the documents don't load the `changes` package: suggestions were stored for the Review panel
   * (src/suggestions.ts) and the sources were not touched.
   */
  pending?: boolean;
}

export interface ProofreadOptions {
  /** Write corrections directly instead of as tracked changes. */
  direct: boolean;
  /** Builds the project after writing; the edits are reverted if a document stops building. */
  build: () => Promise<Status[]>;
  /** Progress callback (paragraphs done, total). */
  progress?: (done: number, total: number) => void;
}

/** Prose paragraphs of a file: blank lines, display math, non-prose environments and the preamble separate them. */
export function paragraphs(text: string, file: string): Paragraph[] {
  const out: Paragraph[] = [];
  const begin = text.indexOf("\\begin{document}");
  const bodyStart = begin >= 0 ? text.indexOf("\n", begin) + 1 : 0;
  const endDoc = text.indexOf("\\end{document}");
  const bodyEnd = endDoc >= 0 ? endDoc : text.length;
  let skipUntil: RegExp | null = null;
  let cur: { start: number; end: number; line: number } | null = null;
  const flush = () => {
    if (cur && /[A-Za-z\u00C0-\uFFFF]{2}/.test(text.slice(cur.start, cur.end))) out.push({ file, ...cur, text: text.slice(cur.start, cur.end) });
    cur = null;
  };
  let offset = 0;
  let lineNo = 1;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const n = lineNo++;
    if (end <= bodyStart || start >= bodyEnd) continue;
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = null;
      flush();
      continue;
    }
    const env = SKIP_ENV.exec(line);
    if (env) {
      flush();
      if (!new RegExp(`\\\\end\\{${env[1].replace("*", "\\*")}\\*?\\}`).test(line.slice(env.index))) skipUntil = new RegExp(`\\\\end\\{${env[1].replace("*", "\\*")}\\*?\\}`);
      continue;
    }
    if (/^\s*\\\[/.test(line)) {
      flush();
      if (!/\\\]/.test(line)) skipUntil = /\\\]/;
      continue;
    }
    if (line.trim() === "" || /^\s*%/.test(line)) {
      flush();
      continue;
    }
    if (cur) cur.end = end;
    else cur = { start, end, line: n };
  }
  flush();
  return out;
}

/** Spans of a paragraph the model must not touch: comments, math, command names and non-prose arguments. */
export function protectedSpans(t: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  const group = (open: string, close: string): number => {
    // Index just past the balanced group starting at i (t[i] === open), escape-aware.
    let depth = 0;
    for (let k = i; k < t.length; k++) {
      if (t[k] === "\\") {
        k++;
        continue;
      }
      if (t[k] === open) depth++;
      else if (t[k] === close && --depth === 0) return k + 1;
    }
    return t.length;
  };
  while (i < t.length) {
    const c = t[i];
    if (c === "%") {
      const eol = t.indexOf("\n", i);
      spans.push([i, eol < 0 ? t.length : eol]);
      i = eol < 0 ? t.length : eol;
    } else if (c === "$") {
      const dbl = t[i + 1] === "$";
      const close = t.indexOf(dbl ? "$$" : "$", i + (dbl ? 2 : 1));
      const end = close < 0 ? t.length : close + (dbl ? 2 : 1);
      spans.push([i, end]);
      i = end;
    } else if (c === "\\") {
      const m = /^\\([A-Za-z@]+\*?|.)/.exec(t.slice(i));
      const name = m ? m[1] : "";
      if (name === "(" || name === "[") {
        const close = t.indexOf(name === "(" ? "\\)" : "\\]", i + 2);
        const end = close < 0 ? t.length : close + 2;
        spans.push([i, end]);
        i = end;
        continue;
      }
      let end = i + 1 + name.length;
      spans.push([i, end]);
      i = end;
      const bare = name.replace(/\*$/, "");
      if (!/^[A-Za-z@]/.test(name) || !(NON_PROSE.has(bare) || FIRST_ARG_ONLY.has(bare))) continue;
      // Arguments directly following a non-prose command are protected; for FIRST_ARG_ONLY, only up to the first {…}.
      while (t[i] === "{" || t[i] === "[") {
        const brace = t[i] === "{";
        end = brace ? group("{", "}") : group("[", "]");
        spans.push([i, end]);
        i = end;
        if (brace && FIRST_ARG_ONLY.has(bare)) break;
      }
    } else i++;
  }
  return spans;
}

const TOKEN = /\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu;

/** Word-level hunks turning `a` into `b` (offsets relative to `a`). */
export function wordDiff(a: string, b: string): { start: number; end: number; old: string; new: string }[] {
  const ta = [...a.matchAll(TOKEN)].map((m) => ({ s: m[0], at: m.index }));
  const tb = [...b.matchAll(TOKEN)].map((m) => m[0]);
  const n = ta.length;
  const m = tb.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = ta[i].s === tb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const hunks: { start: number; end: number; old: string; new: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ta[i].s === tb[j]) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    while ((i < n || j < m) && !(i < n && j < m && ta[i].s === tb[j])) {
      if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
      else i++;
    }
    const start = si < n ? ta[si].at : a.length;
    const end = i < n ? ta[i].at : a.length;
    const oldText = a.slice(start, end);
    const newText = tb.slice(sj, j).join("");
    if (oldText.trim() === newText.trim()) continue; // whitespace-only difference
    hunks.push({ start, end, old: oldText, new: newText });
  }
  return hunks;
}

/** Validated hunks for one suggestion on a paragraph, or the reason it is refused. */
export function hunksFor(p: Paragraph, s: Suggestion, spans: [number, number][]): Hunk[] | string {
  if (!s.find || s.find === s.replace) return "no-op";
  const at = p.text.indexOf(s.find);
  if (at < 0) return "find not in paragraph";
  if (p.text.indexOf(s.find, at + 1) >= 0) return "find ambiguous";
  const hunks: Hunk[] = [];
  for (const h of wordDiff(s.find, s.replace)) {
    const start = at + h.start;
    const end = at + h.end;
    // An insertion point counts as touching a span it falls strictly inside.
    const touches = spans.some(([a, b]) => (start === end ? start > a && start < b : start < b && end > a));
    if (touches) return "touches LaTeX markup";
    if (STRUCTURAL.test(h.new) || STRUCTURAL.test(h.old)) return "structural characters";
    if (IDENTIFIER.test(h.old) || IDENTIFIER.test(h.new)) return "numbers, addresses or paths";
    const line = p.line + p.text.slice(0, start).split("\n").length - 1;
    hunks.push({ file: p.file, start: p.start + start, end: p.start + end, old: h.old, new: h.new, why: s.why, line });
  }
  return hunks.length ? hunks : "no-op";
}

/** The file text with hunks applied, as AUTHOR's tracked changes or directly. Hunks must not overlap. */
export function applyHunks(text: string, hunks: Hunk[], direct: boolean, author: string): string {
  let out = text;
  for (const h of [...hunks].sort((a, b) => b.start - a.start)) {
    const opts = `id=${author}${h.why ? `,comment={${escapeLatex(h.why)}}` : ""}`;
    const markup = direct
      ? h.new
      : h.old && h.new
        ? `\\replaced[${opts}]{${h.new}}{${h.old}}`
        : h.new
          ? `\\added[${opts}]{${h.new}}`
          : `\\deleted[${opts}]{${h.old}}`;
    out = out.slice(0, h.start) + markup + out.slice(h.end);
  }
  return out;
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

/** The JSON array in a model reply: the whole reply, else a fenced block, else the outermost `[…]`; null when none parses. */
export function replyArray(reply: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)?.[1];
  const outer = reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1);
  for (const candidate of [reply.trim(), fenced?.trim(), outer]) {
    if (!candidate) continue;
    try {
      const v: unknown = JSON.parse(candidate);
      if (Array.isArray(v)) return v;
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

/** A model reply that holds no readable suggestion list, after one retry. */
export class UnreadableReply extends Error {}

/** Proofreading suggestions for one paragraph. A reply without a readable list is asked once more. */
export async function askModel(cfg: Config, paragraph: string): Promise<Suggestion[]> {
  let parsed = replyArray(await askOmp(cfg, cfg.proofread.model, SYSTEM_PROMPT, paragraph));
  // Small models now and then answer with prose or broken JSON; a second ask usually comes back clean.
  parsed ??= replyArray(await askOmp(cfg, cfg.proofread.model, SYSTEM_PROMPT, paragraph));
  if (parsed === null) throw new UnreadableReply("the model's reply had no readable suggestion list");
  return parsed.flatMap((x: unknown) =>
    x && typeof x === "object" && "find" in x && "replace" in x && typeof x.find === "string" && typeof x.replace === "string"
      ? [{ find: x.find, replace: x.replace, why: "why" in x && typeof x.why === "string" ? x.why.slice(0, 80) : "" }]
      : [],
  );
}

/** Proofreads the targets (default: every project .tex file) and writes the result; see the module comment. */
export async function proofread(cfg: Config, targets: Target[], o: ProofreadOptions): Promise<ProofreadResult> {
  const chosen: Target[] = targets.length ? targets : texFiles(cfg).map((file) => ({ file }));
  const pending = !o.direct && !changesLoaded(cfg, chosen.map((t) => t.file));
  const snapshots = new Map<string, string>();
  const work: Paragraph[] = [];
  for (const t of chosen) {
    const abs = join(cfg.dir, t.file);
    if (!existsSync(abs)) throw new UsageError(`${t.file} does not exist`);
    const text = snapshots.get(t.file) ?? readFileSync(abs, "utf8");
    snapshots.set(t.file, text);
    for (const p of paragraphs(text, t.file)) {
      const last = p.line + p.text.split("\n").length - 1;
      if (t.from !== undefined && (last < t.from || p.line > (t.to ?? t.from))) continue;
      work.push(p);
    }
  }

  const skipped: Record<string, number> = {};
  const hunks: Hunk[] = [];
  let done = 0;
  let next = 0;
  // A paragraph whose model call fails is skipped and counted; only when every one fails is that an error.
  let failed = 0;
  let firstFailure: Error | undefined;
  const worker = async () => {
    while (next < work.length) {
      const p = work[next++];
      try {
        const spans = protectedSpans(p.text);
        for (const s of await askModel(cfg, p.text)) {
          const r = hunksFor(p, s, spans);
          if (typeof r === "string") skipped[r] = (skipped[r] ?? 0) + 1;
          else hunks.push(...r);
        }
      } catch (e) {
        const why = e instanceof UnreadableReply ? "unreadable model reply" : "model call failed";
        skipped[why] = (skipped[why] ?? 0) + 1;
        failed++;
        firstFailure ??= e instanceof Error ? e : new Error(String(e));
      }
      o.progress?.(++done, work.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.proofread.parallel, work.length) }, worker));
  if (firstFailure && failed === work.length) throw firstFailure;
  if (!hunks.length) return { paragraphs: work.length, hunks, skipped, pending };
  const written = await writeSuggestions(cfg, hunks, snapshots, { author: PROOF_AUTHOR, direct: o.direct, build: o.build, label: "proofread" });
  for (const [why, n] of Object.entries(written.skipped)) skipped[why] = (skipped[why] ?? 0) + n;
  return { paragraphs: work.length, hunks: written.hunks, skipped, reverted: written.reverted, pending: written.pending };
}

export interface WriteOptions {
  /** Review author id the suggestions are marked or stored with. */
  author: string;
  /** Write the edits directly instead of as suggestions. */
  direct: boolean;
  /** Builds the project after writing; the edits are reverted if a document stops building. */
  build: () => Promise<Status[]>;
  /** What wrote them, for the checkpoint taken first ("proofread", "dictation"). */
  label: string;
}

export interface WriteResult {
  /** The hunks applied (or stored, when pending). */
  hunks: Hunk[];
  skipped: Record<string, number>;
  /** Set when the edits broke the build and were reverted. */
  reverted?: string;
  /** Stored for the Review panel (src/suggestions.ts) because a document reading the files doesn't load `changes`. */
  pending?: boolean;
}

/**
 * Writes hunks (offsets into `snapshots`, the file contents they were computed on) as review suggestions: tracked
 * markup in the sources when every document reading them loads `changes` (checkpoint first, reverted if a
 * document stops building), else pending suggestions. A paragraph break can't go inside `changes` markup (its
 * commands aren't \long), so hunks carrying one are pending too. Files the user edited meanwhile are left alone
 * rather than merged blindly.
 */
export async function writeSuggestions(cfg: Config, hunks: Hunk[], snapshots: Map<string, string>, o: WriteOptions): Promise<WriteResult> {
  const skipped: Record<string, number> = {};
  const paragraphBreak = hunks.some((h) => /\n[ \t]*\n/.test(h.new) || /\n[ \t]*\n/.test(h.old));
  if (!o.direct && (paragraphBreak || !changesLoaded(cfg, [...new Set(hunks.map((h) => h.file))]))) {
    await addPending(cfg, hunks, snapshots, o.author);
    return { hunks, skipped, pending: true };
  }
  await checkpoint(cfg, `before ${o.label}`);
  // Documents already failing are not blamed on the edits.
  const before = brokenDocs(cfg);
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  const written = new Map<string, string>();
  const applied: Hunk[] = [];
  for (const [file, list] of byFile) {
    const abs = join(cfg.dir, file);
    const current = readFileSync(abs, "utf8");
    if (current !== snapshots.get(file)) {
      skipped["file changed meanwhile"] = (skipped["file changed meanwhile"] ?? 0) + list.length;
      continue;
    }
    const kept: Hunk[] = [];
    for (const h of list.sort((a, b) => a.start - b.start)) {
      if (kept.length && h.start < kept[kept.length - 1].end) skipped["overlapping"] = (skipped["overlapping"] ?? 0) + 1;
      else kept.push(h);
    }
    written.set(file, current);
    await writeAtomic(abs, applyHunks(current, kept, o.direct, o.author));
    applied.push(...kept);
  }
  if (!applied.length) return { hunks: applied, skipped };

  const after = await o.build();
  const newlyBroken = after.filter((s) => s.ok === false && !before.has(s.doc));
  if (newlyBroken.length) {
    for (const [file, text] of written) await writeAtomic(join(cfg.dir, file), text);
    await o.build();
    const first = newlyBroken[0].diagnostics.find((d) => d.severity === "error");
    return { hunks: [], skipped, reverted: `${newlyBroken.map((s) => s.doc).join(", ")} stopped building${first ? ` (${first.message})` : ""}; edits reverted` };
  }
  return { hunks: applied, skipped };
}

/** Documents whose last build (build/status.json) failed. */
function brokenDocs(cfg: Config): Set<string> {
  const file = paths(cfg).status;
  const v: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const docs = v && typeof v === "object" && "docs" in v && Array.isArray(v.docs) ? v.docs : [];
  return new Set(docs.flatMap((s: unknown) => (s && typeof s === "object" && "doc" in s && "ok" in s && s.ok === false && typeof s.doc === "string" ? [s.doc] : [])));
}

/** Whether every document that reads these files loads the `changes` package (needed for tracked markup). */
function changesLoaded(cfg: Config, files: string[]): boolean {
  for (const doc of cfg.docs) {
    const log = docPaths(cfg, doc).log;
    if (!existsSync(log)) continue;
    const text = readFileSync(log, "utf8");
    const reads = files.some((f) => f === doc.root || text.includes(f.replace(/\.tex$/, "")));
    if (reads && !/changes\.sty/.test(text)) return false;
  }
  return true;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.proofread.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** `file:line: old → new (why)` for reports. */
export function formatHunk(h: Hunk): string {
  const where = `${posix(h.file)}:${h.line}`;
  const change = h.old && h.new ? `${h.old.trim()} → ${h.new.trim()}` : h.new ? `+ ${h.new.trim()}` : `− ${h.old.trim()}`;
  return `${where}: ${change}${h.why ? ` (${h.why})` : ""}`;
}
