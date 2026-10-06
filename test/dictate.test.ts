import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder, type Status } from "../src/builder.ts";
import { type Config, docPaths, loadConfig } from "../src/config.ts";
import { type DictationApi, type ServerOptions, startServer } from "../src/server.ts";
import { spokenLatex } from "../src/speech.ts";
import { resolveReview, reviewList } from "../src/suggestions.ts";
import { ternKeys } from "../src/ternplugin.ts";

const TEXT = "\\documentclass{article}\n\\begin{document}\nResults rose by 50\\% at R\\&D. The end.\n\\end{document}\n";
/** The PDF's text for the first sentence, as the viewer's text layer reports it. */
const SELECTED = "Results rose by 50% at R&D.";
const AFTER = TEXT.indexOf("R\\&D.") + "R\\&D.".length;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A one-document project; `changes` says whether its last build log shows the changes package loaded. */
function project(changes: boolean): Config {
  const dir = mkdtempSync(join(tmpdir(), "ternlatex-dictate-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ternlatex.toml"), 'root = "main.tex"\n');
  writeFileSync(join(dir, "main.tex"), TEXT);
  mkdirSync(join(dir, "build"));
  const cfg = loadConfig(dir);
  writeFileSync(docPaths(cfg, cfg.docs[0]).log, `(./main.tex${changes ? " (/texmf/tex/latex/changes/changes.sty)" : ""})\n`);
  return cfg;
}

/** Builds nothing: every request answers the next of `results` (ok by default), counting the calls. */
class FakeBuilder extends Builder {
  builds = 0;
  readonly #results: boolean[];
  constructor(cfg: Config, results: boolean[] = []) {
    super(cfg);
    this.#results = results;
  }
  override async request(): Promise<Status[]> {
    const ok = this.#results[this.builds++] ?? true;
    return this.all().map((s): Status => ({ ...s, ok, diagnostics: ok ? [] : [{ severity: "error", message: "Undefined control sequence" }] }));
  }
}

/** A transcriber that answers `text` and records what it was given. */
function fakeSpeech(text: string, ready = true) {
  const calls: { samples: number; sampleRate: number }[] = [];
  let checks = 0;
  const api: DictationApi = {
    status: async () => (checks++, ready ? { ready: true } : { ready: false, hint: "run `omp setup speech`" }),
    transcribe: async (samples, sampleRate) => {
      calls.push({ samples: samples.length, sampleRate });
      return text;
    },
  };
  return { api, calls, checks: () => checks };
}

async function withServer(builder: Builder, extra: Partial<ServerOptions>, run: (url: string) => Promise<void>): Promise<void> {
  const server = await startServer({ builder, port: 0, open: async () => {}, editor: false, agent: () => undefined, ...extra });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** 0.1 s of silence at 16 kHz: 1600 16-bit samples. */
const AUDIO = { audio: Buffer.alloc(3200).toString("base64"), sampleRate: 16000 };
const SELECTION = { page: 1, start: { x: 10, y: 10 }, end: { x: 90, y: 10 }, text: SELECTED };

describe("spokenLatex", () => {
  test("whitespace normalised, specials escaped, a leading space after a word", () => {
    expect(spokenLatex("  Costs fell   10% for A&B_c,\n see #3. ", ".")).toBe(" Costs fell 10\\% for A\\&B\\_c, see \\#3.");
  });

  test("no leading space after whitespace, at the file's start or before a new paragraph", () => {
    expect(spokenLatex("More text.", " ")).toBe("More text.");
    expect(spokenLatex("More text.", "\n")).toBe("More text.");
    expect(spokenLatex("More text.", "")).toBe("More text.");
    expect(spokenLatex("New paragraph. More text.", "x")).toBe("\n\nMore text.");
  });

  test('"new paragraph" and "new line" become breaks, the punctuation around them goes', () => {
    expect(spokenLatex("That holds. New paragraph. Next we show, new line, this.", "a")).toBe(" That holds.\n\nNext we show\nthis.");
    expect(spokenLatex("first new Paragraph second", "a")).toBe(" first\n\nsecond");
    expect(spokenLatex("one. New line. New paragraph. two", "a")).toBe(" one.\n\ntwo");
  });

  test("nothing but breaks (or silence) is nothing", () => {
    expect(spokenLatex("New paragraph.", "a")).toBe("");
    expect(spokenLatex("   ", "a")).toBe("");
  });
});

describe("POST /dictate", () => {
  test("a document without `changes`: a pending dictation suggestion at the selection's end; accepting it edits the source", async () => {
    const cfg = project(false);
    const speech = fakeSpeech("Costs fell 10% too.");
    const builder = new FakeBuilder(cfg);
    await withServer(builder, { dictation: speech.api }, async (url) => {
      const res = await post(`${url}dictate`, { ...SELECTION, ...AUDIO, sampleRate: 48000 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ file: "main.tex", line: 3, inserted: " Costs fell 10\\% too.", pending: true });
    });
    expect(speech.calls).toEqual([{ samples: 1600, sampleRate: 48000 }]);
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT); // untouched until accepted
    expect(builder.builds).toBe(0);
    const { items } = reviewList(cfg);
    expect(items.map((c) => [c.kind, c.author, c.line, c.text])).toEqual([["added", "dictation", 3, " Costs fell 10\\% too."]]);
    expect(await resolveReview(cfg, [items[0].id], "accept")).toBe(1);
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT.slice(0, AFTER) + " Costs fell 10\\% too." + TEXT.slice(AFTER));
  });

  test("a document loading `changes`: a tracked \\added[id=dictation] in the source, built once", async () => {
    const cfg = project(true);
    const builder = new FakeBuilder(cfg);
    await withServer(builder, { dictation: fakeSpeech("Second thoughts, new line, more.").api }, async (url) => {
      const res = await post(`${url}dictate`, { ...SELECTION, ...AUDIO });
      expect(await res.json()).toEqual({ file: "main.tex", line: 3, inserted: " Second thoughts\nmore.", pending: false });
    });
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(`${TEXT.slice(0, AFTER)}\\added[id=dictation]{ Second thoughts\nmore.}${TEXT.slice(AFTER)}`);
    expect(builder.builds).toBe(1);
    expect(reviewList(cfg).authors.find((a) => a.id === "dictation")).toEqual({ id: "dictation", name: "dictation", color: "orange" });
  });

  test("a paragraph break can't go inside `changes` markup: it stays pending even there", async () => {
    const cfg = project(true);
    const builder = new FakeBuilder(cfg);
    await withServer(builder, { dictation: fakeSpeech("New paragraph. Second thoughts.").api }, async (url) => {
      const res = await post(`${url}dictate`, { ...SELECTION, ...AUDIO });
      expect(await res.json()).toEqual({ file: "main.tex", line: 3, inserted: "\n\nSecond thoughts.", pending: true });
    });
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT);
    expect(builder.builds).toBe(0);
    expect(reviewList(cfg).items.map((c) => [c.kind, c.author, c.text])).toEqual([["added", "dictation", "\n\nSecond thoughts."]]);
  });

  test("an insertion that breaks the build is reverted", async () => {
    const cfg = project(true);
    const builder = new FakeBuilder(cfg, [false, true]);
    await withServer(builder, { dictation: fakeSpeech("Fine words.").api }, async (url) => {
      const res = await post(`${url}dictate`, { ...SELECTION, ...AUDIO });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("stopped building (Undefined control sequence); edits reverted");
    });
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT);
    expect(builder.builds).toBe(2);
  });

  test("422 when nothing was caught, 400 without a selection or with broken audio; the source stays", async () => {
    const cfg = project(false);
    await withServer(new FakeBuilder(cfg), { dictation: fakeSpeech(" ").api }, async (url) => {
      const empty = await post(`${url}dictate`, { ...SELECTION, ...AUDIO });
      expect(empty.status).toBe(422);
      expect((await empty.json()).error).toContain("didn't catch anything");
      expect((await post(`${url}dictate`, { text: SELECTED, ...AUDIO })).status).toBe(400);
      expect((await post(`${url}dictate`, { ...SELECTION, audio: "AA==", sampleRate: 16000 })).status).toBe(400); // one byte: no 16-bit samples
      expect((await post(`${url}dictate`, { ...SELECTION, ...AUDIO, sampleRate: 0 })).status).toBe(400);
    });
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT);
    expect(reviewList(cfg).items).toEqual([]);
  });

  test("409 with the hint while omp's model is missing, checked again on every request until ready", async () => {
    const cfg = project(false);
    const speech = fakeSpeech("Words.", false);
    await withServer(new FakeBuilder(cfg), { dictation: speech.api }, async (url) => {
      const res = await post(`${url}dictate`, { ...SELECTION, ...AUDIO });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("run `omp setup speech`");
      expect((await post(`${url}dictate/transcribe`, AUDIO)).status).toBe(409);
    });
    expect(speech.checks()).toBe(3); // at start, then once per request
    expect(speech.calls).toEqual([]);
  });

  test("404 without dictation", async () => {
    await withServer(new FakeBuilder(project(false)), {}, async (url) => {
      expect((await post(`${url}dictate`, { ...SELECTION, ...AUDIO })).status).toBe(404);
    });
  });
});

describe("POST /dictate/transcribe", () => {
  test("answers the transcript without touching any file", async () => {
    const cfg = project(false);
    const speech = fakeSpeech("  Hello there. ");
    await withServer(new FakeBuilder(cfg), { dictation: speech.api }, async (url) => {
      const res = await post(`${url}dictate/transcribe`, AUDIO);
      expect(await res.json()).toEqual({ text: "Hello there." });
    });
    expect(speech.calls).toEqual([{ samples: 1600, sampleRate: 16000 }]);
    expect(readFileSync(join(cfg.dir, "main.tex"), "utf8")).toBe(TEXT);
    expect(reviewList(cfg).items).toEqual([]);
  });
});

describe("request body caps", () => {
  test("8 MiB for the dictation routes, 64 KiB for the others", async () => {
    const cfg = project(false);
    const big = { ...AUDIO, audio: Buffer.alloc(200_000).toString("base64") }; // ~267 KB of JSON
    await withServer(new FakeBuilder(cfg), { dictation: fakeSpeech("Fine.").api, proofread: async () => ({ suggestions: 0, paragraphs: 0, skipped: {}, lines: [] }) }, async (url) => {
      expect((await post(`${url}dictate/transcribe`, big)).status).toBe(200);
      const refused = await post(`${url}proofread`, { ...SELECTION, padding: big.audio });
      expect(refused.status).toBe(413);
      expect((await refused.json()).error).toContain("request body too large");
      const huge = { ...AUDIO, audio: "A".repeat(8 * 1024 * 1024) };
      expect((await post(`${url}dictate/transcribe`, huge)).status).toBe(413);
    });
  });
});

describe("GET /capabilities", () => {
  test("dictation whenever the server offers it, with or without an omp block; keys when given", async () => {
    const cfg = project(false);
    const keys = await ternKeys("darwin");
    await withServer(new FakeBuilder(cfg), { keys, dictation: fakeSpeech("x").api }, async (url) => {
      const caps = await (await fetch(`${url}capabilities`)).json();
      expect(caps.agent).toBe(false);
      expect(caps.keys).toEqual(keys);
      expect(caps.dictation).toEqual({ ready: true });
    });
    await withServer(new FakeBuilder(cfg), {}, async (url) => {
      const caps = await (await fetch(`${url}capabilities`)).json();
      expect("keys" in caps).toBe(false);
      expect("dictation" in caps).toBe(false);
    });
  });
});

describe("ternKeys", () => {
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, "..", "tern-plugin", "keys.json"), "utf8")).commands;

  test("every command of keys.json, ⌘⌥ on macOS", async () => {
    const keys = await ternKeys("darwin");
    expect(keys.map((k) => k.id)).toEqual(shipped.map((c: { id: string }) => c.id));
    expect(keys.find((k) => k.id === "show-in-pdf")).toEqual({ id: "show-in-pdf", title: "Show in PDF", hint: "PDF spot of the caret's line", display: "⌘⌥J" });
  });

  test("Ctrl+Alt elsewhere", async () => {
    for (const platform of ["linux", "win32"] as const) expect((await ternKeys(platform)).find((k) => k.id === "outline")?.display).toBe("Ctrl+Alt+O");
  });
});
