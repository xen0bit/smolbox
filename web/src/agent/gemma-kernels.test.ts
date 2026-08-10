// The half of the Gemma backend that is ours.
//
// The engine itself needs a GPU and 2.3 GB of weights, so it belongs to the
// opt-in suite (`SMOLBOX_MODEL=gemma4-e2b make test-e2e-agent`, PLAN §10.17).
// What is tested here is the code this project actually wrote around it: which
// tokens get fed to the forward pass, when the KV cache is reused, when it is
// reset, and what cancellation leaves behind. Those are the parts that would
// silently corrupt a conversation rather than fail, and none of them needs a
// GPU to be wrong. The f32 rewrite that lets the engine run on an adapter
// without `shader-f16` has its own file: kernel-f32.test.ts.

import { describe, expect, test } from "bun:test";

import { GemmaKernelEngine, type Gemma4Mobile, commonPrefix } from "./gemma-kernels.ts";

/** Records what the engine was asked to prefill, and replies with fixed ids. */
function fakeModel(reply: number[] = [90, 91]) {
  const calls: { input: number[]; maxNewTokens: number }[] = [];
  let resets = 0;
  const model: Gemma4Mobile = {
    _model: {
      // eslint-disable-next-line require-yield
      async *streamTokenIdsFromCache(opts) {
        calls.push({ input: opts.input_ids[0]!, maxNewTokens: opts.max_new_tokens });
        for (const id of reply.slice(0, opts.max_new_tokens)) {
          yield id;
        }
      },
    },
    _generationState: { cache: { truncate: () => {} } },
    _eosTokenIds: [1, 106],
    deviceInfo: () => ({
      vendor: "nvidia",
      architecture: "lovelace",
      features: { shaderF16: true, subgroups: true, subgroupMatrix: false },
    }),
    reset: () => {
      resets++;
    },
    dispose: () => {},
  };
  return { model, calls, resets: () => resets };
}

async function drain(gen: AsyncGenerator<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of gen) {
    out.push(id);
  }
  return out;
}

describe("commonPrefix", () => {
  test("counts the shared head", () => {
    expect(commonPrefix([1, 2, 3], [1, 2, 9])).toBe(2);
    expect(commonPrefix([1, 2], [1, 2, 3])).toBe(2);
    expect(commonPrefix([], [1])).toBe(0);
    expect(commonPrefix([1], [2])).toBe(0);
  });
});

describe("GemmaKernelEngine.stream", () => {
  test("the first prompt is prefilled whole", async () => {
    const { model, calls } = fakeModel();
    const engine = GemmaKernelEngine.wrap(model);
    expect(await drain(engine.stream([10, 11, 12], 8, () => false))).toEqual([90, 91]);
    expect(calls[0]!.input).toEqual([10, 11, 12]);
  });

  // The reason this matters: the agent loop re-sends the ENTIRE history on every
  // tool round trip, so within one turn each prompt strictly extends the last.
  // Reusing the cache there is the difference between prefilling the whole
  // conversation per tool call and prefilling only what is new.
  test("a prompt that extends the last one only prefills the new tokens", async () => {
    const { model, calls, resets } = fakeModel([90]);
    const engine = GemmaKernelEngine.wrap(model);
    await drain(engine.stream([10, 11], 8, () => false));
    // Previous prompt + what it produced, then the tool result appended.
    await drain(engine.stream([10, 11, 90, 20, 21], 8, () => false));

    expect(calls[1]!.input).toEqual([20, 21]);
    expect(resets()).toBe(0);
  });

  test("a prompt that diverges resets the cache and prefills everything", async () => {
    const { model, calls, resets } = fakeModel([90]);
    const engine = GemmaKernelEngine.wrap(model);
    await drain(engine.stream([10, 11], 8, () => false));
    // History elision rewrote an earlier message: the old sequence is no longer
    // a prefix, so nothing cached describes this conversation any more.
    await drain(engine.stream([10, 99, 100], 8, () => false));

    expect(calls[1]!.input).toEqual([10, 99, 100]);
    expect(resets()).toBe(1);
  });

  test("a prompt identical to what is cached is re-prefilled rather than fed nothing", async () => {
    const { model, calls } = fakeModel([]);
    const engine = GemmaKernelEngine.wrap(model);
    // Produces no tokens, so the recorded sequence is exactly the prompt.
    await drain(engine.stream([10, 11], 8, () => false));
    await drain(engine.stream([10, 11], 8, () => false));
    expect(calls[1]!.input).toEqual([10, 11]);
  });

  test("cancelling stops the stream and drops the cache", async () => {
    const { model, calls, resets } = fakeModel([90, 91, 92]);
    const engine = GemmaKernelEngine.wrap(model);
    let seen = 0;
    const got = await drain(engine.stream([10], 8, () => ++seen > 2));
    expect(got).toEqual([90, 91]);
    expect(resets()).toBe(1);

    // And the next turn cannot reuse a cache describing a sequence that was
    // never finished, so it prefills from scratch.
    await drain(engine.stream([10, 11], 8, () => false));
    expect(calls[1]!.input).toEqual([10, 11]);
  });

  test("hitting the token cap drops the last token from the cached sequence", async () => {
    const { model, calls } = fakeModel([90, 91]);
    const engine = GemmaKernelEngine.wrap(model);
    await drain(engine.stream([10], 2, () => false));
    // Cap reached, so 91 is not treated as settled: the next prompt that
    // extends [10, 90] reuses the cache and prefills only what is new.
    await drain(engine.stream([10, 90, 20], 8, () => false));
    expect(calls[1]!.input).toEqual([20]);
  });

  test("reset forces the next prompt to be prefilled whole", async () => {
    const { model, calls } = fakeModel([90]);
    const engine = GemmaKernelEngine.wrap(model);
    await drain(engine.stream([10, 11], 8, () => false));
    engine.reset();
    await drain(engine.stream([10, 11, 90], 8, () => false));
    expect(calls[1]!.input).toEqual([10, 11, 90]);
  });

  test("the max_new_tokens budget reaches the engine", async () => {
    const { model, calls } = fakeModel([1, 2, 3, 4, 5]);
    const engine = GemmaKernelEngine.wrap(model);
    expect(await drain(engine.stream([10], 3, () => false))).toEqual([1, 2, 3]);
    expect(calls[0]!.maxNewTokens).toBe(3);
  });
});

describe("GemmaKernelEngine.info", () => {
  test("names the adapter and the optional features in play", () => {
    const { model } = fakeModel();
    expect(GemmaKernelEngine.wrap(model).info()).toBe("nvidia lovelace (f16, subgroups)");
  });
});
