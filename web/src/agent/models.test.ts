import { describe, expect, test } from "bun:test";

import {
  AGENT_WORKING_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE,
  PREFILL_LOGITS_BUDGET_BYTES,
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
    // Only the engines that pay for a logits download. The Gemma kernel backend
    // samples on the GPU and never maps one back, so the budget is not its
    // constraint and asserting it would be asserting a cost it does not have.
    for (const m of models.filter((e) => e.backend !== "gemma4-kernels")) {
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

  // The whole reason the ceiling is backend-aware: 262 144 entries under the
  // logits budget would be ~1500 tokens, which is not a usable agent prompt.
  test("the kernel backend is not charged for a logits download it never makes", () => {
    const gemma = modelFor("gemma4-e2b");
    expect(gemma.vocabSize).toBe(262_144);
    expect(maxPromptTokens(gemma)).toBe(AGENT_WORKING_TOKENS);
    expect(maxPromptTokens({ ...gemma, backend: "transformers" })).toBeLessThan(2000);
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
    expect(weightFiles("q8").optional).toEqual(["onnx/model_quantized.onnx_data"]);
  });
});

describe("pickDtype", () => {
  test("skips f16 variants on an adapter without shader-f16", () => {
    expect(pickDtype(modelFor("lfm2-1.2b-tool"), new Set())).toBe("q4");
  });

  test("returns undefined when nothing on offer runs here", () => {
    expect(pickDtype(modelFor("antares-1b"), new Set())).toBeUndefined();
    expect(pickDtype(modelFor("antares-1b"), new Set(["shader-f16"]))).toBe("fp16");
  });
});
