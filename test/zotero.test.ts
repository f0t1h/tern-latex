import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { bibAppendix, bibKeys, findReferences, IMPORT_HEADER, keySearchTerms, parseCiteKeys, withKey } from "../src/zotero.ts";

const dir = fileURLToPath(new URL("./fixtures/zotero/", import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, name), "utf8");
// Verbatim `format=bibtex` response of api.zotero.org for an item of the public group 216092.
const zoteroExport = fixture("hallett.zotero.bib");
const entry = (key: string, bibtex: string) => ({ key, bibtex, title: "", creators: "" });

test("cite keys from natbib and biblatex commands, skipping comments and optional arguments", () => {
  assert.deepEqual(parseCiteKeys(fixture("cites.tex")), [
    "knuth1984",
    "kew2008",
    "lamport1994",
    "a:b-c_2020",
    "x.y",
    "smith2020",
    "smith2020",
    "after_escaped_percent",
    "biblatex1",
    "biblatex2",
    "biblatex3",
    "multi1",
    "multi2",
    "multi3",
    "extra_entry",
    "spread_over_lines",
    "nested_opt",
  ]);
});

test("existing bib keys are found regardless of entry-type case or delimiters; @string/@comment are not entries", () => {
  assert.deepEqual([...bibKeys(fixture("existing.bib"))], ["knuth1984", "kew2008", "no_trailing_newline"]);
  assert.deepEqual([...bibKeys(zoteroExport)], ["hallett_identity_2026"]);
});

test("an entry's key is rewritten to the resolved citation key and nothing else changes", () => {
  const out = withKey(zoteroExport, "HallettMullins2026");
  assert.ok(out?.startsWith("@incollection{HallettMullins2026,\n\ttitle = {Identity"));
  assert.equal(out, zoteroExport.trim().replace("hallett_identity_2026", "HallettMullins2026"));
  assert.equal(withKey("@comment{x, y}", "k"), null);
});

test("appending leaves existing entries byte-for-byte intact and skips duplicates", () => {
  const existing = fixture("existing.bib");
  const { text, added } = bibAppendix(existing, [
    entry("kew2008", "@inproceedings{kew2008, title = {dup}}"),
    entry("Hallett2026", zoteroExport),
    entry("Hallett2026", zoteroExport),
    entry("broken", "not bibtex"),
  ]);
  assert.deepEqual(added, ["Hallett2026"]);
  const merged = existing + text;
  assert.ok(merged.startsWith(existing));
  assert.equal(merged.split(IMPORT_HEADER).length, 2, "one header per appended block");
  assert.ok(text.startsWith(existing.endsWith("\n") ? `\n${IMPORT_HEADER}\n@incollection{Hallett2026,` : `\n\n${IMPORT_HEADER}\n@incollection{Hallett2026,`));
  assert.deepEqual([...bibKeys(merged)], ["knuth1984", "kew2008", "no_trailing_newline", "Hallett2026"]);
  assert.deepEqual(bibAppendix(merged, [entry("Hallett2026", zoteroExport)]), { text: "", added: [] });
});

test("an empty bib gets the header and entries without leading blank lines", () => {
  const { text } = bibAppendix("", [entry("a", "@misc{x, note = {1}}"), entry("b", "@misc{y, note = {2}}")]);
  assert.equal(text, `${IMPORT_HEADER}\n@misc{a, note = {1}}\n\n@misc{b, note = {2}}\n`);
});

test("cite keys map to quick-search terms for the web lookup", () => {
  assert.deepEqual(keySearchTerms("morlan_all_2024"), ["morlan", "all"]);
  assert.deepEqual(keySearchTerms("SmithJones2020a"), ["smith", "jones"]);
  assert.deepEqual(keySearchTerms("knuth1984"), ["knuth"]);
  assert.deepEqual(keySearchTerms("10.1000/xy"), []);
});

test("refs find matches project .bib entries on every word, accent- and case-insensitively, with the natbib cite command", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ternlatex-find-"));
  try {
    writeFileSync(join(tmp, "ternlatex.toml"), `root = "main.tex"\n`);
    writeFileSync(join(tmp, "main.tex"), `\\documentclass{article}\n\\usepackage[round]{natbib}\n\\begin{document}\n\\end{document}\n`);
    writeFileSync(
      join(tmp, "refs.bib"),
      `@article{godel1931, author = {G{\\"o}del, Kurt}, title = {{\\"U}ber formal unentscheidbare S{\\"a}tze}, year = {1931}}\n` +
        `@book{knuth1984, author = {Knuth, Donald E.}, title = {The {\\TeX}book}, year = {1984}}\n` +
        `@misc{new2024, author = {Gödel, Ann and Bé, Cé and Dee, Dé}, title = {Recent}, year = {2024}}\n`,
    );
    const cfg = loadConfig(tmp);
    // Enough .bib hits for the limit: Zotero is not asked, so the result is deterministic.
    const hit = await findReferences(cfg, "GODEL 1931", 1);
    assert.deepEqual(hit, { cite: "\\citep", variants: ["\\citep", "\\citet", "\\cite"], items: [{ key: "godel1931", year: "1931", creators: "Gödel", title: 'Über formal unentscheidbare Sätze', source: "bib" }] });
    const recent = await findReferences(cfg, "", 2);
    assert.deepEqual(recent.items.map((i) => [i.key, i.creators]), [["new2024", "Gödel et al."], ["knuth1984", "Knuth"]]);
    assert.equal(recent.zotero_error, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
