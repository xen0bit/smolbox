import { describe, expect, test } from "bun:test";

import {
  AGENT_WORKING_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE,
  MAX_EXTERNAL_DATA_SHARDS,
  PREFILL_LOGITS_BUDGET_BYTES,
  dtypeBlockers,
  models,
  maxPromptChars,
  maxPromptTokens,
  modelFor,
  pickDtype,
  weightFiles,
} from "./models.ts";

describe("model registry", () => {
  test("every entry declares the fields the page cannot work without", () => {
    for (const m of models) {
      expect(m.vocabSize, `${m.key} has no vocabSize`).toBeGreaterThan(0);
      expect(m.contextTokens, `${m.key} has no contextTokens`).toBeGreaterThan(0);
      expect(m.dtypes.length, `${m.key} offers no quantization`).toBeGreaterThan(0);
      expect(m.revision, `${m.key} is not pinned`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("keys are unique", () => {
    expect(new Set(models.map((m) => m.key)).size).toBe(models.length);
  });

  test("an unknown key names the ones that exist", () => {
    expect(() => modelFor("nope")).toThrow(/known: /);
  });
});

// The ceiling that keeps a prefill from killing the WebGPU device. See
// PREFILL_LOGITS_BUDGET_BYTES for the measurement behind the number.
describe("prefill ceiling", () => {
  test("a prompt at the ceiling fits the logits budget, and one token more does not", () => {
    // Only the exports that pay for a logits download. The Gemma kernel backend
    // samples on the GPU and never maps one back, and Gemma 4's ONNX export
    // materializes one position; the budget is not their constraint and
    // asserting it would be asserting a cost they do not have.
    for (const m of models.filter((e) => e.prefillLogits !== "last")) {
      const bytes = (n: number) => n * m.vocabSize * 4;
      const limit = maxPromptTokens(m);
      expect(bytes(limit), `${m.key} at its ceiling`).toBeLessThanOrEqual(PREFILL_LOGITS_BUDGET_BYTES);
      // Unless something else is the binding constraint — the model's own
      // context window, or the loop's working budget — the logits budget is
      // what stops it, and one token more must not fit.
      if (limit < Math.min(m.contextTokens, AGENT_WORKING_TOKENS)) {
        expect(bytes(limit + 1), `${m.key} one token past its ceiling`).toBeGreaterThan(
          PREFILL_LOGITS_BUDGET_BYTES,
        );
      }
    }
  });

  test("no entry may exceed the loop's working budget, whatever its engine", () => {
    for (const m of models) {
      expect(maxPromptTokens(m), `${m.key}`).toBeLessThanOrEqual(AGENT_WORKING_TOKENS);
    }
  });

  // The whole reason the ceiling asks what a prefill materializes: 262 144
  // entries per token under the logits budget is ~1400 tokens, which is not a
  // usable agent prompt. Both Gemma 4 builds avoid it for different reasons —
  // the kernel engine never downloads logits, the ONNX export only produces the
  // last position — and neither difference is visible from the checkpoint.
  test("a model that materializes one position is not charged for the whole sequence", () => {
    for (const key of ["gemma4-e2b", "gemma4-e2b-onnx"]) {
      const gemma = modelFor(key);
      expect(gemma.vocabSize, key).toBe(262_144);
      expect(gemma.prefillLogits, key).toBe("last");
      expect(maxPromptTokens(gemma), key).toBe(AGENT_WORKING_TOKENS);
      // What the same entry would get if it did pay full-sequence cost.
      expect(maxPromptTokens({ ...gemma, prefillLogits: "sequence" }), key).toBeLessThan(2000);
    }
  });

  test("a bigger vocabulary buys a shorter prompt", () => {
    const lfm2 = modelFor("lfm2-1.2b-tool");
    const lfm25 = modelFor("lfm2.5-2.6b");
    // The relationship that made LFM2 fine and LFM2.5 fatal on the same loop
    // with the same budgets: ~1.95x the vocabulary, so ~1.95x less prompt.
    expect(lfm25.vocabSize).toBeGreaterThan(lfm2.vocabSize);
    expect(maxPromptTokens(lfm25) * lfm25.vocabSize).toBeCloseTo(
      maxPromptTokens(lfm2) * lfm2.vocabSize,
      -6,
    );
  });

  test("the context window caps the budget when it is the smaller of the two", () => {
    const tiny = { ...modelFor("lfm2-1.2b-tool"), contextTokens: 128 };
    expect(maxPromptTokens(tiny)).toBe(128);
  });

  test("chars follow tokens", () => {
    const entry = modelFor("lfm2.5-2.6b");
    expect(maxPromptChars(entry)).toBe(maxPromptTokens(entry) * CHARS_PER_TOKEN_ESTIMATE);
  });

  // The regression this whole mechanism exists for: the loop's old flat
  // 24_000-char default was above what LFM2.5 can prefill, so the default
  // configuration walked into the device error on its own.
  test("LFM2.5's ceiling is below the flat default that used to crash it", () => {
    expect(maxPromptChars(modelFor("lfm2.5-2.6b"))).toBeLessThan(24_000);
  });
});

// The fetcher writes these paths and transformers.js reads them, so a
// disagreement is a 404 at load time on a machine that ran `make model`
// successfully. The expectations mirror its DEFAULT_DTYPE_SUFFIX_MAPPING.
describe("weightFiles", () => {
  test("names the file transformers.js will ask for", () => {
    expect(weightFiles("q4").required).toEqual(["onnx/model_q4.onnx"]);
    expect(weightFiles("q4f16").required).toEqual(["onnx/model_q4f16.onnx"]);
    expect(weightFiles("fp16").required).toEqual(["onnx/model_fp16.onnx"]);
    // The two that are not `model_${dtype}.onnx`.
    expect(weightFiles("q8").required).toEqual(["onnx/model_quantized.onnx"]);
    expect(weightFiles("fp32").required).toEqual(["onnx/model.onnx"]);
  });

  test("the external data blob sits beside its own weights file", () => {
    expect(weightFiles("q8").optional[0]).toBe("onnx/model_quantized.onnx_data");
  });

  // An export too big for one protobuf spills into .onnx_data, and one too big
  // for that keeps numbering. The fetcher probes rather than being told how many
  // there are, so the only thing to pin is that it probes far enough.
  test("shards are probed past the largest export in the registry", () => {
    const { optional } = weightFiles("fp32");
    expect(optional).toContain("onnx/model.onnx_data_4");
    expect(optional.length).toBe(MAX_EXTERNAL_DATA_SHARDS);
    // Gemma 4's fp32 decoder has 5 (`.onnx_data` plus `_data_1..4`).
    expect(MAX_EXTERNAL_DATA_SHARDS).toBeGreaterThanOrEqual(5);
  });

  // Multi-component exports: one dtype suffix, applied per graph, each with its
  // own external data. A single wrong name here is a 404 after a 3.6 GB pull.
  test("a multi-component export names every graph", () => {
    const gemma = modelFor("gemma4-e2b-onnx");
    const { required, optional } = weightFiles("q4", "onnx", gemma.components);
    expect(required).toEqual([
      "onnx/embed_tokens_q4.onnx",
      "onnx/decoder_model_merged_q4.onnx",
    ]);
    expect(optional).toContain("onnx/embed_tokens_q4.onnx_data");
    expect(optional).toContain("onnx/decoder_model_merged_q4.onnx_data");
  });
});

describe("pickDtype", () => {
  test("skips f16 variants on an adapter without shader-f16", () => {
    expect(pickDtype(modelFor("lfm2-1.2b-tool"), new Set())).toBe("q4");
  });

  test("returns undefined when nothing on offer runs here", () => {
    // Synthetic rather than a registry entry: no shipped model is f16-only now,
    // and the rule should outlive whichever ones are.
    const f16Only = { ...modelFor("lfm2-1.2b-tool"), dtypes: ["q4f16" as const] };
    expect(pickDtype(f16Only, new Set())).toBeUndefined();
    expect(pickDtype(f16Only, new Set(["shader-f16"]))).toBe("q4f16");
  });

  test("skips a build too large to load with its weights inline", () => {
    // Qwen3 publishes every variant as one undivided .onnx and the smallest is
    // still 1.43 GB, so no adapter can run it — the feature it also wants is
    // beside the point (PLAN §10.18).
    const qwen3 = modelFor("qwen3-1.7b");
    expect(pickDtype(qwen3, new Set())).toBeUndefined();
    expect(pickDtype(qwen3, new Set(["shader-f16"]))).toBeUndefined();
  });

  test("a bigger dtype wins when it is the one that runs everywhere", () => {
    // Order in `dtypes` is a claim about preference, and pickDtype honours it
    // even when the preferred build is the larger one — being loadable on any
    // adapter beats being small (PLAN §10.18).
    const fp32First = { ...modelFor("lfm2-1.2b-tool"), dtypes: ["fp32" as const, "q4f16" as const] };
    expect(pickDtype(fp32First, new Set())).toBe("fp32");
    expect(pickDtype(fp32First, new Set(["shader-f16"]))).toBe("fp32");
  });
});

describe("dtypeBlockers", () => {
  test("names the adapter feature when that is the only thing missing", () => {
    const reasons = dtypeBlockers(modelFor("lfm2-1.2b-tool"), "q4f16", new Set());
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("shader-f16");
    expect(reasons[0]).not.toContain("external data");
  });

  test("names the size, and says a different GPU will not help", () => {
    const reasons = dtypeBlockers(modelFor("qwen3-1.7b"), "q4f16", new Set(["shader-f16"]));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("1.43 GB");
    expect(reasons[0]).toContain("external data");
    expect(reasons[0]).toContain("not a different GPU");
  });

  test("reports BOTH when a dtype is oversized and needs a feature", () => {
    // Qwen3's q4f16 is the case that matters: reporting only shader-f16 sends
    // the reader after a GPU that would not fix it. Size leads, because it is
    // the reason no hardware change can answer.
    const reasons = dtypeBlockers(modelFor("qwen3-1.7b"), "q4f16", new Set());
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("1.43 GB");
    expect(reasons[1]).toContain("shader-f16");
  });

  test("is empty for a dtype that runs", () => {
    expect(dtypeBlockers(modelFor("lfm2-1.2b-tool"), "q4", new Set())).toEqual([]);
    expect(dtypeBlockers(modelFor("lfm2-1.2b-tool"), "q4f16", new Set(["shader-f16"]))).toEqual([]);
  });

  test("only entries with inlineBytes can be blocked on size", () => {
    // A checkpoint with a .onnx_data sidecar streams and has no inline ceiling.
    // Gemma 4's ONNX build is 3.6 GB and loads, so it must never be filtered.
    const gemma = modelFor("gemma4-e2b-onnx");
    expect(gemma.inlineBytes).toBeUndefined();
    expect(dtypeBlockers(gemma, "q4", new Set())).toEqual([]);
  });
});
