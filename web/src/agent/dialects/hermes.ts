// Hermes-style: one JSON object per <tool_call>…</tool_call> block. This is
// what Qwen2.5/Qwen3 and the NousResearch Hermes models use.
//
// VERIFIED against onnx-community/Qwen2.5-0.5B-Instruct at q4 on WebGPU — the
// captured turn is in dialects.test.ts. It was written from the published chat
// templates and turned out to be right, which is not the same thing as having
// been right: the last time this project trusted a vendor's documented call
// format (LFM2's JSON switch, PLAN §9.1.3) the model did something else
// entirely, and the only way to tell the two cases apart is to run it.
//
// The <think> half is NOT covered by that transcript. Qwen2.5 does not reason;
// Qwen3 does, and Qwen3 could not be run here at all (its only browser-viable
// build needs shader-f16 — see the registry entry). So the reasoning path
// remains implemented-from-template.

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
  // Qwen3 emits reasoning inside <think>…</think> ahead of its answer, writing
  // both tags itself — unlike LFM2.5 and Antares, whose templates open the block
  // in the prompt. It is not prose for the user and must not be shown as such.
  const { text, reasoning } = splitThinking(stripSpecialTokens(rest), "tagged");
  return { text: text.trim(), reasoning: reasoning.trim(), calls };
}

export function preview(raw: string): StreamPreview {
  return previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "tagged");
}

export const hermes: Dialect = {
  name: "hermes",
  label: "Hermes / Qwen (<tool_call> JSON)",
  verified: true,
  note: "Verified against Qwen2.5 0.5B Instruct at q4. Its <think> handling is from Qwen3's template and has not been run — Qwen3 needs shader-f16.",
  parseTurn,
  preview,
};
