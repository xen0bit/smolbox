// The LFM3 backend: the webml-community WebGPU kernel engine for LiquidAI's
// LFM3-1.7B, driven from the model worker in place of onnxruntime.
//
// The same runtime family as the Gemma 4 and Bonsai kernels, reading one GGUF as
// Bonsai's does, so the prompt codec comes from the engine's tokenizer and the
// GGUF's own template (prompt-codec.ts). Two things are its own:
//
//  - Its front door is `Lfm3ForCausalLM.from_pretrained()`, which hands back a
//    wrapper whose session is private. `make lfm3-kernels` adds one getter to
//    that wrapper (lfm3-expose.ts); the session behind it is KernelSession's
//    shape exactly.
//  - The load tunes a decode pipeline depth for the device, and only the
//    engine's own agent API passes it on. The forward pass here is driven
//    through `streamTokenIdsFromCache` directly, so the tuned depth is handed
//    over explicitly — without it, every token waits on a readback.
//  - The load reports ready while it is still building prefill graphs in the
//    background, on the same cache the first prompt runs on. The engine's own
//    page leaves a person typing in that gap; this one sends the first prompt
//    the moment the model is ready, so the load waits for those builds instead
//    (PLAN §10.33).
//
// The template needs two things from the codec, both for the same reason as
// Bonsai's replayReasoning: the cache is a hybrid of attention and
// short-convolution state that the KernelEngine only ever reuses as a prefix,
// so the next prompt must extend the last one token for token. See
// {@link prepareHistory}. PLAN §10.30.

import { asset } from "../base.ts";
import { type DeviceInfo, type GenerationState, type KernelModel, KernelEngine } from "./kernel-engine.ts";
import { SESSION_ACCESSOR } from "./lfm3-expose.ts";
import type { ChatMessage } from "./messages.ts";
import { type GgufTokenizer, type PromptCodec, codecFor } from "./prompt-codec.ts";

/** Where `make lfm3-kernels` puts the engine, under the site's base. */
export const LFM3_BUNDLE_PATH = asset("kernels/lfm3/Lfm3ForCausalLM.js");

/**
 * The generation state's capacity, in positions.
 *
 * The Space's own setting. The engine may lower it to fit the device; the agent
 * page's prompt ceiling (AGENT_WORKING_TOKENS) sits well under it either way.
 */
export const LFM3_MAX_LENGTH = 32_768;

/** Template variables every prompt is rendered with. */
export const LFM3_TEMPLATE_ARGS = {
  // The template drops the reasoning of every turn before the latest user
  // message unless told otherwise, which would rewrite the middle of the prompt
  // each time the user speaks. The engine's own chat policy sets this too.
  preserve_thinking: true,
} as const;

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Puts back the `<think>` the generation prompt opened, on every replayed turn.
 *
 * The template ends its generation prompt with a bare `<think>`, so a completion
 * starts inside the scratchpad and the model only ever writes `</think>`. The
 * loop stores that completion verbatim (the dialect's `raw` history) — and the
 * template renders an assistant message's content verbatim too, so the only
 * byte between the last prompt-plus-completion and the next prompt's rendering
 * of it is that opening tag. Restoring it here makes the prefix exact.
 *
 * Only for a turn that closed its scratchpad: given content with no
 * `</think>`, the template writes an empty `<think></think>` of its own, and a
 * second opening tag inside that would render a turn the model never wrote.
 */
export function prepareHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "assistant" &&
    m.content.includes(THINK_CLOSE) &&
    !m.content.startsWith(THINK_OPEN)
      ? { ...m, content: THINK_OPEN + m.content }
      : m,
  );
}

/** The codec over the engine's tokenizer and the GGUF's template. Exported for the tests. */
export function lfm3Codec(tokenizer: GgufTokenizer): PromptCodec {
  return codecFor(tokenizer, { templateArgs: LFM3_TEMPLATE_ARGS, prepare: prepareHistory });
}

/** The engine's forward pass, which also takes the decode depth it tuned. */
export interface Lfm3Model {
  streamTokenIdsFromCache(
    opts: Parameters<KernelModel["streamTokenIdsFromCache"]>[0] & { decode_pipeline_depth?: number },
  ): AsyncIterable<number>;
  /** The prefill-graph builds `from_pretrained` starts and does not wait for. */
  warmRemainingPrefill?(cache: GenerationState["cache"]): Promise<void>;
}

/** The loaded session behind the wrapper, as far as this file uses it. */
export interface Lfm3Session {
  readonly model: Lfm3Model;
  readonly generationState: GenerationState;
  readonly eosTokenIds: number[];
  readonly tokenizer: GgufTokenizer;
  readonly decodePipelineDepth?: number;
  /** Resolves with the engine's DeviceLostError when its device goes. */
  readonly lost?: Promise<unknown>;
  deviceInfo(): DeviceInfo;
  reset(): void;
  dispose(): unknown;
}

export interface Lfm3Progress {
  status?: string;
  message?: string;
  loaded?: number;
  total?: number | null;
  fraction?: number;
}

interface Lfm3Module {
  Lfm3ForCausalLM: {
    from_pretrained(
      modelUrl: string,
      opts: { maxLength?: number; onProgress?(p: Lfm3Progress): void },
    ): Promise<Record<typeof SESSION_ACCESSOR, Lfm3Session | undefined>>;
  };
}

async function importEngine(): Promise<Lfm3Module> {
  const url = LFM3_BUNDLE_PATH;
  try {
    return (await import(/* @vite-ignore */ url)) as unknown as Lfm3Module;
  } catch (err) {
    throw new Error(
      `the LFM3 kernel engine is not on this server (${url}): run \`make lfm3-kernels\` ` +
        `to fetch the pinned engine, then \`make web\`. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Wraps the engine's session for KernelEngine, carrying its tuned decode depth.
 *
 * Exported for the tests, which drive it with a fake session.
 */
export function wrapSession(session: Lfm3Session): KernelEngine {
  const depth = session.decodePipelineDepth;
  return KernelEngine.wrap({
    model: {
      streamTokenIdsFromCache: (opts) =>
        session.model.streamTokenIdsFromCache({
          ...opts,
          ...(depth === undefined ? {} : { decode_pipeline_depth: depth }),
        }),
    },
    generationState: session.generationState,
    eosTokenIds: session.eosTokenIds,
    deviceInfo: () => session.deviceInfo(),
    reset: () => session.reset(),
    dispose: () => {
      void Promise.resolve(session.dispose()).catch(() => {});
    },
    ...(session.lost ? { lost: session.lost } : {}),
  });
}

/**
 * Waits out the prefill-graph builds the load left running.
 *
 * Its builds are pooled per block length, so this joins the ones in flight and
 * starts the rest, and the first prompt then finds every graph already built
 * rather than building its own beside them. Measured locally at ~0.3 s.
 *
 * A failed build is swallowed, as the engine swallows it: a prompt that needs
 * that block will build it again and fail where the failure can be reported.
 */
export async function finishWarmup(session: Lfm3Session): Promise<void> {
  await session.model.warmRemainingPrefill?.(session.generationState.cache).catch(() => {});
}

/** The loaded engine: the shared forward-pass driver plus this backend's codec. */
export interface Lfm3Engine {
  engine: KernelEngine;
  codec: PromptCodec;
}

export async function loadLfm3(modelUrl: string, onProgress: (p: Lfm3Progress) => void): Promise<Lfm3Engine> {
  const { Lfm3ForCausalLM } = await importEngine();
  const wrapper = await Lfm3ForCausalLM.from_pretrained(modelUrl, { maxLength: LFM3_MAX_LENGTH, onProgress });
  const session = wrapper[SESSION_ACCESSOR];
  if (!session) {
    throw new Error(
      `the LFM3 engine at ${LFM3_BUNDLE_PATH} has no ${SESSION_ACCESSOR} accessor: it was not fetched by ` +
        "`make lfm3-kernels`, which adds it (lfm3-expose.ts)",
    );
  }
  await finishWarmup(session);
  return { engine: wrapSession(session), codec: lfm3Codec(session.tokenizer) };
}
