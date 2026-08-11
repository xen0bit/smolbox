// The half of the worker client that is a policy rather than a pipe.
//
// Most of WorkerModelClient is message plumbing that the e2e suites exercise for
// real. What is tested here is the one decision it makes on its own: when a
// device loss stops being something the worker can recover from and becomes a
// reason to throw the worker away. That decision is invisible when it is wrong —
// respawn too eagerly and every transient OOM costs a reload, too reluctantly
// and a genuinely lost device never comes back (PLAN §10.16) — and neither
// failure needs a GPU to happen.

import { describe, expect, test } from "bun:test";

import type { ModelRequest, ModelResponse } from "./messages.ts";
import { WorkerModelClient, type WorkerLike } from "./model-client.ts";

/** A worker that records what it was told and replays what the test dictates. */
class FakeWorker implements WorkerLike {
  readonly sent: ModelRequest[] = [];
  terminated = 0;
  private listeners: ((ev: { data: ModelResponse }) => void)[] = [];

  postMessage(msg: ModelRequest): void {
    this.sent.push(msg);
  }

  addEventListener(_type: "message", fn: (ev: { data: ModelResponse }) => void): void {
    this.listeners.push(fn);
  }

  terminate(): void {
    this.terminated++;
  }

  /** Delivers a worker -> page message to whoever is listening. */
  emit(msg: ModelResponse): void {
    for (const fn of this.listeners) {
      fn({ data: msg });
    }
  }
}

function deviceLost(): ModelResponse {
  return { type: "error", message: "[Invalid Buffer] is invalid due to a previous error", code: "device-lost" };
}

function generated(id: number): ModelResponse {
  return {
    type: "generated",
    id,
    text: "ok",
    prompt: "p",
    tokens: 1,
    ms: 1,
    stopped: false,
    promptTokens: 10,
    limitTokens: 8192,
  };
}

/** Builds a client whose replacement workers the test can inspect. */
function build() {
  const spawned: FakeWorker[] = [];
  const first = new FakeWorker();
  spawned.push(first);
  const client = new WorkerModelClient(first, undefined, undefined, () => {
    const next = new FakeWorker();
    spawned.push(next);
    return next;
  });
  return { client, spawned, current: () => spawned[spawned.length - 1]! };
}

describe("WorkerModelClient device-loss policy", () => {
  test("one device loss is the worker's own problem to fix", async () => {
    // The worker has already dropped its session and rebuilds on the next
    // request, which is the cheap fix and the one that usually works.
    const { client, spawned, current } = build();
    const gen = client.generate({ messages: [], tools: [] });
    current().emit(deviceLost());
    await expect(gen).rejects.toThrow(/previous error/);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.terminated).toBe(0);
  });

  test("two in a row replaces the worker and reloads the model on it", async () => {
    const { client, spawned, current } = build();
    const loaded = client.load(true, { modelKey: "lfm2.5-2.6b", dtype: "q4" });
    current().emit({ type: "ready", source: "local", loadMs: 1, modelKey: "lfm2.5-2.6b", dtype: "q4" });
    await loaded;

    for (const _ of [1, 2]) {
      const gen = client.generate({ messages: [], tools: [] });
      current().emit(deviceLost());
      await expect(gen).rejects.toThrow();
    }

    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.terminated).toBe(1);
    // A new worker knows nothing, so it is told the same thing the old one was.
    // Without this the next message fails with "generate before ready".
    expect(spawned[1]!.sent).toEqual([
      { type: "load", local: true, modelKey: "lfm2.5-2.6b", dtype: "q4" },
    ]);
  });

  test("a turn that completes clears the count", async () => {
    // Otherwise a long, healthy session accumulates its way into a respawn on
    // two unrelated failures an hour apart.
    const { client, spawned, current } = build();

    const first = client.generate({ messages: [], tools: [] });
    current().emit(deviceLost());
    await expect(first).rejects.toThrow();

    const ok = client.generate({ messages: [], tools: [] });
    current().emit(generated(2));
    await ok;

    const second = client.generate({ messages: [], tools: [] });
    current().emit(deviceLost());
    await expect(second).rejects.toThrow();

    expect(spawned).toHaveLength(1);
  });

  test("without a way to spawn one, nothing is terminated", async () => {
    // The fakes and the tests hand no factory over, and a client that killed the
    // only worker it had would be worse than one that kept failing.
    const worker = new FakeWorker();
    const client = new WorkerModelClient(worker);
    for (const _ of [1, 2, 3]) {
      const gen = client.generate({ messages: [], tools: [] });
      worker.emit(deviceLost());
      await expect(gen).rejects.toThrow();
    }
    expect(worker.terminated).toBe(0);
  });

  test("a failure that is not a device loss never respawns", async () => {
    const { client, spawned, current } = build();
    for (const _ of [1, 2, 3]) {
      const gen = client.generate({ messages: [], tools: [] });
      current().emit({ type: "error", message: "prompt is 9001 tokens", code: "prompt-too-long" });
      await expect(gen).rejects.toThrow();
    }
    expect(spawned).toHaveLength(1);
  });
});
