// The prefill window, which is the half of the KV cache that can be wrong
// quietly.
//
// A cache that is dropped when it did not need to be costs a prefill. A cache
// that is KEPT when it should have been dropped costs the conversation: the
// model reads positions filled by text nobody wrote and answers confidently
// about it. So every one of these asserts the second kind.

import { describe, expect, test } from "bun:test";

import { planPrefill } from "./prefill.ts";
import { commonPrefix } from "./prefix.ts";

/** Distinct ids, so a wrong window is a visibly wrong slice rather than a tie. */
function ids(n: number, from = 0): number[] {
  return Array.from({ length: n }, (_, i) => from + i + 1);
}

describe("planPrefill", () => {
  test("a cold start prefills the whole prompt in chunks", () => {
    const plan = planPrefill([], ids(1000), 400);
    expect(plan).toEqual({ reuse: 0, drop: false, steps: [400, 800] });
  });

  test("nothing to drop when there was never a cache", () => {
    // `drop` is the expensive, GPU-touching half, so it must not fire on the
    // first turn of every conversation.
    expect(planPrefill([], ids(10), 400).drop).toBe(false);
  });

  test("a prompt that extends the cache prefills only what is new", () => {
    const cached = ids(700);
    const plan = planPrefill(cached, ids(1000), 400);
    // The tool round trip this whole change exists for: 300 new tokens, one
    // pass, and the 700 already on the GPU are not touched.
    expect(plan).toEqual({ reuse: 700, drop: false, steps: [] });
  });

  test("the reused prefix is where the chunking starts, not zero", () => {
    const plan = planPrefill(ids(100), ids(1000), 400);
    expect(plan.steps).toEqual([500, 900]);
  });

  test("a prompt that diverges anywhere drops the whole cache", () => {
    // No cache here can be cropped, so a single changed token invalidates every
    // position after it — which is exactly what elide() does to an older tool
    // result.
    const cached = ids(700);
    const diverged = [...ids(500), 999_999, ...ids(499, 501)];
    const plan = planPrefill(cached, diverged, 400);
    expect(plan.reuse).toBe(0);
    expect(plan.drop).toBe(true);
    expect(plan.steps[0]).toBe(400);
  });

  test("a prompt identical to the cache starts over rather than reusing it", () => {
    // The case that produces wrong output rather than an error: with nothing
    // left to forward, transformers.js reads the prompt as unprocessed tokens
    // and runs all of it again on top of a full cache.
    const same = ids(500);
    const plan = planPrefill(same, same, 400);
    expect(plan.reuse).toBe(0);
    expect(plan.drop).toBe(true);
    expect(plan.steps).toEqual([400]);
  });

  test("a prompt shorter than the cache drops it, even as a prefix of it", () => {
    // Backwards is still divergence: the cache holds positions this prompt does
    // not have, and there is no way to give them back.
    const plan = planPrefill(ids(700), ids(300), 400);
    expect(plan.reuse).toBe(0);
    expect(plan.drop).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  test("the last segment is left to the generating call", () => {
    // steps are the throwaway passes; the real generate() prefills the tail. A
    // step at the prompt's own length would prefill it twice.
    for (const n of [399, 400, 401, 800, 801]) {
      const plan = planPrefill([], ids(n), 400);
      for (const step of plan.steps) {
        expect(step, `prompt of ${n}`).toBeLessThan(n);
      }
      expect(n - (plan.steps.at(-1) ?? 0), `tail of a ${n}-token prompt`).toBeLessThanOrEqual(400);
    }
  });

  test("a prompt inside one chunk needs no extra pass", () => {
    expect(planPrefill([], ids(400), 400).steps).toEqual([]);
    expect(planPrefill([], ids(1), 400).steps).toEqual([]);
    expect(planPrefill([], [], 400).steps).toEqual([]);
  });

  test("a nonsense chunk size still terminates", () => {
    // prefillChunkTokens has a floor, but this function is the one that would
    // hang rather than fail if it were ever handed a zero.
    expect(planPrefill([], ids(3), 0).steps).toEqual([1, 2]);
  });
});

describe("commonPrefix", () => {
  test("counts the leading agreement", () => {
    expect(commonPrefix([1, 2, 3], [1, 2, 3, 4])).toBe(3);
    expect(commonPrefix([1, 2, 3], [1, 9, 3])).toBe(1);
    expect(commonPrefix([], [1])).toBe(0);
    expect(commonPrefix([1], [])).toBe(0);
  });
});
