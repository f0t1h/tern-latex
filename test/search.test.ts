import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, type DocConfig, docPaths, loadConfig } from "../src/config.ts";
import { findMatches, fold, proseOf, queryTerms, SearchIndex, type SearchHit, termRules, typoCost } from "../src/search.ts";
import { SyncTex } from "../src/synctex.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "search");

describe("proseOf", () => {
  const prose = (tex: string) => proseOf(tex).text.trim();

  test("skips the preamble, comments, math, \\iffalse blocks and what follows \\end{document}", () => {
    const tex = "\\documentclass{article}\n\\usepackage{geometry}\n\\title{Preamble}\n\\begin{document}\nOne % hidden\ntwo $x^2 + y$ three \\[ z \\] four\n\\begin{align}a&=b\\end{align}\n\\iffalse draft \\fi five\n\\end{document}\nafter";
    expect(prose(tex)).toBe("One two three four five");
  });

  test("keeps formatted and accented words whole, splits consecutive arguments", () => {
    expect(prose("\\textbf{fo}o caf\\'e na\\\"{i}ve \\v{c}evap \\o{}l stra\\ss e")).toBe("foo cafe naive cevap ol strasse");
    expect(prose("\\cventry{2020}{Engineer}{Acme}")).toBe("2020 Engineer Acme");
  });

  test("leaves out keys, files, lengths and definitions but keeps citation keys and section titles", () => {
    const tex = "\\section[Short]{Long title}\\label{sec:x} See \\ref{sec:x} and \\cite[p.~3]{smith2020}.\n\\includegraphics[width=3cm]{fig/plot.pdf}\\vspace{2em}\\newcommand{\\foo}[1]{bar #1}\nEnd \\\\[3pt] line";
    expect(prose(tex)).toBe("Long title See and smith2020. End line");
  });

  test("table cells are prose, the column spec is not", () => {
    expect(prose("\\begin{tabular}{|l|r|}\nQuokka & 42 \\\\\n\\end{tabular}")).toBe("Quokka 42");
  });

  test("maps prose back to source offsets", () => {
    const tex = "\\emph{Hello} world";
    const { text, at } = proseOf(tex);
    const w = text.indexOf("world");
    expect(tex.slice(at[w], at[w] + 5)).toBe("world");
    expect(tex[at[text.indexOf("Hello")]]).toBe("H");
  });
});

describe("findMatches", () => {
  const keys = (s: string) => s.split(" ").map(fold);
  const find = (text: string, q: string) => findMatches(keys(text), queryTerms(q));

  test("folds case, accents and ligatures", () => {
    expect(fold("Naïve")).toBe("naive");
    expect(fold("eﬃcient")).toBe("efficient");
    expect(fold("İstanbul")).toBe("istanbul");
  });

  test("an exact phrase scores 1; typos, prefixes and gaps score less, in that spirit", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(find(text, "brown fox")).toEqual([{ from: 2, to: 3, score: 1, typo: false }]);
    const typo = find(text, "qiuck brown")[0];
    expect(typo.from).toBe(1);
    expect(typo.score).toBeLessThan(1);
    expect(typo.score).toBeGreaterThan(0.8);
    expect(find(text, "lazy do")[0]).toMatchObject({ from: 7, to: 8 });
    const apart = find(text, "quick fox")[0];
    expect(apart).toMatchObject({ from: 1, to: 3 });
    expect(apart.score).toBeLessThan(1);
    const reversed = find(text, "fox brown")[0];
    expect(reversed.score).toBeLessThan(apart.score);
  });

  test("every query word must be near the others", () => {
    expect(find("alpha beta gamma delta epsilon zeta eta theta iota kappa", "alpha kappa")).toEqual([]);
    expect(find("alpha beta", "alpha omega")).toEqual([]);
  });

  test("finds each place once, in document order", () => {
    expect(find("cat and cat and cat", "cat").map((m) => m.from)).toEqual([0, 2, 4]);
  });

  test("when the document has the query word, other words match only as its rare, likely misspellings", () => {
    const terms = queryTerms("fast");
    const search = (text: string) => {
      const keys = text.split(" ");
      return findMatches(keys, terms, termRules(keys, [], terms)).map((m) => `${keys[m.from]}${m.typo ? "?" : ""}`);
    };
    // "fsat" (a swap) is a typo in the document; "last" (a far key) and "fats" (used too often) are words.
    expect(search("the fast car and the fsat one were last , fats fats fats")).toEqual(["fast", "fsat?"]);
    // Without "fast" the query may be the misspelt one: any close word, nearest keys first.
    const without = "the vast and the last ship".split(" ");
    const found = findMatches(without, terms, termRules(without, [], terms));
    expect(found.map((m) => [without[m.from], m.typo])).toEqual([["vast", false], ["last", false]]);
    expect(found[0].score).toBeGreaterThan(found[1].score);
  });
});

describe("typoCost", () => {
  test("likely slips cost less: a neighbouring key, a missed double, an extra letter beside its key, a swap", () => {
    expect(typoCost("dast", "fast", 2)).toBeLessThan(typoCost("last", "fast", 2));
    expect(typoCost("ocur", "occur", 2)).toBeLessThan(typoCost("occr", "occur", 2));
    expect(typoCost("seaarch", "search", 2)).toBeLessThan(typoCost("seaprch", "search", 2));
    expect(typoCost("serach", "search", 2)).toBeLessThan(typoCost("sexrch", "search", 2));
    expect(typoCost("search", "search", 2)).toBe(0);
    // An extra first letter has no neighbour on one side: only the other side can make it a slip.
    expect(typoCost("fsat", "sat", 2)).toBe(0.8);
    expect(typoCost("asat", "sat", 2)).toBe(0.5);
  });

  test("stops above the budget", () => {
    expect(typoCost("abcdef", "uvwxyz", 1)).toBeGreaterThan(1);
  });
});

describe("SearchIndex on a built document", () => {
  let dir: string;
  let cfg: Config;
  let doc: DocConfig;
  let synctex: SyncTex;
  let index: SearchIndex;
  const search = async (q: string): Promise<SearchHit[]> => (await index.search(doc, q, synctex)).hits;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ternlatex-search-"));
    writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
    for (const f of ["main.tex", "chapter.tex"]) copyFileSync(join(FIXTURE, f), join(dir, f));
    cfg = loadConfig(dir);
    doc = cfg.docs[0];
    const p = docPaths(cfg, doc);
    mkdirSync(dirname(p.deps), { recursive: true });
    copyFileSync(join(FIXTURE, "main.pdf"), p.pdf);
    copyFileSync(join(FIXTURE, "main.synctex.gz"), p.synctex);
    writeFileSync(p.deps, "main.pdf: main.tex chapter.tex\n");
    synctex = await SyncTex.load(p.synctex, dir);
    index = new SearchIndex(cfg);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("text in both the PDF and the source is one hit with its boxes and its line, in reading order", async () => {
    const hits = await search("quokka");
    expect(hits.map((h) => [h.in, h.page, h.source?.file, h.source?.line])).toEqual([
      ["both", 1, "main.tex", 22],
      ["both", 2, "main.tex", 26],
    ]);
    for (const h of hits) {
      expect(h.match.toLowerCase()).toBe("quokka");
      expect(h.rects?.length).toBe(1);
      expect(h.rects?.[0].width).toBeGreaterThan(10);
    }
  });

  test("an \\input file is searched", async () => {
    expect((await search("narwhals")).map((h) => [h.in, h.source?.file, h.source?.line])).toEqual([["both", "chapter.tex", 2]]);
  });

  test("a word hyphenated across lines is found, with a box on each line", async () => {
    const [hit] = await search("perhaps");
    expect(hit.in).toBe("both");
    expect(hit.rects?.length).toBe(2);
    expect(hit.rects?.[1].y).toBeGreaterThan(hit.rects?.[0].y ?? Infinity);
  });

  test("accents and LaTeX accent commands meet: naive cafe finds na\\\"ive caf\\'e", async () => {
    const [hit] = await search("naive cafe");
    expect(hit).toMatchObject({ in: "both", match: "naïve café", source: { file: "main.tex", line: 9 } });
  });

  test("text a macro typesets is found in the PDF and traced to its line", async () => {
    expect((await search("ternlatex")).map((h) => [h.in, h.source?.line])).toEqual([["pdf", 8]]);
  });

  test("a citation key is found in the source and placed on its page by SyncTeX", async () => {
    const [hit] = await search("einstein");
    expect(hit).toMatchObject({ in: "source", page: 1, source: { file: "main.tex", line: 19 }, match: "einstein1905" });
    expect(hit.rects).toBeUndefined();
    expect(hit.box?.page).toBe(1);
  });

  test("comments, the preamble, math source and reference keys are not searched", async () => {
    expect(await search("zebras")).toEqual([]);
    expect(await search("geometry")).toEqual([]);
    // "energy" is typeset in the equation and the prose; the source's \label/\ref{eq:energy} add nothing.
    expect((await search("energy")).map((h) => h.in)).toEqual(["pdf", "both"]);
  });

  test("typos still find the place, below an exact match's score", async () => {
    const [hit] = await search("mountain gorilas");
    expect(hit).toMatchObject({ page: 2, match: "mountain gorillas" });
    expect(hit.score).toBeLessThan(1);
  });

  test("a query of no words finds nothing", async () => {
    expect(await search("  ;; ")).toEqual([]);
  });
});
