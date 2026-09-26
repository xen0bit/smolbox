// Ternary Bonsai 2: Qwen3.5's `<tool_call>` XML, inside a scratchpad the prompt
// has already opened.
//
// The call grammar is qwen3.5's exactly — the checkpoint is a ternary
// quantization of Qwen3.8-27B and its GGUF template spells out the same
// `<function=…><parameter=…>` block (PLAN §10.28). What differs is the thinking
// shape, and it is the difference lfm2.5 has from lfm2: this template ends the
// generation prompt with a bare `<think>\n`, so a completion starts INSIDE the
// block and only ever writes the closing tag. Parsed as qwen3.5's "tagged"
// shape, every word of the model's deliberation would be rendered as its reply.
//
// Captured, not read off a card: the CAPTURED cases in bonsai.test.ts are raw
// completions from the real 27B on WebGPU, driven with smolbox's own system
// prompt and tool schema.
//
// Two more things this family needs from the loop, both declared below rather
// than special-cased there. `structured` history, because the template rebuilds
// each call from `tool_calls` and wraps each result in `<tool_response>` itself.
// And `replayReasoning`, because the engine's cache is a hybrid of attention and
// recurrent state that cannot be rewound — the next prompt must extend the last
// one token for token or the whole conversation is prefilled again, and at the
// ~50 tok/s prefill measured without shader-f16 that is ~20 s per tool round
// trip. The template re-renders a past turn's `reasoning_content` in exactly the
// bytes the model produced, so replaying it is what makes the prefix match.

import { type ParsedTurn, type StreamPreview, extractBlocks, previewBlocks, splitThinking, stripSpecialTokens } from "../parse.ts";
import { TOOL_CALL_END, TOOL_CALL_START, parseXmlCall } from "./qwen35.ts";
import type { Dialect } from "./types.ts";

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls = bodies.map(parseXmlCall);
  const { text, reasoning } = splitThinking(rest, "prompt-opened");
  return { text: stripSpecialTokens(text).trim(), reasoning: stripSpecialTokens(reasoning).trim(), calls };
}

export function preview(raw: string): StreamPreview {
  return previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "prompt-opened");
}

export const bonsai: Dialect = {
  name: "bonsai",
  label: "Ternary Bonsai 2 (<tool_call> XML, prompt-opened <think>)",
  verified: true,
  note: "Verified against Ternary Bonsai 2 27B (PTQ1_0) on the WebGPU kernels. Qwen3.5's XML call grammar; the prompt opens <think>, so completions start inside it.",
  historyStyle: "structured",
  replayReasoning: true,
  parseTurn,
  preview,
};
