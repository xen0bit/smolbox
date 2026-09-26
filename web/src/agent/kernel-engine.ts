// The half of a WebGPU kernel backend that is ours: prefix-cache bookkeeping,
// cancellation and the reset rules, around an engine's forward pass.
//
// Two engines use it — the Gemma 4 kernels (gemma-kernels.ts) and Ternary
// Bonsai 2 (bonsai-kernels.ts). Both are webml-community builds of the same
// runtime and both hand back a model with `streamTokenIdsFromCache`, a
// generation state and EOS ids; they differ only in what those are called.
// Each loader adapts its engine to {@link KernelSession} and wraps it here.
//
// The bookkeeping was measured against both engines rather than assumed
// (PLAN §10.28): a generation that stops on EOS leaves prompt + every yielded
// token in the cache (EOS itself is never yielded or forwarded), and one that
// stops at the cap leaves prompt + all but the last yielded token, which was
// sampled but never fed back. That is exactly the rule below.

import { commonPrefix } from "./prefix.ts";

export interface GenerationState {
  cache: { truncate(n: number): void };
}

export interface KernelModel {
  streamTokenIdsFromCache(opts: {
    input_ids: number[][];
    generation_state: GenerationState;
    max_new_tokens: number;
    eos_token_id: number[];
    stop_on_eos: boolean;
  }): AsyncIterable<number>;
}

export interface DeviceInfo {
  vendor: string;
  architecture: string;
  features: { shaderF16: boolean; subgroups: boolean; subgroupMatrix: boolean };
}

/** The slice of a loaded engine this file drives. */
export interface KernelSession {
  readonly model: KernelModel;
  readonly generationState: GenerationState;
  readonly eosTokenIds: number[];
  deviceInfo(): DeviceInfo;
  reset(): void;
  dispose(): void;
}

export class KernelEngine {
  // The token ids of the last prompt+completion, so a prompt that extends it can
  // reuse the KV cache instead of prefilling the whole conversation again. This
  // is the engine's own trick and it matters more here than in a chat app: the
  // agent loop re-sends the entire history on every tool round trip.
  private lastIds: number[] = [];

  private constructor(private readonly model: KernelSession) {}

  /**
   * Wraps an already-built engine. The seam CI needs.
   *
   * Everything below this line is ours — the prefix-cache bookkeeping, the
   * cancellation, the reset rules — and none of it needs a GPU to be wrong, so
   * this seam keeps it reachable without one, exactly as FakeModelClient does
   * for the loop. The kernels themselves now DO run here (PLAN §10.17), but
   * only under the opt-in GPU suite, which is not where a cache-reset bug
   * should first be noticed.
   */
  static wrap(model: KernelSession): KernelEngine {
    return new KernelEngine(model);
  }

  info(): string {
    const d = this.model.deviceInfo();
    const f = d.features;
    const on = Object.entries({ f16: f.shaderF16, subgroups: f.subgroups, sgmatrix: f.subgroupMatrix })
      .filter(([, v]) => v)
      .map(([k]) => k);
    return `${d.vendor} ${d.architecture}${on.length ? ` (${on.join(", ")})` : " (no optional features)"}`;
  }

  /**
   * Streams token ids for a prompt, reusing whatever KV cache still applies.
   *
   * The reuse rule is the engine's: the cache is only good if the previous
   * sequence is a *prefix* of this one, so anything else resets it. History
   * elision changes an earlier message and therefore invalidates everything,
   * which is correct and is why the cache helps most within a turn — exactly
   * where the agent loop does its re-prefilling.
   */
  async *stream(
    promptIds: number[],
    maxNewTokens: number,
    cancelled: () => boolean,
  ): AsyncGenerator<number> {
    let shared = commonPrefix(this.lastIds, promptIds);
    if (shared !== this.lastIds.length) {
      this.model.reset();
      shared = 0;
    }
    let fresh = promptIds.slice(shared);
    if (fresh.length === 0) {
      // The prompt is exactly what is already cached; there is nothing to feed
      // the forward pass, so start it over rather than prefill an empty batch.
      this.model.reset();
      fresh = promptIds.slice();
    }

    const produced: number[] = [];
    let stopped = false;
    try {
      for await (const id of this.model.model.streamTokenIdsFromCache({
        input_ids: [fresh],
        generation_state: this.model.generationState,
        max_new_tokens: maxNewTokens,
        eos_token_id: this.model.eosTokenIds,
        stop_on_eos: true,
      })) {
        if (cancelled()) {
          stopped = true;
          break;
        }
        produced.push(id);
        yield id;
      }
    } finally {
      if (stopped) {
        // A half-finished generation leaves the cache describing a sequence that
        // was never completed; only a reset makes the next turn's prefix test
        // meaningful again.
        this.model.reset();
        this.lastIds = [];
      } else {
        // Drop the final token when generation ran to the cap rather than to
        // EOS, mirroring the engine's own bookkeeping.
        const hitCap = produced.length >= maxNewTokens;
        this.lastIds = promptIds.concat(hitCap ? produced.slice(0, -1) : produced);
      }
    }
  }

  reset(): void {
    this.model.reset();
    this.lastIds = [];
  }

  dispose(): void {
    try {
      this.model.dispose();
    } catch {
      // Disposing after the device has already gone is not worth reporting.
    }
    this.lastIds = [];
  }
}
