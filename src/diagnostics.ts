import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { posix } from "./config.ts";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** Project-relative path; absent when the message is not tied to a project file. */
  file?: string;
  line?: number;
  message: string;
}

/** TeX wraps log lines at this width (max_print_line). */
const LOG_WIDTH = 79;

/** Font-loading chatter XeTeX reports as warnings; never actionable. */
const NOISE = [/^Requested font /, /^\s*-> \S+$/, /^Unknown feature `'/, /^warnings were issued by the TeX engine/, /^Label\(s\) may have changed/];

/**
 * Resolves a path as TeX printed it ("sub", "./chapters/a.tex", "/abs/x.tex") to a project-relative
 * file, or undefined when it is outside the project or does not exist (packages, classes, fonts).
 */
export function projectFile(dir: string, raw: string): string | undefined {
  const p = raw.trim().replace(/^"|"$/g, "");
  if (p === "") return undefined;
  const abs = isAbsolute(p) ? normalize(p) : join(dir, p);
  for (const cand of [abs, `${abs}.tex`]) {
    if (!existsSync(cand)) continue;
    const rel = relative(dir, cand);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return posix(rel);
  }
  return undefined;
}

/** Parses Tectonic's stderr: `error: file:line: msg`, `warning: file:line: msg`, with continuation lines. */
export function parseTectonicOutput(text: string, dir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  let generic: Diagnostic | undefined;
  let tool: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const run = /^note: Running external tool (\S+)/.exec(lines[i]);
    if (run) tool = run[1];
    const m = /^(error|warning): (.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[2];
    if (body.startsWith("something bad happened inside XeTeX")) {
      // A dump of the engine transcript follows between ==== rulers; the log parser covers it.
      const end = lines.findIndex((l, j) => j > i + 1 && /^={20,}$/.test(l));
      if (end > 0) i = end;
      continue;
    }
    while (i + 1 < lines.length && !/^(note|warning|error|caused by): /.test(lines[i + 1]) && lines[i + 1].trim() !== "") {
      body += (body.endsWith(" ") || body === "" ? "" : " ") + lines[++i].trim();
    }
    const severity: Severity = m[1] === "error" ? "error" : "warning";
    const loc = /^(.+?):(\d+): (.*)$/.exec(body);
    if (!loc) {
      if (severity === "error" && tool && /os error 2\b/.test(body)) {
        const hint = tool === "biber" ? ": biblatex needs biber; use natbib, or \\usepackage[backend=bibtex]{biblatex}" : "";
        out.push({ severity, message: `${tool} is not available in this environment${hint}` });
        continue;
      }
      if (severity === "error") {
        // "the XeTeX engine had an unrecoverable error" etc.: only useful when nothing specific was reported.
        generic ??= { severity, message: body };
        continue;
      }
      const abs = /^accessing absolute path `(.+)`; build may not be reproducible/.exec(body);
      if (abs) out.push({ severity: "info", message: `not reproducible: uses system file ${abs[1]}` });
      // Tectonic runs BibTeX on every \include'd chapter .aux, most of which cite nothing.
      else if (/^errors were issued by BibTeX, but were ignored/.test(body)) out.push({ severity: "info", message: `${body} (see the .blg if citations are missing)` });
      else if (!NOISE.some((r) => r.test(body))) out.push({ severity, message: body });
      continue;
    }
    const message = loc[3].trim();
    if (NOISE.some((r) => r.test(message))) continue;
    const file = projectFile(dir, loc[1]);
    out.push(badbox({ severity, file, line: file ? Number(loc[2]) : undefined, message }));
  }
  if (generic && !out.some((d) => d.severity === "error")) out.push(generic);
  return out;
}

/**
 * Parses a TeX transcript for what Tectonic's stderr omits (LaTeX/package warnings, bad boxes) and, for
 * latexmk, errors. The file of a message is taken from TeX's open-file parentheses.
 */
export function parseLog(text: string, dir: string): Diagnostic[] {
  const lines = unwrap(text);
  const out: Diagnostic[] = [];
  const stack: (string | undefined)[] = [];
  // TeX line numbers refer to the innermost open file. When that is a package, report the nearest project
  // file that (transitively) loaded it, without a line: the number would point into the package.
  const current = (): { file?: string; exact: boolean } => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) return { file: stack[k], exact: k === stack.length - 1 };
    return { exact: false };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // file-line-error style (latexmk -file-line-error): ./sub.tex:2: Undefined control sequence.
    const fle = /^(\.{0,2}\/?[^:\s()]+\.(?:tex|sty|cls|bib|ltx|dtx)):(\d+): (.+)$/.exec(line);
    if (fle) {
      const file = projectFile(dir, fle[1]);
      out.push({ severity: "error", file, line: file ? Number(fle[2]) : undefined, message: fle[3].replace(/\.$/, "") });
      continue;
    }
    if (line.startsWith("! ")) {
      const ctx = lines.slice(i + 1, i + 12).find((l) => /^l\.\d+/.test(l));
      const { file, exact } = current();
      out.push({ severity: "error", file, line: ctx && file && exact ? Number(/^l\.(\d+)/.exec(ctx)![1]) : undefined, message: line.slice(2).replace(/\.$/, "") });
      continue;
    }

    const w = /^(LaTeX|LaTeX Font|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (w) {
      let message = w[4];
      const cont = w[2] ?? w[3];
      while (cont && i + 1 < lines.length && lines[i + 1].startsWith(`(${cont})`)) message += " " + lines[++i].slice(cont.length + 2).trim();
      while (!cont && i + 1 < lines.length && lines[i + 1].trim() !== "" && /^\s/.test(lines[i + 1])) message += " " + lines[++i].trim();
      if (NOISE.some((r) => r.test(message))) continue;
      const ln = /on input line (\d+)\.?$/.exec(message);
      const { file, exact } = ln ? current() : { file: undefined, exact: false };
      const pkg = w[2] ? `${w[2]}: ` : w[3] ? `${w[3]}: ` : "";
      out.push({
        severity: w[1] === "LaTeX Font" ? "info" : "warning",
        file,
        line: file && exact && ln ? Number(ln[1]) : undefined,
        message: pkg + message.replace(/\s*on input line \d+\.?$/, "").replace(/\.$/, ""),
      });
      continue;
    }

    const box = /^((?:Over|Under)full \\[hv]box \(.*?\) (?:in paragraph at lines (\d+)--\d+|detected at line (\d+)|has occurred while \\output is active|in alignment at lines (\d+)--\d+))/.exec(line);
    if (box) {
      const { file, exact } = current();
      const ln = box[2] ?? box[3] ?? box[4];
      out.push(badbox({ severity: "warning", file, line: file && exact && ln ? Number(ln) : undefined, message: box[1] }));
    }

    // Track open files: "(name" pushes, ")" pops. Messages above are consumed before they can unbalance this.
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "(") {
        const tok = /^\(([^\s()]+)/.exec(line.slice(c));
        stack.push(tok ? projectFile(dir, tok[1]) : undefined);
      } else if (ch === ")") stack.pop();
    }
  }
  return out;
}

/** Overfull boxes are layout defects worth fixing; underfull ones are usually cosmetic. */
function badbox(d: Diagnostic): Diagnostic {
  return /^Underfull/.test(d.message) ? { ...d, severity: "info" } : d;
}

function unwrap(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    // TeX hard-wraps at LOG_WIDTH, so a full-width line usually continues on the next, unless the next line
    // starts a new message (a message that is exactly LOG_WIDTH long is indistinguishable otherwise).
    while (l.length >= LOG_WIDTH && l.length % LOG_WIDTH === 0 && i + 1 < raw.length && !/^(LaTeX|Package|Class|Overfull|Underfull|! |\(|\)|$)/.test(raw[i + 1])) l += raw[++i];
    lines.push(l);
  }
  return lines;
}

/** Merges diagnostics from several sources, dropping repeats (TeX reruns print everything again). */
export function mergeDiagnostics(...lists: Diagnostic[][]): Diagnostic[] {
  const all = lists.flat();
  // Tectonic's summary and the .log word the same error with and without a final period.
  const text = (d: Diagnostic) => d.message.replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
  // A located copy of a message supersedes an unlocated one.
  const located = new Set(all.filter((d) => d.file !== undefined).map(text));
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of all) {
    const key = `${d.file ?? ""}:${d.line ?? ""}:${text(d)}`;
    if (seen.has(key) || (d.file === undefined && located.has(text(d)))) continue;
    seen.add(key);
    out.push(d);
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** `file:line: severity: message`, the format editors and omp parse. */
export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : "";
  return `${where}${d.severity}: ${d.message}`;
}
