// The prompt codec for a backend with no AutoTokenizer.
//
// Both GGUF kernel engines — Ternary Bonsai 2 (bonsai-kernels.ts) and LFM3
// (lfm3-kernels.ts) — read one file whose metadata carries the tokenizer and
// the chat template, so there is no tokenizer.json on the hub for
// transformers.js to load. The engine supplies the tokenizer; the template is
// rendered here, with our tool schema, by the same jinja implementation
// transformers.js uses. The engines' own renderers pass `tools: null`, which is
// the failure this exists to avoid (PLAN §10.28).

import { Template } from "@huggingface/jinja";

import type { ChatMessage } from "./messages.ts";

/** A prompt's way in and a completion's way out, for a backend with no AutoTokenizer. */
export interface PromptCodec {
  render(messages: readonly ChatMessage[], tools: readonly unknown[]): string;
  encode(prompt: string): number[];
  decode(ids: readonly number[]): string;
}

/** A GGUF engine's tokenizer, as far as the codec uses it. */
export interface GgufTokenizer {
  config: { chat_template?: string; bos_token?: string; eos_token?: string };
  encode(text: string, opts: { add_special_tokens: boolean }): { ids: number[] };
  decode(ids: readonly number[], opts: { skip_special_tokens: boolean }): string;
}

export interface CodecOptions {
  /** Extra template variables, rendered on every prompt. */
  templateArgs?: Record<string, unknown>;
  /** Rewrites the history before it is rendered; the template sees only the result. */
  prepare?(messages: readonly ChatMessage[]): readonly ChatMessage[];
}

/**
 * Builds the codec from the engine's tokenizer and the GGUF's own template.
 *
 * Exported for the unit tests, which run it against a fake tokenizer and the
 * real template text — the rendering is the part of these backends that CI can
 * check, and a template that silently drops the tools is exactly the failure
 * the engines' own renderers have.
 */
export function codecFor(tokenizer: GgufTokenizer, opts: CodecOptions = {}): PromptCodec {
  const source = tokenizer.config.chat_template;
  if (!source) {
    throw new Error("the GGUF carries no chat_template in its tokenizer metadata");
  }
  const template = new Template(source);
  return {
    render: (messages, tools) =>
      template.render({
        ...opts.templateArgs,
        messages: (opts.prepare?.(messages) ?? messages) as unknown as Record<string, unknown>[],
        tools: tools as unknown as Record<string, unknown>[],
        add_generation_prompt: true,
        bos_token: tokenizer.config.bos_token ?? "",
        eos_token: tokenizer.config.eos_token ?? "",
      }),
    encode: (prompt) => tokenizer.encode(prompt, { add_special_tokens: false }).ids,
    decode: (ids) => tokenizer.decode(ids, { skip_special_tokens: false }),
  };
}
