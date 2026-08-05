// Hermes-style: one JSON object per <tool_call>…</tool_call> block. This is
// what Qwen2.5/Qwen3 and the NousResearch Hermes models use.
//
// UNVERIFIED. Written from the published chat templates, not from a captured
// transcript. That distinction is the whole point of Dialect.verified: the last
// time this project trusted a vendor's documented call format (LFM2's JSON
// switch, PLAN §9.1.3) the model did something else entirely. Run the model,
// capture a turn, add it to the fixtures, then flip this to true.

import { type ParsedCall, type ParsedTurn, extractBlocks, parseCallBody, stripSpecialTokens } from "../parse.ts";
import type { Dialect } from "./types.ts";

export const TOOL_CALL_START = "<tool_call>";
export const TOOL_CALL_END = "</tool_call>";

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    // Each block holds exactly one call, but parseCallBody also accepts a list,
    // which costs nothing and covers a model that batches them.
    calls.push(...parseCallBody(body));
  }
  return { text: stripThinking(stripSpecialTokens(rest)).trim(), calls };
}

// Qwen3 emits reasoning inside <think>…</think> ahead of its answer. It is not
// prose for the user and must not be shown as such.
function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "");
}

export const hermes: Dialect = {
  name: "hermes",
  label: "Hermes / Qwen (<tool_call> JSON)",
  verified: false,
  note: "Implemented from the published chat template, never run against the real model. Capture a transcript before trusting it.",
  parseTurn,
};
