// The model registry: a curated, revision-pinned list.
//
// Curated rather than free-text, because a model's tool-call syntax cannot be
// inferred from its name and getting it wrong looks like a bug in the loop
// rather than an unsupported combination (PLAN §10.2). Pinned, because M8's
// findings are properties of a specific checkpoint.
//
// This file is imported by both the browser bundle and web/fetch-model.ts, so
// the thing that downloads weights and the thing that loads them cannot
// disagree about which revision is current.

import type { DialectName } from "./dialects/index.ts";

/** Quantizations, in the order transformers.js names them. */
export type Dtype = "q4" | "q4f16" | "fp16" | "q8" | "fp32";

/**
 * Sampling settings a checkpoint needs to behave as trained.
 *
 * M8 chose greedy decoding so a spike's output would not change run to run, and
 * that was right for a spike. It is wrong for Antares: at temperature 0 both
 * sizes fall into repetition loops and never reach a tool call — the reference
 * safetensors model does it too, so it is the checkpoint's property, not the
 * runtime's (PLAN §11.10). An entry that needs sampling has to say so.
 *
 * `frequency_penalty` is deliberately absent. Antares specifies 0.3, and
 * transformers.js has no additive frequency penalty — only a multiplicative
 * `repetition_penalty`, which is a different function. Recording the gap beats
 * substituting a lookalike.
 */
export interface GenerationDefaults {
  do_sample: boolean;
  temperature?: number;
  top_p?: number;
  max_new_tokens?: number;
}

export interface ModelEntry {
  key: string;
  label: string;
  repo: string;
  /** Pinned commit sha. A moving `main` would make M8's findings unreproducible. */
  revision: string;
  /**
   * Candidate quantizations, best first. The page picks the first one the
   * adapter can actually run: f16 variants need the `shader-f16` feature, which
   * headless Chromium does not expose (PLAN §2.11.24) but a desktop browser
   * usually does.
   */
  dtypes: Dtype[];
  approxBytes: number;
  contextTokens: number;
  dialect: DialectName;
  note?: string;
  /**
   * Built locally by `make antares-onnx` rather than downloadable.
   *
   * No ONNX build of Antares exists anywhere and the source weights are gated
   * (PLAN §11.1.5), so `make model` cannot help. The UI needs this to say "run
   * the build" instead of offering a download that would 404.
   */
  local?: boolean;
  /** Sampling this checkpoint needs. Absent means the page's defaults are fine. */
  generation?: GenerationDefaults;
  /**
   * The task this model is for, when it is not general chat.
   *
   * Antares is trained for exactly one job with a fixed termination protocol;
   * offering it in a chat box without saying so produces confident nonsense.
   */
  task?: "chat" | "localize";
}

/** Quantizations that need `shader-f16` on the adapter. */
export const F16_DTYPES: ReadonlySet<Dtype> = new Set<Dtype>(["q4f16", "fp16"]);

export const models: ModelEntry[] = [
  {
    key: "lfm2-1.2b-tool",
    label: "LFM2 1.2B Tool",
    repo: "onnx-community/LFM2-1.2B-Tool-ONNX",
    revision: "1992998ab37ef9db120f1589181db465e0f037ad",
    // q4 first deliberately: it is the variant M8 measured and the only one
    // that runs headless, which is where the opt-in GPU suite runs.
    dtypes: ["q4", "q4f16"],
    approxBytes: 1_217_650_688,
    contextTokens: 128_000,
    dialect: "lfm2",
    note: "Purpose-built for tool use. The only entry verified end to end (M8).",
  },
  {
    key: "qwen2.5-0.5b-instruct",
    label: "Qwen2.5 0.5B Instruct",
    repo: "onnx-community/Qwen2.5-0.5B-Instruct",
    revision: "cc5cc01a65cc3ff17bdb73a7de33d879f62599b0",
    dtypes: ["q4", "q4f16"],
    approxBytes: 786_200_000,
    contextTokens: 32_768,
    dialect: "hermes",
    note: "Smallest entry, quickest to download. Dialect unverified.",
  },
  {
    key: "qwen3-1.7b",
    label: "Qwen3 1.7B",
    repo: "onnx-community/Qwen3-1.7B-ONNX",
    revision: "cc6a06a21d614e9b8e92a6adfab1074d4e7d2438",
    dtypes: ["q4", "q4f16"],
    approxBytes: 2_147_200_000,
    contextTokens: 32_768,
    dialect: "hermes",
    note: "Emits <think> blocks. 2.1 GB at q4 — check adapter limits before loading.",
  },
  {
    key: "antares-1b",
    label: "Antares 1B (vulnerability localization)",
    // Built by `make antares-onnx`, not downloaded. The revision pins the
    // SOURCE checkpoint the local build came from, which is the only thing that
    // makes a locally-built artifact reproducible.
    repo: "fdtn-ai/antares-1b-ONNX",
    revision: "10417eb35641b32e7141157db19c76eb545193b6",
    // fp16 only, and that is a measured decision rather than an omission.
    // Antares' RL-tuned weights are quantization-hostile: this repo's quantizer
    // scores 0.943 logit correlation on the Granite base model it came from —
    // better than onnx-community's own published q4 — and 0.816 on Antares,
    // which costs it the tool-call protocol entirely (PLAN §11.10).
    dtypes: ["fp16"],
    approxBytes: 3_676_884_858,
    contextTokens: 131_072,
    dialect: "antares",
    local: true,
    task: "localize",
    generation: { do_sample: true, temperature: 0.3, top_p: 1.0, max_new_tokens: 4096 },
    note: "Built locally: run `make antares-onnx`. 3.7 GB at fp16 — the largest entry by far.",
  },
  {
    key: "antares-350m",
    label: "Antares 350M (does not follow the protocol)",
    repo: "fdtn-ai/antares-350m-ONNX",
    revision: "cdf6d054fa5f491553ccb1704269cbd1954c6c6e",
    dtypes: ["fp16"],
    approxBytes: 911_780_067,
    contextTokens: 32_768,
    dialect: "antares",
    local: true,
    task: "localize",
    generation: { do_sample: true, temperature: 0.3, top_p: 1.0, max_new_tokens: 4096 },
    // Listed rather than dropped because "we tried the small one" is worth
    // recording where someone will look for it: at fp32, temperature 0 and 0.3,
    // against the exact CLI prompt, it produces fluent reasoning and then loops
    // without ever emitting a tool call (PLAN §11.10). Its conversion is
    // verified; its behaviour is not usable.
    note: "Converts and runs, but never emits a tool call. Kept for comparison — use 1B.",
  },
];

export const DEFAULT_MODEL_KEY = "lfm2-1.2b-tool";

export function modelFor(key: string): ModelEntry {
  const entry = models.find((m) => m.key === key);
  if (!entry) {
    throw new Error(`unknown model key: ${key} (known: ${models.map((m) => m.key).join(", ")})`);
  }
  return entry;
}

/**
 * The first candidate dtype the adapter can run.
 *
 * Returns undefined when none are supported, which is a real outcome worth
 * surfacing rather than falling back to something that will fail deep inside
 * onnxruntime with an opaque message.
 */
export function pickDtype(entry: ModelEntry, adapterFeatures: ReadonlySet<string>): Dtype | undefined {
  return entry.dtypes.find((d) => !F16_DTYPES.has(d) || adapterFeatures.has("shader-f16"));
}

// Files every transformers.js model needs, and the ones that only some repos
// carry. Discovering them per repo beats hardcoding a list per entry: LFM2
// splits its weights into an external .onnx_data blob and Qwen does not, and
// chat templates live in tokenizer_config.json for some repos and in a
// standalone .jinja for others.
export const REQUIRED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];

export const OPTIONAL_FILES = [
  "generation_config.json",
  "special_tokens_map.json",
  "chat_template.jinja",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "preprocessor_config.json",
  "quantize_config.json",
];

/** The weight files for one quantization; the `_data` blob may not exist. */
export function weightFiles(dtype: Dtype): { required: string[]; optional: string[] } {
  return {
    required: [`onnx/model_${dtype}.onnx`],
    optional: [`onnx/model_${dtype}.onnx_data`],
  };
}
