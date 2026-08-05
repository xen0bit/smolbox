// LFM2: <|tool_call_start|>…<|tool_call_end|>, body either Pythonic or JSON.
//
// VERIFIED against onnx-community/LFM2-1.2B-Tool-ONNX at M8. It emits Pythonic
// in practice — five system-prompt wordings were measured, including the
// "Output function calls as JSON" line its vendor documents, and four produced
// Pythonic calls with correct arguments (the fifth produced JSON only by
// hallucinating instead of calling). JSON is accepted anyway because it costs
// nothing and is what a future checkpoint would produce.

import { type ParsedCall, type ParsedTurn, extractBlocks, parseCallBody, stripSpecialTokens } from "../parse.ts";
import type { Dialect } from "./types.ts";

export const TOOL_CALL_START = "<|tool_call_start|>";
export const TOOL_CALL_END = "<|tool_call_end|>";

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    calls.push(...parseCallBody(body));
  }
  return { text: stripSpecialTokens(rest).trim(), calls };
}

export const lfm2: Dialect = {
  name: "lfm2",
  label: "LFM2 (Pythonic or JSON)",
  verified: true,
  parseTurn,
};
