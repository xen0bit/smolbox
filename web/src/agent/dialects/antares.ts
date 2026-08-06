// Antares (Cisco Foundation AI), built on IBM Granite 4.0.
//
// The grammar is the Hermes one — a JSON object inside <tool_call>…</tool_call>
// — because that is what Granite's own chat template instructs and what the
// antares-cli reproduces verbatim. So this file is not about a different syntax;
// it is about the ways real Antares output departs from that syntax, each of
// which was taken from a transcript rather than from documentation.
//
// VERIFIED against fdtn-ai/antares-1b at fp16 (PLAN §11.10). The tolerances
// below are not defensive programming — every one of them fired on real output.

import {
  type ParsedCall,
  type ParsedTurn,
  type StreamPreview,
  ToolCallParseError,
  extractBlocks,
  normalizeJsonCalls,
  previewBlocks,
  splitThinking,
  stripSpecialTokens,
  truncate,
} from "../parse.ts";
import type { Dialect } from "./types.ts";

export const TOOL_CALL_START = "<tool_call>";
export const TOOL_CALL_END = "</tool_call>";

/**
 * Keys that are part of the call envelope rather than the arguments.
 *
 * Needed because Antares flattens its arguments (see `flattenedCall`), so
 * "everything that is not an envelope key" is how the argument object gets
 * recovered.
 */
const ENVELOPE_KEYS = new Set(["name", "tool", "arguments", "args", "parameters"]);

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    calls.push(...parseAntaresCallBody(body));
  }
  const { text, reasoning } = splitThinking(stripSpecialTokens(rest), "prompt-opened");
  return { text: text.trim(), reasoning: reasoning.trim(), calls };
}

export function preview(raw: string): StreamPreview {
  return previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "prompt-opened");
}

/**
 * Reads one <tool_call> body.
 *
 * Deliberately NOT `parseCallBody` from parse.ts: that one falls back to the
 * Pythonic reader, which is LFM2's syntax and has no business here. A Granite
 * model emitting `foo(bar="baz")` is malformed output, and saying so beats
 * guessing at a grammar this checkpoint does not use.
 */
export function parseAntaresCallBody(body: string): ParsedCall[] {
  const trimmed = body.trim();
  if (trimmed === "") {
    throw new ToolCallParseError("tool call block is empty");
  }
  const parsed = parseLenientJson(trimmed);
  if (parsed === undefined) {
    throw new ToolCallParseError(`tool call body is not valid JSON: ${truncate(trimmed)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    throw new ToolCallParseError("tool call block contained an empty list");
  }
  return items.map((item) => flattenedCall(item) ?? single(item));
}

function single(item: unknown): ParsedCall {
  return normalizeJsonCalls(item)[0]!;
}

/**
 * Recovers a call whose arguments were emitted at the top level.
 *
 * Antares-1B does this routinely — measured, repeatedly, at fp16:
 *
 *     {"name": "terminal", "command": "find . -type f", "max_chars": 20000}
 *
 * where both its own chat template and the antares-cli specify
 * `{"name": …, "arguments": {…}}`. The CLI's parser rejects the flattened form
 * outright (`_is_tool_call_payload` requires a dict of arguments), which would
 * turn the model's most common output into a parse error.
 *
 * Returns undefined when the object is already well-formed, so the strict path
 * stays the default and this is genuinely a fallback.
 */
function flattenedCall(item: unknown): ParsedCall | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const obj = item as Record<string, unknown>;
  const name = obj.name ?? obj.tool;
  if (typeof name !== "string" || name === "") {
    return undefined;
  }
  // A well-formed call carries its arguments in a recognised key. Leave it be.
  if (obj.arguments !== undefined || obj.args !== undefined || obj.parameters !== undefined) {
    return undefined;
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ENVELOPE_KEYS.has(key)) {
      args[key] = value;
    }
  }
  // `{"name": "submit_no_vulnerability_found"}` is a legitimate no-argument
  // call, so an empty result is a real call rather than a failure to parse one.
  return { name, args };
}

/**
 * JSON.parse, plus the two malformations this checkpoint actually produces.
 *
 * Both are copied from the antares-cli's `_lenient_json_loads`, which exists for
 * the same reason: a model that closes one brace too many has still told you
 * exactly what it wants to run, and refusing it costs a turn of the budget.
 */
function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Nothing yet — fall through to the recoveries below.
  }

  // 1. Trailing junk after a complete object: `{"name": …}</tool_call>garbage`
  //    or a second concatenated object. Take the first complete value.
  const prefix = firstJsonValue(text);
  if (prefix !== undefined) {
    return prefix;
  }

  // 2. Surplus closing braces: `{"name": …}}`. Peel up to three.
  let candidate = text.trimEnd();
  for (let i = 0; i < 3 && candidate.endsWith("}"); i++) {
    candidate = candidate.slice(0, -1).trimEnd();
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep peeling.
    }
  }
  return undefined;
}

/** Scans for the first complete JSON object, respecting strings and escapes. */
function firstJsonValue(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export const antares: Dialect = {
  name: "antares",
  label: "Antares / Granite (<tool_call> JSON)",
  verified: true,
  note: "Verified against fdtn-ai/antares-1b at fp16. Tolerates arguments flattened to the top level, which this checkpoint emits routinely.",
  parseTurn,
  preview,
};
