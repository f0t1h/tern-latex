import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mergeDiagnostics, parseLog, parseTectonicOutput } from "../src/diagnostics.ts";

// Real Tectonic 0.17 stderr and transcripts for the sources in this directory.
const dir = fileURLToPath(new URL("./fixtures/diagnostics/", import.meta.url));
const parse = (stem: string) =>
  mergeDiagnostics(parseTectonicOutput(readFileSync(join(dir, `${stem}.stderr.txt`), "utf8"), dir), parseLog(readFileSync(join(dir, `${stem}.log`), "utf8"), dir));

test("a successful build reports each bad box once and attributes warnings to the \\input file", () => {
  const ds = parse("main");
  const overfull = ds.filter((d) => d.message.startsWith("Overfull"));
  assert.equal(overfull.length, 1, "TeX reruns repeat warnings; they must be deduplicated");
  assert.deepEqual({ ...overfull[0], message: undefined }, { severity: "warning", file: "main.tex", line: 6, message: undefined });
  const ref = ds.find((d) => d.message.includes("nowhere"));
  assert.ok(ref, "undefined reference warning from the log");
  assert.equal(ref.file, "chapters/one.tex");
  assert.equal(ref.line, 2);
  assert.ok(!ds.some((d) => d.severity === "error"));
});

test("a failed build yields one located error, resolving Tectonic's extension-less path", () => {
  const errors = parse("fail").filter((d) => d.severity === "error");
  assert.deepEqual(errors, [{ severity: "error", file: "chapters/two.tex", line: 2, message: "Undefined control sequence" }]);
});

test("a log line of exactly the wrap width is not glued to the next message", () => {
  const first = "Package natbib Warning: Citation `kew2008' on page 1 undefined on input line 5.";
  assert.equal(first.length, 79);
  const log = `(main.tex\n${first}\nLaTeX Warning: Reference \`sec:x' on page 1 undefined on input line 7.\n)`;
  const ds = parseLog(log, dir);
  assert.equal(ds.length, 2);
  assert.deepEqual(
    ds.map((d) => [d.line, d.message]),
    [
      [5, "natbib: Citation `kew2008' on page 1 undefined"],
      [7, "Reference `sec:x' on page 1 undefined"],
    ],
  );
});
