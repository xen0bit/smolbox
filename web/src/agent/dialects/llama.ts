// Llama 3.x: a <|python_tag|> prefix, then a JSON call, terminated by <|eom_id|>
// (or the end of the turn). Llama also sometimes emits the bare JSON with no
// tag at all when the tool is a "JSON-based" one, so both are accepted.
//
// UNVERIFIED — see the note in hermes.ts. Written from Meta's documented format,
// not from a captured turn.

import {
  type ParsedCall,
  type ParsedTurn,
  type StreamPreview,
  parseCallBody,
  stripSpecialTokens,
} from "../parse.ts";
import type { Dialect } from "./types.ts";

export const PYTHON_TAG = "<|python_tag|>";

export function parseTurn(raw: string): ParsedTurn {
  const tag = raw.indexOf(PYTHON_TAG);
  if (tag !== -1) {
    const body = raw.slice(tag + PYTHON_TAG.length).split("<|eom_id|>")[0] ?? "";
    return {
      text: stripSpecialTokens(raw.slice(0, tag)).trim(),
      calls: parseCallBody(body),
    };
  }

  // No tag: a turn that is *entirely* a JSON object naming a function is a
  // call; anything else is prose. Guessing more aggressively than that would
  // turn a model quoting JSON at the user into a command execution.
  const trimmed = stripSpecialTokens(raw).trim();
  if (looksLikeBareCall(trimmed)) {
    let calls: ParsedCall[];
    try {
      calls = parseCallBody(trimmed);
    } catch {
      return { text: trimmed, calls: [] };
    }
    return { text: "", calls };
  }
  return { text: trimmed, calls: [] };
}

function looksLikeBareCall(s: string): boolean {
  if (!s.startsWith("{") || !s.endsWith("}")) {
    return false;
  }
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    return typeof v.name === "string" && ("arguments" in v || "parameters" in v);
  } catch {
    return false;
  }
}

/**
 * Everything from the python tag onward is call, not prose.
 *
 * There is no closing marker to wait for — `<|eom_id|>` ends the turn — so the
 * call is pending from the tag until generation stops. The bare-JSON form has
 * no marker at all and cannot be recognised until the turn is complete, so it
 * streams as the prose it looks like; that is a limit of the format rather than
 * of this function.
 */
export function preview(raw: string): StreamPreview {
  const tag = raw.indexOf(PYTHON_TAG);
  if (tag === -1) {
    return { text: stripSpecialTokens(raw).trim(), reasoning: "", pendingCall: false };
  }
  return {
    text: stripSpecialTokens(raw.slice(0, tag)).trim(),
    reasoning: "",
    pendingCall: !raw.includes("<|eom_id|>", tag),
  };
}

export const llama: Dialect = {
  name: "llama",
  label: "Llama 3.x (<|python_tag|> JSON)",
  verified: false,
  note: "Implemented from Meta's documented format, never run against the real model. Capture a transcript before trusting it.",
  parseTurn,
  preview,
};
