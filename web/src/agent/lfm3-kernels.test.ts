// The half of the LFM3 backend that is ours and needs no GPU: what the wrapper
// hands the shared KernelEngine, and the wait for the load's background builds.

import { describe, expect, test } from "bun:test";

import { type Lfm3Session, finishWarmup, wrapSession } from "./lfm3-kernels.ts";

function fakeSession(over: Partial<Lfm3Session> & { warm?: () => Promise<void> } = {}) {
  const seen: { depth?: number; warmedOn?: unknown } = {};
  const cache = { truncate: () => {} };
  const session: Lfm3Session = {
    model: {
      // eslint-disable-next-line require-yield
      async *streamTokenIdsFromCache(opts) {
        seen.depth = opts.decode_pipeline_depth;
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
