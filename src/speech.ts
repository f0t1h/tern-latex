import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { escapeLatex } from "./changes.ts";
import type { Config } from "./config.ts";
import { resolveTool } from "./tools.ts";

/**
 * Dictation with omp's own local speech model. omp has no entry point that transcribes for other programs, so
 * this loads what `omp setup speech` installed — the sherpa-onnx runtime and the Parakeet model in omp's cache —
 * and runs it in this process. Coupling to omp's cache layout is deliberate (one model download, omp's choice of
 * model); every path is discovered from omp's documented layout, and anything missing becomes a hint, not a crash.
 */

/** Whether dictation can run; `hint` says what is missing when not. */
export interface SpeechStatus {
  ready: boolean;
  hint?: string;
}

const PARAKEET_ROLE = "local/parakeet-tdt-0.6b-v3";
/** omp's model repository for its Parakeet role, under `<agent dir>/cache/tiny-models/`. */
const PARAKEET_REPO = ["csukuangfj", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"];
const MODEL_FILES: Record<"encoder" | "decoder" | "joiner" | "tokens", string> = {
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
};
/** The model's input rate. */
const MODEL_RATE = 16_000;
const SETUP_HINT = "run `omp setup speech` once to download omp's Parakeet model";

/** omp's agent directory: `PI_CODING_AGENT_DIR`, else `~/<PI_CONFIG_DIR or .omp>/agent`. */
export function ompAgentDir(): string {
  const env = process.env;
  return env.PI_CODING_AGENT_DIR || join(homedir(), env.PI_CONFIG_DIR || ".omp", "agent");
}

interface SpeechFiles {
  /** The sherpa-onnx-node package directory. */
  runtime: string;
  /** The Parakeet model directory. */
  model: string;
}

/** Numeric dotted-version order ("1.13.2" < "1.14.0"). */
function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest `stt-runtime/sherpa-<version>/` holding sherpa-onnx-node, and the Parakeet model; a hint when either is missing. */
function speechFiles(agentDir: string): SpeechFiles | string {
  const cache = join(agentDir, "cache");
  const runtimes = join(cache, "stt-runtime");
  const versions = existsSync(runtimes)
    ? readdirSync(runtimes).flatMap((name) => {
        const m = /^sherpa-(\d+(?:\.\d+)*)$/.exec(name);
        const runtime = join(runtimes, name, "node_modules", "sherpa-onnx-node");
        return m && existsSync(join(runtime, "package.json")) ? [{ runtime, version: m[1] }] : [];
      })
    : [];
  const newest = versions.sort((a, b) => compareVersions(a.version, b.version)).at(-1);
  const model = join(cache, "tiny-models", ...PARAKEET_REPO);
  if (!newest || !Object.values(MODEL_FILES).every((f) => existsSync(join(model, f)))) return SETUP_HINT;
  return { runtime: newest.runtime, model };
}

/** omp's `dictation` model role (`omp config get modelRoles`), or undefined when unset or omp doesn't answer. */
async function dictationRole(cfg: Config): Promise<string | undefined> {
  try {
    const [omp, ...pre] = (await resolveTool("omp", cfg)).command;
    const proc = Bun.spawn([omp, ...pre, "config", "get", "modelRoles"], { cwd: cfg.dir, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000 });
    const v: unknown = JSON.parse(await new Response(proc.stdout).text());
    return v && typeof v === "object" && "dictation" in v && typeof v.dictation === "string" ? v.dictation : undefined;
  } catch {
    return undefined;
  }
}

/** Whether omp's Parakeet model and runtime are installed and omp's dictation role (when set) is Parakeet. */
export async function speechStatus(cfg: Config): Promise<SpeechStatus> {
  const role = await dictationRole(cfg);
  if (role && !/parakeet/i.test(role)) {
    return { ready: false, hint: `omp's dictation model is ${role}; ternlatex uses omp's Parakeet model: pick ${PARAKEET_ROLE} in omp's /model Roles or run \`omp setup speech\`` };
  }
  const files = speechFiles(ompAgentDir());
  return typeof files === "string" ? { ready: false, hint: files } : { ready: true };
}

interface Waveform {
  sampleRate: number;
  samples: Float32Array;
}

interface OfflineStream {
  acceptWaveform(w: Waveform): void;
}

interface OfflineRecognizer {
  createStream(): unknown;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): unknown;
}

function isRecognizer(v: unknown): v is OfflineRecognizer {
  return Boolean(
    v && typeof v === "object" && "createStream" in v && "decode" in v && "getResult" in v &&
      typeof v.createStream === "function" && typeof v.decode === "function" && typeof v.getResult === "function",
  );
}

function isStream(v: unknown): v is OfflineStream {
  return Boolean(v && typeof v === "object" && "acceptWaveform" in v && typeof v.acceptWaveform === "function");
}

let recognizer: OfflineRecognizer | undefined;

/** Loads omp's runtime and the Parakeet model (about a second); not cached on failure, so `omp setup speech` needs no restart. */
function loadRecognizer(): OfflineRecognizer {
  const files = speechFiles(ompAgentDir());
  if (typeof files === "string") throw new Error(files);
  const manifest: unknown = JSON.parse(readFileSync(join(files.runtime, "package.json"), "utf8"));
  const main = manifest && typeof manifest === "object" && "main" in manifest && typeof manifest.main === "string" ? manifest.main : "index.js";
  // omp's runtime lives in omp's cache, not in this bundle; a compiled binary can't resolve a package directory, so its main file is required by path.
  const sherpa: unknown = createRequire(join(files.runtime, "package.json"))(join(files.runtime, main));
  if (!sherpa || typeof sherpa !== "object" || !("OfflineRecognizer" in sherpa) || typeof sherpa.OfflineRecognizer !== "function") {
    throw new Error(`omp's speech runtime in ${files.runtime} has no OfflineRecognizer; ${SETUP_HINT}`);
  }
  const m = (f: keyof typeof MODEL_FILES) => join(files.model, MODEL_FILES[f]);
  const rec: unknown = Reflect.construct(sherpa.OfflineRecognizer, [
    {
      featConfig: { sampleRate: MODEL_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: m("encoder"), decoder: m("decoder"), joiner: m("joiner") },
        tokens: m("tokens"),
        numThreads: 2,
        provider: "cpu",
        modelType: "nemo_transducer",
      },
    },
  ]);
  if (!isRecognizer(rec)) throw new Error(`omp's speech runtime in ${files.runtime} is not the expected sherpa-onnx; ${SETUP_HINT}`);
  return rec;
}

/** Linear resampling (enough for speech recognition). */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = samples[j] * (1 - f) + (samples[j + 1] ?? samples[j]) * f;
  }
  return out;
}

/** Transcribes mono audio with omp's Parakeet model; the text comes punctuated and capitalised. */
export async function transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
  recognizer ??= loadRecognizer();
  const stream = recognizer.createStream();
  if (!isStream(stream)) throw new Error("omp's speech runtime returned no audio stream");
  stream.acceptWaveform({ sampleRate: MODEL_RATE, samples: resample(samples, sampleRate, MODEL_RATE) });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  return result && typeof result === "object" && "text" in result && typeof result.text === "string" ? result.text : "";
}

/** Base64 16-bit little-endian PCM as samples in [-1, 1); null when the byte count is odd. */
export function pcm16(base64: string): Float32Array | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 2) return null;
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

const SPOKEN_BREAKS: Record<string, string> = { paragraph: "\n\n", line: "\n" };

/**
 * A transcript as LaTeX to insert after BEFORE (the source character preceding the insertion point, "" at the
 * file's start): whitespace normalised, specials escaped, spoken "new paragraph" / "new line" as line breaks
 * (with the commas or stops around them dropped), and a leading space unless BEFORE is whitespace or the text
 * starts a new line. "" when nothing but breaks was said.
 */
export function spokenLatex(transcript: string, before: string): string {
  const text = escapeLatex(transcript.replace(/\s+/g, " ").trim())
    .replace(/[\s,;:]*\bnew (paragraph|line)\b[\s,.;:!?]*/gi, (_, kind: string) => SPOKEN_BREAKS[kind.toLowerCase()])
    .replace(/\n{3,}/g, "\n\n");
  if (!/\S/.test(text)) return "";
  return text.startsWith("\n") || before === "" || /\s/.test(before) ? text : ` ${text}`;
}
