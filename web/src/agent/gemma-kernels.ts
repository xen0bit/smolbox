// The Gemma 4 backend: the webml-community WebGPU kernel engine, driven from
// the model worker in place of onnxruntime.
//
// The engine is a single ~540 KB ES module carrying its own WGSL, its own
// safetensors reader (chunked into IndexedDB) and its own tokenizer. It is NOT
// vendored into this repo — the Space publishes no license — so `make
// gemma-kernels` downloads a pinned copy into dist/kernels and the page imports
// it at runtime. That is also why the import below is deliberately dynamic: the
// bundle is absent from a fresh checkout and `make web` must still work.
//
// Two things it does NOT do, which is why this file exists rather than a
// three-line call to its own generate():
//
//  1. Its encodePrompt hardcodes `tools: null` when rendering the chat template,
//     so a tool schema can never reach the model. smolbox's entire prompt IS the
//     generated tool schema (AGENTS.md), so that is not a limitation to work
//     around later — it is the feature.
//  2. Its generate() decodes with skip_special_tokens: true, which would strip
//     `<|tool_call>` and `<tool_call|>` — precisely the markers the dialect
//     parses.
//
// So the prompt is built and the output decoded with the transformers.js
// tokenizer the worker already loads, and only the forward pass comes from the
// engine, through the `_model` / `_generationState` / `_eosTokenIds` accessors
// it exposes for the purpose. The prefix-cache bookkeeping in stream() is a
// faithful reimplementation of what its generate() does with those same objects.

import { asset } from "../base.ts";
import { KernelRewriteError, adapterHasShaderF16, rewriteKernelsToF32 } from "./kernel-f32.ts";
import { commonPrefix } from "./prefix.ts";

// Re-exported because the reuse rule below is the reason it exists, and a reader
// following the cache bookkeeping should not have to go looking for it. The
// onnxruntime path in model-worker.ts imports it from prefix.ts directly.
export { commonPrefix };

/**
 * Where `make gemma-kernels` puts the pinned bundle, served by web/serve.ts,
 * under the site's base prefix (base.ts).
 */
export const KERNEL_BUNDLE_PATH = asset("kernels/gemma4/gemma-4-e2b.js");

/** Progress, in the shape the engine reports it. */
export interface KernelProgress {
  status?: string;
  message?: string;
  loaded?: number;
  total?: number | null;
  fraction?: number;
  fromCache?: boolean;
}

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

/** The slice of Gemma4Mobile this file uses. */
export interface Gemma4Mobile {
  readonly _model: KernelModel;
  readonly _generationState: GenerationState;
  readonly _eosTokenIds: number[];
  deviceInfo(): {
    vendor: string;
    architecture: string;
    features: { shaderF16: boolean; subgroups: boolean; subgroupMatrix: boolean };
  };
  reset(): void;
  dispose(): void;
}

interface KernelModule {
  Gemma4Mobile: {
    load(
      modelId: string | null,
      opts: { revision?: string; onProgress?(p: KernelProgress): void },
    ): Promise<Gemma4Mobile>;
  };
}

/**
 * The f32 rewrite of the bundle, once per page.
 *
 * A blob URL rather than a refetch on every load: the module is 540 KB and the
 * engine is re-imported whenever someone switches models and switches back.
 * Safe to hold because the bundle is self-contained — no `import.meta.url`, no
 * nested imports, no DOM — so nothing in it cares that its module URL is a blob
 * rather than a path under /kernels.
 */
let f32BundleUrl: string | null = null;

/**
 * Imports the bundle, adapting it to the adapter if it has to.
 *
 * The specifier is built at runtime rather than written as a literal so the
 * bundler leaves it alone: this file is compiled by `bun build` on a checkout
 * where dist/kernels does not exist, and a static import would fail there.
 *
 * On an adapter with `shader-f16` this is exactly the import it always was. On
 * one without, the bundle is fetched as text, its three f16 choices rewritten
 * to f32 (kernel-f32.ts says why that is all it takes), and the result imported
 * from a blob. The rewrite is not applied unconditionally: f16 is faster and
 * smaller where it exists, and leaving that path untouched means adapters that
 * do expose the feature keep running the engine exactly as published.
 */
async function importEngine(): Promise<KernelModule> {
  const url = KERNEL_BUNDLE_PATH;
  try {
    if (await adapterHasShaderF16()) {
      return (await import(/* @vite-ignore */ url)) as unknown as KernelModule;
    }
    if (!f32BundleUrl) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
      }
      const rewritten = rewriteKernelsToF32(await res.text());
      f32BundleUrl = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
    }
    return (await import(/* @vite-ignore */ f32BundleUrl)) as unknown as KernelModule;
  } catch (err) {
    if (err instanceof KernelRewriteError) {
      throw err;
    }
    throw new Error(
      `the Gemma 4 kernel engine is not on this server (${url}): run \`make gemma-kernels\` ` +
        `to download the pinned bundle, then \`make web\`. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class GemmaKernelEngine {
  // The token ids of the last prompt+completion, so a prompt that extends it can
  // reuse the KV cache instead of prefilling the whole conversation again. This
  // is the engine's own trick and it matters more here than in a chat app: the
  // agent loop re-sends the entire history on every tool round trip.
  private lastIds: number[] = [];

  private constructor(private readonly model: Gemma4Mobile) {}

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
  static wrap(model: Gemma4Mobile): GemmaKernelEngine {
    return new GemmaKernelEngine(model);
  }

  static async load(
    repo: string,
    revision: string,
    local: boolean,
    localRoot: string,
    onProgress: (p: KernelProgress) => void,
  ): Promise<GemmaKernelEngine> {
    const { Gemma4Mobile } = await importEngine();
    // A path is resolved against the page URL by the engine, which is what lets
    // local weights come off our own origin; a bare repo id is turned into a
    // huggingface.co URL at the pinned revision.
    const root = local ? `${localRoot}${repo}/` : repo;
    const model = await Gemma4Mobile.load(root, { revision, onProgress });
    return new GemmaKernelEngine(model);
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
      for await (const id of this.model._model.streamTokenIdsFromCache({
        input_ids: [fresh],
        generation_state: this.model._generationState,
        max_new_tokens: maxNewTokens,
        eos_token_id: this.model._eosTokenIds,
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
