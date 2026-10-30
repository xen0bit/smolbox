// The half of the LFM3 backend that is ours and needs no GPU: what the wrapper
// hands the shared KernelEngine, and the wait for the load's background builds.

import { describe, expect, test } from "bun:test";

import {
  LFM3_MAX_LENGTH,
  LFM3_MAX_NEW_TOKENS,
  type Lfm3Session,
  finishWarmup,
  wrapSession,
} from "./lfm3-kernels.ts";
import { maxPromptTokens, modelFor, promptSizesAllocation } from "./models.ts";

function fakeSession(over: Partial<Lfm3Session> & { warm?: () => Promise<void> } = {}) {
  const seen: { depth?: number; maxNew?: number; warmedOn?: unknown } = {};
  const cache: { truncate(): void; maxLength?: number } = { truncate: () => {} };
  const session: Lfm3Session = {
    model: {
      // eslint-disable-next-line require-yield
      async *streamTokenIdsFromCache(opts) {
        seen.depth = opts.decode_pipeline_depth;
        seen.maxNew = opts.max_new_tokens;
      },
      warmRemainingPrefill: async (c) => {
        seen.warmedOn = c;
        await over.warm?.();
      },
    },
    generationState: { cache },
    eosTokenIds: [7],
    tokenizer: { encode: () => [], decode: () => "" } as unknown as Lfm3Session["tokenizer"],
    decodePipelineDepth: 6,
    deviceInfo: () => ({ vendor: "amd", architecture: "rdna-3", features: { shaderF16: true, subgroups: true, subgroupMatrix: false } }),
    reset: () => {},
    dispose: () => {},
    ...over,
  };
  return { session, seen, cache };
}

describe("wrapSession", () => {
  test("passes the tuned decode depth on every call", async () => {
    const { session, seen } = fakeSession();
    for await (const _ of wrapSession(session).stream([1, 2], 4, () => false)) {
      // nothing is yielded
    }
    expect(seen.depth).toBe(6);
  });

  test("reports the engine's device loss once it settles", async () => {
    let resolve!: (v: unknown) => void;
    const lost = new Promise((r) => (resolve = r));
    const engine = wrapSession(fakeSession({ lost }).session);
    expect(engine.deviceLost()).toBeUndefined();
    const reason = new Error("the GPU device was lost (unknown)");
    resolve(reason);
    await lost;
    expect(engine.deviceLost()).toBe(reason);
  });

  test("an engine with no lost promise never reports one", () => {
    expect(wrapSession(fakeSession().session).deviceLost()).toBeUndefined();
  });
});

describe("finishWarmup", () => {
  test("waits for the remaining prefill builds, on the session's own cache", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { session, seen, cache } = fakeSession({ warm: () => gate });
    let done = false;
    const waiting = finishWarmup(session).then(() => (done = true));
    await Promise.resolve();
    expect(seen.warmedOn).toBe(cache);
    expect(done).toBe(false);
    release();
    await waiting;
    expect(done).toBe(true);
  });

  test("a failed build does not fail the load", async () => {
    const { session } = fakeSession({ warm: () => Promise.reject(new Error("compile failed")) });
    await expect(finishWarmup(session)).resolves.toBeUndefined();
  });

  test("an engine without the method is already warm", async () => {
    const { session } = fakeSession();
    delete (session.model as { warmRemainingPrefill?: unknown }).warmRemainingPrefill;
    await expect(finishWarmup(session)).resolves.toBeUndefined();
  });
});

describe("the generation state's size", () => {
  // The engine allocates the whole cache at load, so every position past what a
  // turn can reach is GPU memory held for nothing: 768 MiB at the Space's 32 768
  // against 240 MiB here, measured (PLAN §10.34).
  test("holds the longest prompt the worker sends plus one full reply, and no more", () => {
    const entry = modelFor("lfm3-1.7b");
    expect(entry.generation?.max_new_tokens).toBe(LFM3_MAX_NEW_TOKENS);
    expect(LFM3_MAX_LENGTH).toBe(maxPromptTokens(entry) + LFM3_MAX_NEW_TOKENS);
    expect(entry.contextTokens).toBe(LFM3_MAX_LENGTH);
  });

  test("a reply is clamped to the room the cache has left", async () => {
    const { session, seen, cache } = fakeSession();
    cache.maxLength = 10;
    for await (const _ of wrapSession(session).stream([1, 2, 3, 4, 5, 6], 2048, () => false)) {
      // nothing is yielded
    }
    expect(seen.maxNew).toBe(4);
  });

  test("a reply that fits is left alone", async () => {
    const { session, seen, cache } = fakeSession();
    cache.maxLength = LFM3_MAX_LENGTH;
    for await (const _ of wrapSession(session).stream([1, 2], 2048, () => false)) {
      // nothing is yielded
    }
    expect(seen.maxNew).toBe(2048);
  });

  test("a device loss on this engine is not a prompt-size problem", () => {
    expect(promptSizesAllocation(modelFor("lfm3-1.7b"))).toBe(false);
    expect(promptSizesAllocation(modelFor("lfm2.5-2.6b"))).toBe(true);
  });
});
