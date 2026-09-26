// The Ternary Bonsai 2 backend: the webml-community WebGPU kernel engine for
// prism-ml's ternary 27B, driven from the model worker in place of onnxruntime.
//
// It is the same runtime as the Gemma 4 kernels (gemma-kernels.ts) with a
// different front door, and the differences are why this is its own file:
//
//  - It reads a single GGUF, not a transformers repo. The tokenizer and the chat
//    template live in the GGUF's metadata and there is no tokenizer.json on the
//    hub for AutoTokenizer to load, so the prompt codec comes from the engine
//    too (see PromptCodec below).
//  - It is not published as a module. The Space inlines it into index.html;
//    `make bonsai-kernels` cuts it out (bonsai-extract.ts) into dist/kernels,
//    and `make site` ships it. The import below stays dynamic so `make web`
//    works on a checkout that has not fetched it.
//  - Its session is public API — `model`, `generationState`, `eosTokenIds` —
//    rather than Gemma's underscore accessors, so it maps onto KernelSession
//    with no adapter at all.
//
// The engine renders its own template with `tools: null` and decodes with
// skip_special_tokens, exactly as Gemma's does, and both would break tool
// calling for the same reasons (gemma-kernels.ts). So only the forward pass is
// the engine's; the template is rendered here, with the tool schema, by the
// same jinja implementation transformers.js uses. PLAN §10.28.

import { Template } from "@huggingface/jinja";

import { asset } from "../base.ts";
import { adapterHasShaderF16 } from "./kernel-f32.ts";
import { type DeviceInfo, type KernelSession, KernelEngine } from "./kernel-engine.ts";
import type { ChatMessage } from "./messages.ts";

/** Where `make bonsai-kernels` puts the extracted engine, under the site's base. */
export const BONSAI_BUNDLE_PATH = asset("kernels/bonsai/ternary-bonsai-2.js");

/**
 * The engine's tuning flag that turns off its batched prefill graph.
 *
 * Measured on an adapter without `shader-f16` (PLAN §10.28): the graph's fast
 * ternary kernels all require f16 and subgroup-matrix, and what is left is
 * SLOWER than feeding the prompt a token at a time through the decode path —
 * 37 tok/s against 50. With f16 the graph is the engine's intended fast path,
 * so the flag is set only where it measured as a win.
 */
export const NO_PREFILL_GRAPH_FLAG = "QWEN35_NO_PREFILL_GRAPH";

/** A prompt's way in and a completion's way out, for a backend with no AutoTokenizer. */
export interface PromptCodec {
  render(messages: readonly ChatMessage[], tools: readonly unknown[]): string;
  encode(prompt: string): number[];
  decode(ids: readonly number[]): string;
}

/** The engine's tokenizer, as far as this file uses it. */
export interface BonsaiTokenizer {
  config: { chat_template?: string; bos_token?: string; eos_token?: string };
  encode(text: string, opts: { add_special_tokens: boolean }): { ids: number[] };
  decode(ids: readonly number[], opts: { skip_special_tokens: boolean }): string;
}

/** The slice of a loaded TernaryBonsai2 session this file uses. */
export interface BonsaiSession extends KernelSession {
  readonly tokenizer: BonsaiTokenizer;
  deviceInfo(): DeviceInfo;
}

export interface BonsaiProgress {
  status?: string;
  message?: string;
  loaded?: number;
  total?: number | null;
  fraction?: number;
}

interface BonsaiModule {
  TernaryBonsai2: {
    load(
      modelUrl: string,
      opts: { onProgress?(p: BonsaiProgress): void },
    ): Promise<BonsaiSession>;
  };
}

/**
 * Builds the codec from the engine's tokenizer and the GGUF's own template.
 *
 * Exported for the unit tests, which run it against a fake tokenizer and the
 * real template text — the rendering is the part of this backend that CI can
 * check, and a template that silently drops the tools is exactly the failure
 * the engine's own renderer has.
 */
export function codecFor(tokenizer: BonsaiTokenizer): PromptCodec {
  const source = tokenizer.config.chat_template;
  if (!source) {
    throw new Error("the Bonsai GGUF carries no chat_template in its tokenizer metadata");
  }
  const template = new Template(source);
  return {
    render: (messages, tools) =>
      template.render({
        messages: messages as unknown as Record<string, unknown>[],
        tools: tools as unknown as Record<string, unknown>[],
        add_generation_prompt: true,
        bos_token: tokenizer.config.bos_token ?? "",
        eos_token: tokenizer.config.eos_token ?? "",
      }),
    encode: (prompt) => tokenizer.encode(prompt, { add_special_tokens: false }).ids,
    decode: (ids) => tokenizer.decode(ids, { skip_special_tokens: false }),
  };
}

/**
 * Sets an engine flag the way the engine reads them: `globalThis.process.env`.
 *
 * A worker has no `process`, so one is made — with `env` and nothing else. In
 * particular no `versions.node` and no `release`, which are what both this
 * engine and transformers.js test to decide they are running under Node; an
 * object with only `env` leaves both answering "browser".
 */
function setEngineFlag(name: string, value: string): void {
  const g = globalThis as { process?: { env?: Record<string, string> } };
  g.process ??= {};
  g.process.env ??= {};
  g.process.env[name] = value;
}

async function importEngine(): Promise<BonsaiModule> {
  const url = BONSAI_BUNDLE_PATH;
  try {
    return (await import(/* @vite-ignore */ url)) as unknown as BonsaiModule;
  } catch (err) {
    throw new Error(
      `the Ternary Bonsai 2 kernel engine is not on this server (${url}): run \`make bonsai-kernels\` ` +
        `to extract the pinned engine, then \`make web\`. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The loaded engine: the shared forward-pass driver plus this backend's codec. */
export interface BonsaiEngine {
  engine: KernelEngine;
  codec: PromptCodec;
}

export async function loadBonsai(
  modelUrl: string,
  onProgress: (p: BonsaiProgress) => void,
): Promise<BonsaiEngine> {
  if (!(await adapterHasShaderF16())) {
    setEngineFlag(NO_PREFILL_GRAPH_FLAG, "1");
  }
  const { TernaryBonsai2 } = await importEngine();
  const session = await TernaryBonsai2.load(modelUrl, { onProgress });
  return { engine: KernelEngine.wrap(session), codec: codecFor(session.tokenizer) };
}
