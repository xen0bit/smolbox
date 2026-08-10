// Qwen3.5: `<tool_call>` blocks whose body is XML, not JSON.
//
// The outer markers are hermes' exactly — `<tool_call>` … `</tool_call>` — and
// that is the trap. This entry was first registered as `hermes` on the strength
// of reading the chat template, which writes those markers when it *renders a
// past call*. What the model emits is a different thing, and the only way to
// learn that was to run it (PLAN §10.20):
//
//   <tool_call>
//   <function=run_terminal_command>
//   <parameter=cmd>
//   ls /mnt/host
//   </parameter>
//   </function>
//   </tool_call>
//
// The card names the parser this needs — vLLM and SGLang are told
// `--tool-call-parser qwen3_coder` — so the format was documented; it just is
// not inferable from the markers, which is §10.2's rule holding for the third
// time.
//
// VERIFIED against onnx-community/Qwen3.5-0.8B-Text-ONNX at q4 on WebGPU; the
// captured turn is a CAPTURED: case in dialects.test.ts.

import {
  type ParsedCall,
  type ParsedTurn,
  type StreamPreview,
  ToolCallParseError,
  extractBlocks,
  previewBlocks,
  splitThinking,
  stripSpecialTokens,
} from "../parse.ts";
import type { Dialect } from "./types.ts";

export const TOOL_CALL_START = "<tool_call>";
export const TOOL_CALL_END = "</tool_call>";

const FUNCTION_NAME = /<function=([^>\s]+)\s*>/;
// Non-greedy, so a stray `</parameter>` — which the real model emitted, one
// more close tag than it opened — ends the value it belongs to and is then
// simply not matched again, rather than swallowing the rest of the block.
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;

/**
 * One XML parameter value, typed the only way this format allows: by guessing.
 *
 * The wire has no types — every value arrives as text between two tags — but
 * `decodeArgs` is strict on the other side: `cmd` must be a string and
 * `max_output` must be a real integer, so handing it `"1024"` fails as surely
 * as handing it `1024` for `cmd` would. Something has to decide, and the only
 * information available is the text.
 *
 * JSON is the rule, because it is the one the model's other dialect already
 * uses: parse it, and keep the result when it is a scalar or a structure. Text
 * that is not JSON — `ls /mnt/host` — stays a string, which is the common case.
 *
 * The known cost: a command that is *entirely* numeric (`cmd: 123`) becomes a
 * number and `decodeArgs` rejects it. That is a correctable error the model is
 * told about, not a silent wrong command, and it is preferred to the reverse
 * failure where every integer parameter breaks.
 */
function coerce(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** The calls inside one `<tool_call>` body. */
function parseXmlCall(body: string): ParsedCall {
  const name = FUNCTION_NAME.exec(body)?.[1];
  if (!name) {
    throw new ToolCallParseError(
      `tool call block names no function: ${body.trim().slice(0, 80)}`,
    );
  }
  const args: Record<string, unknown> = {};
  PARAMETER.lastIndex = 0;
  for (let m = PARAMETER.exec(body); m !== null; m = PARAMETER.exec(body)) {
    args[m[1]!] = coerce(m[2]!);
  }
  return { name, args };
}

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls = bodies.map(parseXmlCall);
  // Qwen3.5 writes both `<think>` tags itself, as Qwen3 does and unlike LFM2.5,
  // whose template opens the block in the prompt.
  const { text, reasoning } = splitThinking(stripSpecialTokens(rest), "tagged");
  return { text: text.trim(), reasoning: reasoning.trim(), calls };
}

export function preview(raw: string): StreamPreview {
  // The outer markers are the ones hermes uses, so the streaming view is the
  // same problem with the same answer: never let a marker reach the screen.
  return previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "tagged");
}

export const qwen35: Dialect = {
  name: "qwen3.5",
  label: "Qwen3.5 (<tool_call> XML)",
  verified: true,
  note: "Verified against Qwen3.5 0.8B (text) at q4. Shares hermes' <tool_call> markers but its body is <function=…>/<parameter=…> XML, not JSON.",
  parseTurn,
  preview,
};
