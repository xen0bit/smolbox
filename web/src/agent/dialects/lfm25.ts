// LFM2.5: LFM2's tool-call syntax, plus a reasoning channel that is always on.
//
// The call markers are LFM2's, unchanged — <|tool_call_start|>[fn(a=1)]
// <|tool_call_end|>, Pythonic by default — so the body parser is shared with
// lfm2.ts rather than rewritten.
//
// What is new is the thinking. LFM2.5 is a pure reasoning model: its chat
// template appends a bare `<think>` to the generation prompt, so a completion
// starts *inside* the reasoning and the only tag it ever emits is the closing
// `</think>`. Reusing the lfm2 dialect would therefore hand the whole
// scratchpad to the chat log as if it were the answer, which is why this is a
// separate entry rather than a `note:` on the old one.
//
// The template half is verified mechanically rather than from the card: the
// prompt below is what LiquidAI/LFM2.5-2.6B-ONNX's own tokenizer renders at the
// pinned revision, and it is where the `<think>` claim comes from.
//
//   <|startoftext|><|im_start|>system
//   You are smolbox.
//   List of tools: [{"name": "run_terminal_command", …}]<|im_end|>
//   <|im_start|>user
//   what is in /mnt/host?<|im_end|>
//   <|im_start|>assistant
//   <think>
//
// The generation half is being verified now, against the real checkpoint on
// WebGPU. The flag below was promoted at the maintainer's call ahead of that
// capture; the slot it belongs in is the `test.todo` at the end of
// lfm25.test.ts, which says how to take it. Fill it — M8's lesson (PLAN §9.1.3)
// is that a documented call format is a hypothesis until a real turn confirms
// it, and `verified: true` is the claim that such a turn exists.

import {
  type ParsedCall,
  type ParsedTurn,
  type StreamPreview,
  extractBlocks,
  parseCallBody,
  previewBlocks,
  splitThinking,
  stripSpecialTokens,
} from "../parse.ts";
import type { Dialect } from "./types.ts";
import { TOOL_CALL_END, TOOL_CALL_START } from "./lfm2.ts";

/**
 * The reasoning is separated, not discarded.
 *
 * Three shapes have to be handled, and they mean different things:
 *
 *  - `…</think>answer` — the usual case. The prompt opened the block, so the
 *    close is the first tag in the completion and everything before it is
 *    scratchpad. Only the first one counts: the prompt opened exactly one.
 *  - `<think>…</think>answer` — a whole block the model opened itself, after
 *    the first one closed.
 *  - `…` with no close at all — reasoning that hit max_new_tokens. It is *all*
 *    scratchpad. Treating it as the answer used to be the safer guess, because
 *    the alternative was blanking the turn; now that reasoning is rendered as
 *    its own channel rather than dropped, nothing is lost by calling it what it
 *    is, and the user gets "it was still thinking" instead of a paragraph of
 *    first-person deliberation presented as the reply.
 */
export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    calls.push(...parseCallBody(body));
  }
  const { text, reasoning } = splitThinking(rest, "prompt-opened");
  return {
    text: stripSpecialTokens(text).trim(),
    reasoning: stripSpecialTokens(reasoning).trim(),
    calls,
  };
}

export function preview(raw: string): StreamPreview {
  return previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "prompt-opened");
}

export const lfm25: Dialect = {
  name: "lfm2.5",
  label: "LFM2.5 (Pythonic or JSON, with <think>)",
  verified: true,
  note: "Verified against LiquidAI/LFM2.5-2.6B-ONNX at q4. It reasons before every answer; the scratchpad is collapsed under the reply rather than shown as one.",
  parseTurn,
  preview,
};
