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

/**
 * Characters per token, near enough for a budget.
 *
 * The loop counts characters rather than tokens because the tokenizer lives in
 * the model worker and a synchronous, deterministic number is worth more to a
 * guardrail than an exact one. Roughly 4 for these vocabularies; it lives here
 * rather than in the loop because it is a property of the tokenizers this
 * registry pins, and the prefill ceiling below is its other consumer.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

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
 * substituting a lookalike. `repetition_penalty` itself is here because LFM2.5
 * asks for exactly that function, at 1.1 — no substitution involved.
 *
 * Every field is spread straight into `model.generate()`, so a name that
 * transformers.js does not implement would be silently ignored. Only add one
 * after checking it exists in its GenerationConfig.
 */
export interface GenerationDefaults {
  do_sample: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  max_new_tokens?: number;
}

export interface ModelEntry {
  key: string;
  label: string;
  repo: string;
  /** Pinned commit sha. A moving `main` would make M8's findings unreproducible. */
  revision: string;
  /**
   * The checkpoint's vocabulary size, straight from its config.json.
   *
   * This is not trivia: every export in this registry emits full-sequence
   * logits, so it is the multiplier in the prefill allocation that decides how
   * long a prompt the adapter can take. See {@link PREFILL_LOGITS_BUDGET_BYTES}.
   */
  vocabSize: number;
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
    vocabSize: 65_536,
    // q4 first deliberately: it is the variant M8 measured and the only one
    // that runs headless, which is where the opt-in GPU suite runs.
    dtypes: ["q4", "q4f16"],
    approxBytes: 1_217_650_688,
    contextTokens: 128_000,
    dialect: "lfm2",
    note: "Purpose-built for tool use. The only entry verified end to end (M8).",
  },
  {
    key: "lfm2.5-2.6b",
    label: "LFM2.5 2.6B",
    // Liquid's own ONNX build, not onnx-community's: the vendor publishes this
    // one itself, so it is the same provenance as the weights it converts.
    repo: "LiquidAI/LFM2.5-2.6B-ONNX",
    revision: "66826372fd4fa166f53be0371c9315745c07cace",
    // Twice LFM2's vocabulary, which is the whole reason this entry needs a
    // tighter prompt budget than the one that came before it.
    vocabSize: 128_000,
    // q4 first, as for the 1.2B: it is the variant `make model` pulls and the
    // only one that runs headless. q4f16 is smaller (1.53 GB) but splits its
    // weights across two .onnx_data shards, which only the hub path handles.
    dtypes: ["q4", "q4f16"],
    approxBytes: 1_854_562_304,
    contextTokens: 128_000,
    dialect: "lfm2.5",
    // The card's numbers, not this project's guesses. The token budget is ours:
    // the model reasons before every answer, so the loop's 512 default would
    // routinely stop generation mid-thought and never reach the answer.
    generation: {
      do_sample: true,
      temperature: 0.1,
      top_k: 50,
      repetition_penalty: 1.1,
      max_new_tokens: 2048,
    },
    note: "Agentic post-training, 128k context. Reasons before every answer, so a turn takes longer and its <think> block is hidden.",
  },
  {
    key: "qwen2.5-0.5b-instruct",
    label: "Qwen2.5 0.5B Instruct",
    repo: "onnx-community/Qwen2.5-0.5B-Instruct",
    revision: "cc5cc01a65cc3ff17bdb73a7de33d879f62599b0",
    vocabSize: 151_936,
    dtypes: ["q4", "q4f16"],
    approxBytes: 786_200_000,
    contextTokens: 32_768,
    dialect: "hermes",
    // Measured 2026-08-06: it emits well-formed <tool_call> JSON — which is what
    // promoted the hermes dialect — but at 0.5B it routinely names a tool that
    // does not exist (`ls`, `find`) instead of the one it was given, then
    // apologises for having no tools. Useful for exercising the page, not for
    // driving the VM. Kept because "we tried the small one" belongs where
    // someone will look for it.
    note: "Verifies the dialect, not the workflow: it emits correct call syntax but usually invents a tool name instead of using the one it has.",
  },
  {
    key: "qwen3-1.7b",
    label: "Qwen3 1.7B",
    repo: "onnx-community/Qwen3-1.7B-ONNX",
    revision: "cc6a06a21d614e9b8e92a6adfab1074d4e7d2438",
    // The largest vocabulary here, so the tightest prompt budget.
    vocabSize: 151_936,
    // ONE candidate, and the only entry here that offers no non-f16 path. Both
    // alternatives were measured on a 16 GB RTX 4070 Ti SUPER and both fail
    // before a single token, because this checkpoint publishes every variant as
    // one undivided .onnx:
    //
    //   q4 (2.147 GB) — transformers.js reads a weight file into a single
    //     Uint8Array before onnxruntime sees it: "RangeError: Array buffer
    //     allocation failed" out of readResponse.
    //   q8 (1.742 GB, model_quantized.onnx) — reads fine, then onnxruntime
    //     cannot build a session inside the wasm heap: "Can't create a session.
    //     ERROR_CODE: 6, std::bad_alloc".
    //
    // Listing either would be offering a choice that cannot work. q4f16
    // (1.43 GB) does, so it is the entry — and because it needs `shader-f16`,
    // which headless Chromium does not expose (PLAN §2.11.24), pickDtype
    // returns undefined there and the page says so instead of failing deep
    // inside ORT. That is the honest shape of this checkpoint in a browser.
    dtypes: ["q4f16"],
    approxBytes: 1_430_000_000,
    // 40960 at the pinned revision, not the 32768 this entry claimed.
    contextTokens: 40_960,
    dialect: "hermes",
    note: "Emits <think> blocks. Needs shader-f16: its other builds are single files too large for the wasm heap, so there is no fallback.",
  },
  {
    key: "antares-1b",
    label: "Antares 1B (vulnerability localization)",
    // Built by `make antares-onnx`, not downloaded. The revision pins the
    // SOURCE checkpoint the local build came from, which is the only thing that
    // makes a locally-built artifact reproducible.
    repo: "fdtn-ai/antares-1b-ONNX",
    revision: "10417eb35641b32e7141157db19c76eb545193b6",
    vocabSize: 100_352,
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
    vocabSize: 100_352,
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

// ------------------------------------------------------- the prefill ceiling
//
// Every ONNX export in this registry declares its logits output as
// `[batch_size, sequence_length, vocab_size]` — the FULL sequence, not just the
// last position. onnxruntime-web has to map that tensor back to the CPU to
// sample from it, so one prefill of N tokens allocates
//
//     N * vocab_size * 4 bytes
//
// of host-visible memory, and a chat that grows by a tool result each round
// walks straight into it. Measured on a 16 GB adapter with LFM2.5 2.6B at q4
// (vocab 128000): ~16 k chars of history prefills fine, ~24 k dies inside Dawn
// with "Failed to allocate memory for buffer mapping", after which every later
// run fails with "invalid due to a previous error" — the device is poisoned and
// the chat is over. That is the bug this budget exists to prevent.
//
// It is also why LFM2 1.2B never showed it: same loop, same budgets, half the
// vocabulary, so half the allocation.
//
// 1.5 GiB is chosen against that measurement, not from a spec: the 2.15 GB
// prefill worked, the 3.07 GB one did not, and the survivor is not a target to
// aim at. Decode is unaffected — it prefills one token at a time.
export const PREFILL_LOGITS_BUDGET_BYTES = 1.5 * 1024 ** 3;

/** Logits come back as float32. */
const BYTES_PER_LOGIT = 4;

/**
 * How many prompt tokens this checkpoint can prefill inside the budget.
 *
 * Clamped by the model's own context window, because a budget that permitted
 * more tokens than the checkpoint has positions for would be a lie.
 */
export function maxPromptTokens(
  entry: ModelEntry,
  budgetBytes: number = PREFILL_LOGITS_BUDGET_BYTES,
): number {
  return Math.min(entry.contextTokens, Math.floor(budgetBytes / (entry.vocabSize * BYTES_PER_LOGIT)));
}

/**
 * The same ceiling in characters, for the loop's character-counted budgets.
 *
 * The loop counts characters because the tokenizer lives in the worker and a
 * synchronous, deterministic number is worth more there than an exact one
 * (see conversation.ts). The conversion is therefore an estimate, and the exact
 * check still happens in the worker, which does have the tokenizer.
 */
export function maxPromptChars(
  entry: ModelEntry,
  budgetBytes: number = PREFILL_LOGITS_BUDGET_BYTES,
): number {
  return maxPromptTokens(entry, budgetBytes) * CHARS_PER_TOKEN_ESTIMATE;
}

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

/**
 * Where the dev server mirrors `dist/models`. The worker sets
 * `env.localModelPath` from this, so the path the fetcher writes to and the
 * paths the page reads from stay one decision.
 */
export const LOCAL_MODEL_PATH = "/models/";

/**
 * The chat template, when a repo keeps it out of tokenizer_config.json.
 *
 * transformers.js only reads an inline `chat_template` — the standalone file is
 * loaded by Processor (multimodal) and never by AutoTokenizer, so a repo that
 * ships only this one makes apply_chat_template throw. Newer HF exports prefer
 * the standalone file, which is why the locally-built Antares has it and the
 * two LFM2 repos do not.
 */
export const CHAT_TEMPLATE_FILE = "chat_template.jinja";

/** Where to read {@link CHAT_TEMPLATE_FILE} from, mirroring how weights load. */
export function chatTemplateUrl(entry: ModelEntry, local: boolean): string {
  return local
    ? `${LOCAL_MODEL_PATH}${entry.repo}/${CHAT_TEMPLATE_FILE}`
    : `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${CHAT_TEMPLATE_FILE}`;
}

export const OPTIONAL_FILES = [
  "generation_config.json",
  "special_tokens_map.json",
  CHAT_TEMPLATE_FILE,
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "preprocessor_config.json",
  "quantize_config.json",
];

/**
 * The file suffix transformers.js gives each quantization.
 *
 * Mirrors its DEFAULT_DTYPE_SUFFIX_MAPPING, and is not the identity: `q8` reads
 * `model_quantized.onnx` and `fp32` reads a bare `model.onnx`. Deriving the name
 * as `model_${dtype}.onnx` — which this did — happens to be right for exactly
 * the three dtypes the registry used, and would have 404'd the moment a fourth
 * was added. The loader and the fetcher must name the same file.
 */
const DTYPE_SUFFIX: Record<Dtype, string> = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  q4: "_q4",
  q4f16: "_q4f16",
};

/** The weight files for one quantization; the `_data` blob may not exist. */
export function weightFiles(dtype: Dtype): { required: string[]; optional: string[] } {
  const stem = `onnx/model${DTYPE_SUFFIX[dtype]}`;
  return {
    required: [`${stem}.onnx`],
    optional: [`${stem}.onnx_data`],
  };
}
