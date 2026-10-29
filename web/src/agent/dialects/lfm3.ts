// LFM3: Qwen3.5's `<tool_call>` XML, inside a scratchpad the prompt opened.
//
// Not LFM2's grammar. LFM2 and LFM2.5 wrap Pythonic calls in
// `<|tool_call_start|>`; LFM3's card and template both write
//
//   <tool_call>
//   <function=run_terminal_command>
//   <parameter=cmd>
//   ls /mnt/host
//   </parameter>
//   </function>
//   </tool_call>
//
// which is qwen3.5's call grammar exactly, and its generation prompt ends with
// a bare `<think>`, which is LFM2.5's and Bonsai's thinking shape. So the parse
// is Bonsai's (PLAN §10.30).
//
// What differs from Bonsai is the history, and it is a property of the template.
// LFM3's renders an assistant turn as `<think>` + reasoning + `</think>` +
// content + calls with no whitespace of its own, so any split-and-rebuild has
// to reproduce the model's whitespace to keep the prefix, and none can promise
// to. Replaying the model's own text does, by construction: the template emits
// content verbatim, and the one missing byte — the `<think>` the prompt opened
// — is put back by the codec (lfm3-kernels.ts prepareHistory). Tool results go
// in as plain `tool` messages, which the template wraps in `<tool_response>`.
//
// Captured, not read off a card: the CAPTURED cases in lfm3.test.ts are raw
// completions from the real 1.7B on WebGPU, driven with smolbox's own system
// prompt and tool schema. It writes no whitespace around `</think>` either —
// `…ls -la /mnt/host`.</think><tool_call>` — which the parse does not depend on
// and the history does not have to reproduce.

import { type ParsedTurn, type StreamPreview } from "../parse.ts";
import { parseTurn as parseBonsai, preview as previewBonsai } from "./bonsai.ts";
import type { Dialect } from "./types.ts";

export function parseTurn(raw: string): ParsedTurn {
  return parseBonsai(raw);
}

export function preview(raw: string): StreamPreview {
  return previewBonsai(raw);
}

export const lfm3: Dialect = {
  name: "lfm3",
  label: "LFM3 (<tool_call> XML, prompt-opened <think>)",
  verified: true,
  note: "Verified against LFM3 1.7B (Q4_K_M) on the WebGPU kernels. Qwen3.5's XML call grammar; the prompt opens <think>, so completions start inside it.",
  parseTurn,
  preview,
};
