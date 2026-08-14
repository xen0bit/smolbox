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
 * that was right for a spike. It is wrong for some checkpoints: Gemma 4 at
 * temperature 0 makes its first tool call perfectly and then answers <eos>
 * forever once a result comes back (PLAN §10.15). An entry that needs sampling
 * has to say so.
 *
 * `frequency_penalty` is deliberately absent: transformers.js has no additive
 * frequency penalty, only a multiplicative `repetition_penalty`, which is a
 * different function. Recording the gap beats substituting a lookalike.
 * `repetition_penalty` itself is here because LFM2.5 asks for exactly that
 * function, at 1.1 — no substitution involved.
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
  /**
   * Where generation must stop, when the checkpoint's own config is wrong.
   *
   * Normally this stays absent: transformers.js reads `eos_token_id` from
   * generation_config.json and that is the checkpoint's business, not ours.
   * Gemma 4 is the example of it going right — its file already lists
   * `[1, 106, 50]`, the three ids a chat turn can legitimately end on.
   *
   * It goes wrong when an export carries the BASE model's EOS into a chat
   * checkpoint. Qwen3.5's generation_config says `248044`, which is
   * `<|endoftext|>`; its chat template ends every assistant turn with
   * `<|im_end|>` (248046), and tokenizer_config.json agrees that is the eos.
   * Nothing stops at 248044 in a conversation, so the model finished its turn,
   * sailed past the boundary and wrote the *user's* next message, a `<think>`
   * block and a fabricated `<tool_response>` full of invented output — a
   * failure that reads like hallucination and is actually a two-id mismatch
   * (PLAN §10.20).
   *
   * Set it only against the tokenizer, never by guessing: the ids differ per
   * checkpoint and a wrong one either never fires or truncates every turn.
   */
  eos_token_id?: number | number[];
}

/**
 * Which engine runs this checkpoint.
 *
 * `transformers` is onnxruntime-web through transformers.js — the path every
 * entry took until Gemma 4. `gemma4-kernels` is the hand-written WebGPU engine
 * from the webml-community/gemma-4-webgpu-kernels Space, which reads safetensors
 * directly and carries its own WGSL. They share nothing but the ModelClient
 * interface, which is the point: the loop, the dialects and the UI cannot tell
 * them apart.
 */
export type Backend = "transformers" | "gemma4-kernels";

/**
 * How the weights are laid out in the repo, for the fetcher.
 *
 * `onnx` is `onnx/model_<dtype>.onnx` plus its optional external data blob.
 * `safetensors` is a plain `model.safetensors` at the root, with the
 * quantization baked into the checkpoint rather than chosen at load time.
 */
export type WeightLayout = "onnx" | "safetensors";

export interface ModelEntry {
  key: string;
  label: string;
  repo: string;
  /** Pinned commit sha. A moving `main` would make M8's findings unreproducible. */
  revision: string;
  /**
   * The checkpoint's vocabulary size, straight from its config.json.
   *
   * This is not trivia: most exports in this registry emit full-sequence logits,
   * so it is the multiplier in the prefill allocation — and therefore what
   * decides how many tokens go through the forward pass at a time. See
   * {@link prefillChunkTokens}.
   */
  vocabSize: number;
  /**
   * Candidate quantizations, best first. The page picks the first one the
   * adapter can actually run: f16 variants need the `shader-f16` feature, which
   * no browser on this machine exposes (PLAN §2.11.24, §10.14) but other GPUs
   * and platforms do.
   */
  dtypes: Dtype[];
  approxBytes: number;
  contextTokens: number;
  dialect: DialectName;
  note?: string;
  /** Sampling this checkpoint needs. Absent means the page's defaults are fine. */
  generation?: GenerationDefaults;
  /** Which engine runs it. Absent means transformers.js, as everything did. */
  backend?: Backend;
  /**
   * The ONNX files that make up one model. Absent means a single `model.onnx`.
   *
   * Most exports here are one graph. Multimodal checkpoints are exported as
   * several: Gemma 4 ships `embed_tokens` (the per-layer embeddings, which for
   * this architecture are most of the weights) and `decoder_model_merged`,
   * plus vision and audio encoders that a text-only load never touches.
   * transformers.js picks the sessions itself from the config — this list exists
   * so the *fetcher* knows what to pull, since it cannot ask the library.
   *
   * Order matters only for readable logs.
   */
  components?: string[];
  /**
   * How much of the logits tensor a prefill produces.
   *
   * `"sequence"` (the default) is the `[batch, sequence_length, vocab_size]`
   * shape that PREFILL_CHUNK_BUDGET_BYTES exists to bound. `"last"` means the
   * export only ever materializes the final position — either because the graph
   * takes `num_logits_to_keep` (Gemma 4's does) or because the engine samples on
   * the GPU and never downloads one at all. Chunking those would buy nothing and
   * cost a forward pass per chunk, so they are prefilled in one go.
   */
  prefillLogits?: "sequence" | "last";
  /**
   * WebGPU adapter features the engine needs, beyond the dtype question.
   *
   * `dtypes` answers "which file do we load"; this answers "can this engine run
   * here at all". They are separate because an engine can have no file choice
   * and still have hard requirements. The value of declaring one is that an
   * engine which selects WGSL variants against the device otherwise fails late:
   * the load succeeds, the weights stream onto the GPU, and the FIRST forward
   * pass dies with "No supported WebGPU variant" — gigabytes and seconds spent
   * to reach a refusal that was knowable up front.
   *
   * No entry currently sets it. The Gemma kernel entry did, for `shader-f16`,
   * and that was wrong in an instructive way: the requirement was the engine's
   * own dtype choice rather than the adapter's limit, so it could be rewritten
   * away (see kernel-f32.ts, PLAN §10.17). Before adding one here, check which
   * of the two you are actually looking at.
   */
  requiresFeatures?: string[];
  /**
   * Per-dtype size of the single `.onnx` file, for builds with no sidecar.
   *
   * Only needed where a build keeps its weights INLINE in the graph file. A
   * checkpoint with a `.onnx_data` sidecar streams and has no such limit — Gemma
   * 4's 3.6 GB loads fine — so those entries leave this unset.
   *
   * Present so {@link pickDtype} can skip a build the browser cannot load,
   * exactly as it skips f16 on an adapter without the feature. Both are the same
   * question ("can this environment run this file?") and both are better
   * answered before the download than after it. See
   * {@link INLINE_WEIGHT_CEILING_BYTES}.
   */
  inlineBytes?: Partial<Record<Dtype, number>>;
  /** How its weights are laid out in the repo. Absent means the ONNX layout. */
  weights?: WeightLayout;
  /**
   * What has to be built locally before this entry can run, and why.
   *
   * Absent for everything the browser can load unaided, which is almost all of
   * it: every repo here serves its files anonymously from huggingface.co with
   * CORS at the pinned revision, checked by HEAD rather than assumed — including
   * the Google one, which is not gated.
   *
   * Present when something OTHER than the weights has to come off this origin.
   * The Gemma kernel entry is the case: its 2.46 GB of safetensors are on the
   * hub and the engine reads them from there quite happily, but the engine
   * itself is a dynamic import of /kernels/gemma4/gemma-4-e2b.js, which exists
   * only after `make gemma-kernels`. It is not vendored and cannot be served
   * from the hub by the page: the Space that publishes it declares no license
   * (web/fetch-kernels.ts), and this page is cross-origin isolated, so a
   * cross-origin module import would need CORP headers nobody has promised.
   *
   * The string is shown to whoever hits the limit, so write it as an answer
   * rather than a flag name. See unavailableReason() in model-source.ts, which
   * is what keeps these entries out of the dropdown on a hub build.
   */
  requiresLocalBuild?: string;
}

/** Quantizations that need `shader-f16` on the adapter. */
export const F16_DTYPES: ReadonlySet<Dtype> = new Set<Dtype>(["q4f16", "fp16"]);

/**
 * The largest `.onnx` a browser can load with its weights inline.
 *
 * Two walls stacked, and neither is the GPU. transformers.js reads a weight file
 * into ONE Uint8Array before onnxruntime sees any of it, and onnxruntime then
 * builds the session inside the wasm heap. Measured here, all single-file
 * (PLAN §10.18):
 *
 * | file | result |
 * |---|---|
 * | 786 MB — Qwen2.5 0.5B q4 | loads and runs |
 * | 1.43 GB — Qwen3 1.7B q4f16 | `Can't create a session`, std::bad_alloc |
 * | 1.74 GB — Qwen3 1.7B q8 | std::bad_alloc |
 * | 1.82 GB — a single-file fp32 export | std::bad_alloc |
 * | 2.15 GB — Qwen3 1.7B q4 | `RangeError` out of readResponse |
 *
 * Set between the largest that works and the smallest that does not. It is a
 * property of the runtime rather than of this machine — nothing here scales with
 * GPU memory, which is why a 16 GB card does not move it.
 *
 * The fix for a build over this line is a sidecar, not a smaller quantization:
 * that same 1.82 GB graph, re-saved with external data, loaded in 8.0 s and
 * generated.
 */
export const INLINE_WEIGHT_CEILING_BYTES = 1_000_000_000;

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
    // only one that runs headless. q4f16 is smaller (1.53 GB) but needs
    // shader-f16, which is the whole of the reason — an earlier version of this
    // comment also claimed its two .onnx_data shards were "only handled by the
    // hub path", and that was wrong in both halves. transformers.js reads the
    // shard COUNT from this repo's config.json
    // (`transformers.js_config.use_external_data_format` says `model_q4f16.onnx: 2`),
    // names them `.onnx_data` and `.onnx_data_1`, and fetches each through the
    // same getModelFile() that serves local and hub alike — nothing in
    // utils/model-loader.js branches on where the files come from. weightFiles()
    // below probes the same names as optional files, so `make model
    // MODEL="lfm2.5-2.6b --dtype q4f16"` pulls both shards too.
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
    key: "qwen3.5-0.8b",
    label: "Qwen3.5 0.8B (text)",
    // The TEXT export, not the headline one. onnx-community publishes both:
    // Qwen3.5-0.8B-ONNX is Qwen3_5ForConditionalGeneration and ships a vision
    // encoder, so a text-only load would fetch embed_tokens + decoder as
    // separate graphs. This repo is Qwen3_5ForCausalLM — one graph, no
    // `components`, nothing downloaded that a chat never touches.
    repo: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    revision: "1e45daba048899e7f771657ada617ec49350aa91",
    vocabSize: 248_320,
    // Verified by parsing the graph, not inferred from the architecture: the
    // q4 export declares `num_logits_to_keep` as an input, which is the exact
    // name transformers.js tests for before binding 1 to it. Had the export used
    // the newer `logits_to_keep` spelling the library would silently not bind
    // it, the graph would emit full-sequence logits, and this line would be the
    // bug that poisons the device (§10.10). It does not; both were checked.
    prefillLogits: "last",
    // q4 first for the usual reason: it is the variant that runs on an adapter
    // without shader-f16, which is every adapter here.
    dtypes: ["q4", "q4f16"],
    approxBytes: 551_247_327,
    contextTokens: 262_144,
    // `qwen3.5`, not `hermes` — and this entry shipped as `hermes` until a real
    // turn said otherwise (§10.20). Its chat template writes `<tool_call>`, so
    // the markers matched; the body it actually emits is
    // `<function=…><parameter=…>` XML. The card even names the parser
    // (`--tool-call-parser qwen3_coder`). Markers are not a grammar.
    dialect: "qwen3.5",
    // The card's numbers for thinking mode on text tasks, minus one it asks for
    // that cannot be honoured: `presence_penalty: 1.5`. transformers.js has no
    // presence penalty at all — checked against the bundle, not assumed — and a
    // field it does not implement is spread into generate() and silently
    // ignored, so recording the gap here beats substituting repetition_penalty,
    // which is a different function. Same call as LFM2.5's frequency_penalty.
    generation: {
      do_sample: true,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      max_new_tokens: 2048,
      // Read out of this checkpoint's tokenizer.json, not copied from another
      // entry: <|im_end|> is 248046 here. Without it the export's own
      // generation_config stops only at <|endoftext|> (248044) and the model
      // writes the rest of the conversation itself. See GenerationDefaults.
      eos_token_id: 248_046,
    },
    note: "Verified end to end (§10.20): loads in 3.0 s, calls the tool with the right path, answers from what it read. Its call body is XML rather than JSON — see the qwen3.5 dialect.",
  },
  {
    key: "granite-4.0-h-1b",
    label: "Granite 4.0 H 1B",
    repo: "onnx-community/granite-4.0-h-1b-ONNX",
    revision: "fe3928cdcd09ae5c245c840ffa73589aa0529689",
    vocabSize: 100_352,
    // Same check as the Qwen3.5 entry above, same answer: the graph's input is
    // spelled `num_logits_to_keep`. Its 100 352 vocabulary would survive the
    // pessimistic arithmetic anyway (4012 tokens), so this one buys headroom
    // rather than viability.
    prefillLogits: "last",
    dtypes: ["q4", "q4f16"],
    approxBytes: 1_021_336_558,
    contextTokens: 131_072,
    // hermes, and not by family resemblance: the chat template writes
    // `<tool_call>\n{"name": …, "arguments": …}\n</tool_call>`, which is the
    // grammar hermes.ts already parses. The turn framing differs
    // (<|start_of_role|> rather than <|im_start|>) but that is the chat
    // template's business, applied by transformers.js, not the parser's.
    dialect: "hermes",
    // Measured 2026-08-10, and it behaved better than either of the others: it
    // set `cwd` as well as `cmd` — the only entry that has — and reached for
    // `ls -R`, which is the right instinct. It also wrapped `arguments` as a
    // JSON *string* rather than an object, which parseCallBody already accepts.
    //
    // agent.spec.ts still reports it red, and the failure is OURS: `ls -R` exits
    // 1 on the mount because readdir returns no d_type, so ls opendir()s every
    // regular file and collects an ENOTDIR for each. The listing it printed was
    // complete and the model answered correctly from it. Pinned as a conformance
    // case next to the `find` one; see §10.20.
    note: "Sets cwd as well as cmd and answers correctly. Its preferred `ls -R` exits 1 on the mount for a reason on our side (no d_type), so the agent spec scores it red.",
  },
  {
    key: "lfm2.5-350m",
    label: "LFM2.5 350M",
    repo: "onnx-community/LFM2.5-350M-ONNX",
    revision: "2c07371c2e84776cad597f3d813b7d306d292aea",
    vocabSize: 65_536,
    // Declared "sequence" by omission until the load-time check said otherwise
    // on its first real run: this export takes `num_logits_to_keep`, spelled the
    // way transformers.js binds it. Harmless in the safe direction — it was
    // being chunked for an allocation it never makes — and the check is why
    // anyone found out. Verified in the graph, like the two below it.
    prefillLogits: "last",
    dtypes: ["q4", "q4f16"],
    approxBytes: 293_813_394,
    // The card says 32 768 where config.json says 128 000. The card wins: a
    // context claim that the checkpoint was not trained to honour is the kind of
    // number that turns into a silent quality cliff rather than an error.
    contextTokens: 32_768,
    // `lfm2`, NOT `lfm2.5`, despite the name — the trap this registry's whole
    // curated-rather-than-inferred design exists to catch (§10.2). The card
    // documents Pythonic calls between <|tool_call_start|> and
    // <|tool_call_end|>, which is lfm2.ts exactly; and its chat template ends
    // the generation prompt at `<|im_start|>assistant\n` where the 2.6B ends at
    // `assistant\n<think>`. It does not reason, so lfm2.5's prompt-opened
    // splitThinking would treat a whole answer as scratchpad.
    dialect: "lfm2",
    // The card's numbers. Note repetition_penalty 1.05, not the 2.6B's 1.1.
    generation: {
      do_sample: true,
      temperature: 0.1,
      top_k: 50,
      repetition_penalty: 1.05,
    },
    // Measured 2026-08-10, and the note says which half worked. It emits a
    // clean, parseable call — `[run_terminal_command(cmd="ls")]` — reaches the
    // guest and gets exit 0, so the dialect choice above is confirmed by a real
    // turn. What it does not do is use the path it was given: asked to list
    // /mnt/host it ran bare `ls`, listed `/`, and then described the root
    // filesystem as though it were the user's folder. Same shape as Qwen2.5
    // 0.5B (§10.11) but one step further along — syntax right, target wrong.
    note: "Verifies the loop, not the workflow: emits correct call syntax and reaches the guest, but ignores the path it is given and lists / instead. Smallest entry here at ~294 MB, loads in 1.6 s.",
  },
  {
    key: "gemma4-e2b",
    label: "Gemma 4 E2B (QAT mobile, WebGPU kernels)",
    // The checkpoint the kernel engine is built for: safetensors, no ONNX
    // anywhere, and none needed — this backend reads the tensors itself.
    repo: "google/gemma-4-E2B-it-qat-mobile-transformers",
    revision: "dd693ff40353f057ca5f07e945ad867f4afbf2ec",
    // The largest vocabulary in the registry by a wide margin, and the reason
    // the chunk has to know what a forward pass materializes: charged the
    // full-sequence cost this alone would be prefilled 256 tokens at a time.
    // This backend samples on the GPU (its own argmax kernels) and never
    // downloads a logits tensor, so it declares `prefillLogits: "last"`. See
    // prefillChunkTokens.
    vocabSize: 262_144,
    prefillLogits: "last",
    // Quantization is baked into the checkpoint (QAT), not chosen at load time.
    // The single entry exists because pickDtype is shared; the kernel engine
    // ignores it and selects f32 or f16 kernel variants against the adapter.
    dtypes: ["q4"],
    approxBytes: 2_458_111_846,
    contextTokens: 131_072,
    dialect: "gemma4",
    backend: "gemma4-kernels",
    weights: "safetensors",
    // The only entry a hub-only build cannot offer, and not because of its
    // weights: those are on the hub, ungated, and the engine reads them straight
    // from there. It is the ENGINE that has to be local. See requiresLocalBuild.
    requiresLocalBuild:
      "its WebGPU kernel engine is served from this origin rather than the hub — " +
      "build with SMOLBOX_MODEL_SOURCE=local after `make gemma-kernels`",
    // No requiresFeatures. This entry declared `shader-f16` from M12 to §10.17
    // on the strength of a true observation — every variant of
    // com.xenova.gemma4.DenseGemv is guarded on it — and a false inference from
    // it, that the checkpoint's tensors are f16 and so the guard could never
    // pass here. The checkpoint has no f16 tensors at all (F32/BF16/I8/U8), the
    // guards exclude f16 *tensors* rather than the op, and the engine's f16 came
    // from three hardcoded dtype choices in its model builder. kernel-f32.ts
    // rewrites those three on adapters that lack the feature, so this backend
    // now runs wherever WebGPU does. PLAN §10.17.
    note: "Runs on the webml-community WebGPU kernels rather than onnxruntime. Needs `make gemma-kernels` for the engine and `make model MODEL=gemma4-e2b` for the weights.",
  },
  {
    key: "gemma4-e2b-onnx",
    label: "Gemma 4 E2B (ONNX)",
    // The same model as gemma4-e2b, on the engine everything else here uses.
    // Two entries rather than one because they are genuinely different builds:
    // this one is 3.6 GB through onnxruntime, the kernel one is 2.3 GB through
    // hand-written WGSL and measured 3.4x faster on the same spec and machine
    // (PLAN §10.17). Both now run on any WebGPU adapter, so the choice is cost,
    // not capability — this entry stays because onnxruntime is the path every
    // other model here takes, and losing the comparison would cost more than
    // keeping 3.6 GB of weights.
    repo: "onnx-community/gemma-4-E2B-it-ONNX",
    revision: "9f4bef82ea6e296bc69f8a2f5939f73af81b07a6",
    vocabSize: 262_144,
    // The export takes `num_logits_to_keep` and transformers.js passes 1, so a
    // prefill materializes one row of 262 144 logits rather than one per token.
    // Verified in the graph, not assumed from the architecture.
    prefillLogits: "last",
    // The checkpoint is `any-to-any`, so it is exported as four graphs. Loading
    // it through AutoModelForCausalLM against a config whose architecture is
    // `Gemma4ForConditionalGeneration` puts transformers.js on its text-only
    // path, which builds exactly two sessions: embed_tokens and
    // decoder_model_merged. The vision and audio encoders are never fetched.
    components: ["embed_tokens", "decoder_model_merged"],
    dtypes: ["q4f16", "q4"],
    // q4: 1.86 GB of decoder + 1.76 GB of embeddings. The embeddings are that
    // large because this architecture keeps per-layer embeddings for all 35
    // layers over a 262 144-token vocabulary — for E2B they outweigh the decoder.
    approxBytes: 3_628_000_000,
    contextTokens: 131_072,
    dialect: "gemma4",
    // The checkpoint's own generation_config.json, not tuning: do_sample true,
    // temperature 1.0, top_k 64, top_p 0.95. It matters here — run greedily,
    // this model answers the FIRST turn correctly and then emits nothing but
    // <eos> once the tool result comes back (measured). Its stop set is already
    // right in the same file: [1, 106, 50] is <eos>, <turn|> and <|tool_response>,
    // so generation halts the moment it starts inventing a tool response.
    generation: {
      do_sample: true,
      temperature: 1.0,
      top_k: 64,
      top_p: 0.95,
      max_new_tokens: 2048,
    },
    note: "Same model as the kernel build, on onnxruntime — measured ~3.4x slower and ~1.3 GB larger. Kept as the reference path. Large: ~3.6 GB at q4.",
  },
];

export const DEFAULT_MODEL_KEY = "lfm2.5-2.6b";

// --------------------------------------------------------- the prefill chunk
//
// Every ONNX export in this registry declares its logits output as
// `[batch_size, sequence_length, vocab_size]` — the FULL sequence, not just the
// last position. onnxruntime-web has to map that tensor back to the CPU to
// sample from it, so one prefill of N tokens allocates
//
//     N * vocab_size * 4 bytes
//
// of host-visible memory. Measured on a 16 GB adapter with LFM2.5 2.6B at q4
// (vocab 128000): ~16 k chars of history (~2.15 GB of logits) prefills fine,
// ~24 k (~3.07 GB) dies inside Dawn with "Failed to allocate memory for buffer
// mapping", after which every later run fails with "invalid due to a previous
// error" — the device is poisoned and the chat is over (PLAN §10.10).
//
// From M9 to §10.20 the answer was to bound N: divide a 1.5 GiB budget by the
// vocabulary and refuse any prompt over the quotient. That works and it caps the
// conversation — LFM2.5 2.6B was held to ~3145 prompt tokens of a 128 000-token
// context — and it never stopped guessing, because the number it needs is the
// device's TOTAL residency (weights, KV cache, activations, and this tensor) on
// this browser and this adapter, which no arithmetic over `vocab_size` can
// produce. Firefox proved that by dying inside a budget Chromium survived
// (§10.16).
//
// So N is no longer a function of the conversation. The model worker feeds the
// prompt to the forward pass in chunks and carries the KV cache from one turn to
// the next, so what a prefill materializes is bounded by the chunk size and by
// nothing else — see prefillAndGenerate() in model-worker.ts. This constant is
// what that chunk costs.
//
// 256 MiB, an order of magnitude under the 2.15 GB that was measured working,
// because there is nothing to buy by going higher: a chunk is a batch size, not
// a capability, and the room left over is room for everything in the paragraph
// above that cannot be measured.
export const PREFILL_CHUNK_BUDGET_BYTES = 256 * 1024 ** 2;

/** Logits come back as float32. */
const BYTES_PER_LOGIT = 4;

/**
 * The smallest chunk worth prefilling.
 *
 * A chunk of one token is a per-token prefill, which is decode speed applied to
 * a prompt — correct, and slow enough to look broken. A vocabulary large enough
 * to push the arithmetic below this is better served by an export that
 * materializes one position (`prefillLogits: "last"`), so the floor holds and
 * the chunk is allowed to cost more than the budget says.
 */
export const MIN_PREFILL_CHUNK_TOKENS = 64;

/**
 * A working ceiling for the chat loop, independent of any engine limit.
 *
 * Judgement rather than a constraint: an engine with a 131 072-token context
 * would let the history grow until every turn re-prefills a novel, and "correct
 * but takes a minute" is its own kind of broken. Since the chunk above took over
 * bounding the allocation, this is the only thing bounding the prompt, so it is
 * the number a user who wants longer conversations should raise — the settings
 * panel can, and what it costs is time rather than the device.
 */
export const AGENT_WORKING_TOKENS = 8192;

/**
 * How many prompt tokens to feed the forward pass at once.
 *
 * The chunk exists so that the logits tensor a prefill materializes stays the
 * same size whatever the conversation does. Entries that never materialize it
 * are not charged for it: the Gemma kernel engine samples on the GPU with its
 * own argmax kernels and never downloads logits, and an export that takes
 * `num_logits_to_keep` produces only the final position, which transformers.js
 * asks for. Chunking either would be pure overhead — several forward passes
 * where one would do — so they get the whole prompt in one go.
 */
export function prefillChunkTokens(
  entry: ModelEntry,
  budgetBytes: number = PREFILL_CHUNK_BUDGET_BYTES,
): number {
  if (entry.prefillLogits === "last") {
    return AGENT_WORKING_TOKENS;
  }
  const fits = Math.floor(budgetBytes / (entry.vocabSize * BYTES_PER_LOGIT));
  return Math.min(AGENT_WORKING_TOKENS, Math.max(MIN_PREFILL_CHUNK_TOKENS, fits));
}

/**
 * How long a prompt this checkpoint will be given.
 *
 * A context and latency clamp, and no longer a memory one: what a prefill
 * allocates is the chunk's business now, so the only questions left are how many
 * positions the checkpoint has and how long a turn anyone wants to wait for.
 *
 * The worker still enforces it with the real tokenizer, and the loop still
 * elides to it. Both are worth keeping — a prompt past the context window is a
 * real thing to refuse, and the `prompt-too-long` and `device-lost` paths remain
 * the only recovery from a device that runs out for a reason chunking cannot
 * answer (see PREFILL_CHUNK_BUDGET_BYTES).
 */
export function maxPromptTokens(entry: ModelEntry): number {
  return Math.min(entry.contextTokens, AGENT_WORKING_TOKENS);
}

/**
 * The same ceiling in characters, for the loop's character-counted budgets.
 *
 * The loop counts characters because the tokenizer lives in the worker and a
 * synchronous, deterministic number is worth more there than an exact one
 * (see conversation.ts). The conversion is therefore an estimate, and the exact
 * check still happens in the worker, which does have the tokenizer.
 */
export function maxPromptChars(entry: ModelEntry): number {
  return maxPromptTokens(entry) * CHARS_PER_TOKEN_ESTIMATE;
}

/**
 * What this checkpoint asks to be sampled with, with the registry-wide default
 * filled in.
 *
 * The settings panel needs a concrete value to show and a concrete value to
 * reset to, and "absent" is not one — an entry with no `generation` block runs
 * greedy, which is the same thing the worker falls back to.
 */
export function generationDefaults(entry: ModelEntry): GenerationDefaults {
  return entry.generation ?? { do_sample: false };
}

export function modelFor(key: string): ModelEntry {
  const entry = models.find((m) => m.key === key);
  if (!entry) {
    throw new Error(`unknown model key: ${key} (known: ${models.map((m) => m.key).join(", ")})`);
  }
  return entry;
}

/**
 * Every reason a dtype cannot run here. Empty means it can.
 *
 * All of them, not the first, because the two causes are independent and need
 * opposite responses: a missing adapter feature means try another machine, an
 * oversized inline file means the build needs re-exporting and no machine will
 * help. Qwen3 1.7B's q4f16 had both — reporting only the feature, as an earlier
 * cut of this did, sent the reader hunting for a GPU that would not fix it. That
 * entry has since been removed as unloadable (§10.19), but a build with both
 * problems is the case this shape exists for, so both paths stay covered by
 * synthetic fixtures in models.test.ts rather than by whatever is shipped today.
 */
export function dtypeBlockers(
  entry: ModelEntry,
  dtype: Dtype,
  adapterFeatures: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  const inline = entry.inlineBytes?.[dtype];
  // Size first: it is the one no hardware change can answer, so it is the one
  // that should lead.
  if (inline !== undefined && inline > INLINE_WEIGHT_CEILING_BYTES) {
    reasons.push(
      `${dtype} is a single ${(inline / 1e9).toFixed(2)} GB .onnx, over the ` +
        `${(INLINE_WEIGHT_CEILING_BYTES / 1e9).toFixed(1)} GB a browser can load with weights ` +
        `inline — it needs re-exporting with external data, not a different GPU`,
    );
  }
  if (F16_DTYPES.has(dtype) && !adapterFeatures.has("shader-f16")) {
    reasons.push(`${dtype} needs the shader-f16 WebGPU feature, which this adapter does not expose`);
  }
  return reasons;
}

/**
 * The first candidate dtype this environment can actually run.
 *
 * Returns undefined when none are, which is a real outcome worth surfacing
 * rather than falling back to something that will fail deep inside onnxruntime
 * with an opaque message — `std::bad_alloc` after a 1.4 GB download being the
 * case that motivated the size half of this (PLAN §10.18).
 */
export function pickDtype(entry: ModelEntry, adapterFeatures: ReadonlySet<string>): Dtype | undefined {
  return entry.dtypes.find((d) => dtypeBlockers(entry, d, adapterFeatures).length === 0);
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
 * the standalone file; the two LFM2 repos do not have it.
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

/**
 * How many external-data shards to look for per component.
 *
 * A graph too large for one protobuf spills its tensors into `.onnx_data`, and
 * one too large for *that* keeps going: `.onnx_data_1`, `.onnx_data_2`, and so
 * on. The count is a property of the export, published in the repo's
 * `transformers.js_config.use_external_data_format` — but the fetcher would then
 * have to read a config to know what to fetch, and the registry would carry a
 * number that silently rots against a pinned revision. Probing instead is
 * self-describing: shards are optional files, and a 404 means there are no more.
 *
 * 8 is a ceiling, not an expectation. The largest here is Gemma 4's fp32 decoder
 * at 5. A `weightFiles` test pins that so a future export that needs more fails
 * loudly rather than downloading a model with a hole in it.
 */
export const MAX_EXTERNAL_DATA_SHARDS = 8;

/**
 * The weight files for one quantization; every `_data` shard is optional.
 *
 * `safetensors` repos ignore the dtype entirely: the quantization is baked into
 * the checkpoint, so there is one file and no variant to choose.
 *
 * `components` names the ONNX graphs a model is split across, for the exports
 * that are not a single `model.onnx`. Each gets the dtype suffix — Gemma 4's q4
 * build is `embed_tokens_q4.onnx` plus `decoder_model_merged_q4.onnx`, each with
 * their own external data.
 */
export function weightFiles(
  dtype: Dtype,
  layout: WeightLayout = "onnx",
  components: readonly string[] = ["model"],
): { required: string[]; optional: string[] } {
  if (layout === "safetensors") {
    return { required: ["model.safetensors"], optional: [] };
  }
  const required: string[] = [];
  const optional: string[] = [];
  for (const component of components) {
    const stem = `onnx/${component}${DTYPE_SUFFIX[dtype]}`;
    required.push(`${stem}.onnx`);
    optional.push(`${stem}.onnx_data`);
    for (let shard = 1; shard < MAX_EXTERNAL_DATA_SHARDS; shard++) {
      optional.push(`${stem}.onnx_data_${shard}`);
    }
  }
  return { required, optional };
}

/**
 * Files the Gemma kernel engine reads that the ONNX path does not ask for.
 *
 * It needs `config.json` to build its kernel plan and `generation_config.json`
 * for the EOS ids (it falls back to a hardcoded pair without one), on top of the
 * tokenizer files everything needs. Taken from the bundle's own resource reads,
 * not guessed.
 */
export const SAFETENSORS_EXTRA_FILES = ["config.json", "generation_config.json"];
