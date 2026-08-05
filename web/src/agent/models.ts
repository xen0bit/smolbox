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
export type Dtype = "q4" | "q4f16" | "fp16" | "q8";

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
