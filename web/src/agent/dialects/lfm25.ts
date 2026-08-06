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

import { type ParsedCall, type ParsedTurn, extractBlocks, parseCallBody, stripSpecialTokens } from "../parse.ts";
import type { Dialect } from "./types.ts";
import { TOOL_CALL_END, TOOL_CALL_START } from "./lfm2.ts";

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    calls.push(...parseCallBody(body));
  }
  return { text: stripSpecialTokens(stripThinking(rest)).trim(), calls };
}

const CLOSE = "</think>";

/**
 * Removes the reasoning, not just its tags.
 *
 * Three shapes have to be handled, and they mean different things:
 *
 *  - `<think>…</think>answer` — a whole block the model opened itself.
 *  - `…</think>answer` — the usual case. The prompt opened the block, so the
 *    close is the first tag in the completion and everything before it is
 *    scratchpad. Only the first one counts: the prompt opened exactly one.
 *  - `…<think>…` with no close — a block the model opened and never finished.
 *    There is no answer after it to keep, so the tail goes.
 *
 * A completion with no tag at all is left alone. It is either an answer or
 * reasoning that hit max_new_tokens, and nothing in the text distinguishes
 * them; blanking the turn on a guess is the worse of the two mistakes.
 *
 * Antares takes the opposite decision on the same shape (it keeps the prose so
 * the localize UI can show reasoning as its own event kind); here the chat log
 * has one channel and the answer is what belongs in it.
 */
function stripThinking(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/g, "");
  const close = out.indexOf(CLOSE);
  if (close !== -1) {
    out = out.slice(close + CLOSE.length);
  }
  const open = out.indexOf("<think>");
  if (open !== -1) {
    out = out.slice(0, open);
  }
  return out;
}

export const lfm25: Dialect = {
  name: "lfm2.5",
  label: "LFM2.5 (Pythonic or JSON, with <think>)",
  verified: true,
  note: "Verified against LiquidAI/LFM2.5-2.6B-ONNX at q4. Reasoning is hidden, so a turn that looks empty was all thinking.",
  parseTurn,
};
