// Gemma 4: its own call grammar, and neither JSON nor Pythonic.
//
//   <|tool_call>call:run_terminal_command{cmd:<|"|>ls /mnt/host<|"|>}<tool_call|>
//
// Three things here are unlike every other dialect in this directory, and all
// three come from rendering google/gemma-4-E2B-it-qat-mobile-transformers' own
// chat_template.jinja rather than from a model card:
//
//  1. The markers are ASYMMETRIC — `<|tool_call>` opens and `<tool_call|>`
//     closes, the pipe moving from one side to the other. extractBlocks takes
//     both as parameters, so that costs nothing, but it does mean the closing
//     marker is not the opening one with a slash and reading it as such is wrong.
//  2. Strings are delimited by `<|"|>` on BOTH sides and are not escaped — the
//     template inserts them verbatim (see its format_argument macro). So a value
//     runs to the next `<|"|>` and may contain braces, commas and newlines that
//     a brace-balancing parser would trip over. Scan for the delimiter, never
//     balance.
//  3. Argument keys inside a call are bare identifiers, because the template
//     renders the call with escape_keys=False. Keys nested inside an object
//     value are quoted, because there it uses the default. Both are accepted.
//
// Reasoning is a named channel — `<|channel>thought … <channel|>` — rather than
// <think>, which is why splitThinking takes its markers as a parameter.
//
// UNVERIFIED. Written from the rendered template, which is a better source than
// a doc but is still not a transcript: M8's lesson (PLAN §9.1.3) is that the
// format a checkpoint actually emits is a property of the checkpoint. Capture a
// turn before promoting this.

import {
  type ParsedCall,
  type ParsedTurn,
  type StreamPreview,
  type ThinkMarkers,
  ToolCallParseError,
  extractBlocks,
  previewBlocks,
  splitThinking,
  truncate,
} from "../parse.ts";
import type { Dialect } from "./types.ts";

export const TOOL_CALL_START = "<|tool_call>";
export const TOOL_CALL_END = "<tool_call|>";
/** The string delimiter, used as both the opening and the closing quote. */
export const QUOTE = '<|"|>';

export const THINK_MARKERS: ThinkMarkers = { open: "<|channel>", close: "<channel|>" };

// Turn scaffolding that leaks into decoded text. Gemma's own, kept local rather
// than added to the shared list: they mean nothing to any other family.
const SCAFFOLDING = ["<|turn>", "<turn|>", "<|think|>", "<bos>", "<eos>"];

function stripScaffolding(s: string): string {
  let out = s;
  for (const token of SCAFFOLDING) {
    out = out.split(token).join("");
  }
  return out;
}

// The channel body opens with its name — "thought\n…" — which is routing, not
// reasoning. Drop it so the log shows what the model was thinking, not which
// pipe it went down.
function stripChannelName(s: string): string {
  return s.replace(/^\s*[a-z_]+\s*\n/, "").trim();
}

export function parseTurn(raw: string): ParsedTurn {
  const { bodies, rest } = extractBlocks(raw, TOOL_CALL_START, TOOL_CALL_END);
  const calls: ParsedCall[] = [];
  for (const body of bodies) {
    calls.push(parseGemmaCall(body));
  }
  const { text, reasoning } = splitThinking(rest, "tagged", THINK_MARKERS);
  return {
    text: stripScaffolding(text).trim(),
    reasoning: stripChannelName(stripScaffolding(reasoning)),
    calls,
  };
}

export function preview(raw: string): StreamPreview {
  const p = previewBlocks(raw, TOOL_CALL_START, TOOL_CALL_END, "tagged", THINK_MARKERS);
  return {
    text: stripScaffolding(p.text).trim(),
    reasoning: stripChannelName(stripScaffolding(p.reasoning)),
    pendingCall: p.pendingCall,
  };
}

/** Reads one `call:NAME{…}` body. */
export function parseGemmaCall(body: string): ParsedCall {
  const reader = new GemmaReader(body.trim());
  const call = reader.call();
  reader.expectEnd();
  return call;
}

// A reader for the grammar above. Small on purpose, like PythonicReader: it
// covers the literal forms the template can emit and refuses everything else
// rather than guessing.
class GemmaReader {
  private i = 0;

  constructor(private readonly src: string) {}

  call(): ParsedCall {
    this.ws();
    if (!this.eat("call:")) {
      throw new ToolCallParseError(
        `Gemma tool call must begin with "call:", got: ${truncate(this.src.slice(this.i), 60)}`,
      );
    }
    const name = this.ident();
    this.ws();
    const args = this.object(false);
    return { name, args };
  }

  expectEnd(): void {
    this.ws();
    if (this.i < this.src.length) {
      throw new ToolCallParseError(`trailing text after tool call: ${truncate(this.src.slice(this.i))}`);
    }
  }

  /**
   * `{key:value,…}`. Keys are bare at call level and quoted when nested, which
   * is what escape_keys toggles in the template; accept either at both levels.
   */
  private object(quotedKeys: boolean): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.eat("}")) {
        return out;
      }
      const key = this.src.startsWith(QUOTE, this.i) ? this.string() : this.ident();
      this.ws();
      this.expect(":");
      const value = this.value();
      // `null` means the model declined to supply the argument. Passing it
      // through would fail decodeArgs' type check on what is really an absent
      // optional — the same call the Pythonic reader makes about `None`.
      if (value !== null) {
        out[key] = value;
      }
      this.ws();
      this.eat(",");
      void quotedKeys;
    }
  }

  private value(): unknown {
    this.ws();
    if (this.src.startsWith(QUOTE, this.i)) {
      return this.string();
    }
    if (this.peek() === "{") {
      return this.object(true);
    }
    if (this.peek() === "[") {
      return this.array();
    }
    if (this.eat("true")) {
      return true;
    }
    if (this.eat("false")) {
      return false;
    }
    if (this.eat("null")) {
      return null;
    }
    return this.number();
  }

  private array(): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.eat("]")) {
        return out;
      }
      out.push(this.value());
      this.ws();
      this.eat(",");
    }
  }

  /**
   * `<|"|>…<|"|>`, with no escaping of any kind.
   *
   * The template writes the value verbatim between the delimiters, so the only
   * possible terminator is the next delimiter — braces, commas and newlines
   * inside are content. A value containing the delimiter itself cannot be
   * expressed in this format at all, which is the format's problem and not
   * something to guess around.
   */
  private string(): string {
    this.expect(QUOTE);
    const end = this.src.indexOf(QUOTE, this.i);
    if (end === -1) {
      throw new ToolCallParseError("unterminated string in tool call (no closing <|\"|>)");
    }
    const out = this.src.slice(this.i, end);
    this.i = end + QUOTE.length;
    return out;
  }

  private number(): number {
    const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(this.src.slice(this.i));
    if (!m) {
      throw new ToolCallParseError(
        `unexpected value at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`,
      );
    }
    this.i += m[0].length;
    return Number(m[0]);
  }

  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(this.src.slice(this.i));
    if (!m) {
      throw new ToolCallParseError(
        `expected an identifier at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`,
      );
    }
    this.i += m[0].length;
    return m[0];
  }

  private eat(token: string): boolean {
    if (this.src.startsWith(token, this.i)) {
      this.i += token.length;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.eat(token)) {
      throw new ToolCallParseError(
        `expected ${token} at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`,
      );
    }
  }

  private peek(): string {
    return this.src[this.i] ?? "";
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) {
      this.i++;
    }
  }
}

export const gemma4: Dialect = {
  name: "gemma4",
  label: "Gemma 4 (<|tool_call>call:name{…})",
  verified: false,
  note: "Implemented from the checkpoint's own rendered chat template, not from a captured turn. Its call grammar is unlike any other here; capture a transcript before trusting it.",
  parseTurn,
  preview,
  // Gemma's template renders a tool result from structured tool_calls and a
  // matching tool_call_id. Fed the flat history every other dialect uses, it
  // emits NOTHING for the tool message — the model never sees the output it
  // asked for. See ChatMessage in messages.ts.
  historyStyle: "structured",
};
