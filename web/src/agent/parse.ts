// Shared machinery for reading tool calls out of model output.
//
// The syntax a model uses is a property of the checkpoint, not of its
// documentation — M8 established that the hard way (PLAN §9.1.3). So this file
// holds only what every dialect needs: the call types, the Pythonic reader, the
// JSON normaliser, and block extraction. The per-family knowledge lives in
// dialects/, one file each.

/** A tool call the model asked for. `args` is still untrusted model output. */
export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/** What a model turn contained: prose, tool calls, or both. */
export interface ParsedTurn {
  text: string;
  calls: ParsedCall[];
  /**
   * The reasoning channel, for families that have one.
   *
   * Separated rather than discarded. A reasoning model that hides its
   * scratchpad and then answers in one word looks broken, and on the turns
   * where it stops mid-thought it looks like nothing happened at all — the chat
   * log has to be able to say "it thought about this" without saying it in the
   * same voice as the answer.
   */
  reasoning?: string;
}

/**
 * How a model family delimits its reasoning.
 *
 *  - `none`: no reasoning channel.
 *  - `tagged`: the model writes both `<think>` and `</think>` itself (Qwen3).
 *  - `prompt-opened`: the chat template ends the generation prompt with a bare
 *    `<think>`, so a completion starts *inside* the block and the only tag it
 *    ever emits is the close (LFM2.5, Antares).
 */
export type ThinkStyle = "none" | "tagged" | "prompt-opened";

/** What to show the user while a completion is still arriving. */
export interface StreamPreview {
  /** Prose so far, safe to display. */
  text: string;
  /** Reasoning so far. */
  reasoning: string;
  /** A tool-call block has opened and not yet closed. */
  pendingCall: boolean;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Splits a completion into its reasoning and its prose.
 *
 * Handles the partial shapes too, because the same function runs on every
 * streamed chunk: a `prompt-opened` completion with no close yet is entirely
 * reasoning, and a block the model opened and has not finished is reasoning to
 * its end.
 */
export function splitThinking(raw: string, style: ThinkStyle): { text: string; reasoning: string } {
  if (style === "none") {
    return { text: raw, reasoning: "" };
  }

  const parts: string[] = [];
  let rest = raw;

  if (style === "prompt-opened") {
    const close = rest.indexOf(THINK_CLOSE);
    if (close === -1) {
      // Still inside the block the prompt opened. Everything is scratchpad —
      // which is also the right answer for a turn that hit max_new_tokens
      // mid-thought, because the reasoning is now shown rather than dropped.
      return { text: "", reasoning: rest.trim() };
    }
    parts.push(rest.slice(0, close));
    rest = rest.slice(close + THINK_CLOSE.length);
  }

  // Whole blocks the model opened itself. Both styles can produce these; a
  // `prompt-opened` model reopening one after its answer is a real shape.
  rest = rest.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
    parts.push(inner);
    return "";
  });

  const open = rest.indexOf(THINK_OPEN);
  if (open !== -1) {
    parts.push(rest.slice(open + THINK_OPEN.length));
    rest = rest.slice(0, open);
  }

  // A further `</think>` in the remainder is left exactly where it is. The
  // prompt opened one block and the first close ended it, so a second one is a
  // model quoting the tag at the user — and swallowing the answer up to the
  // last tag it happened to write is the worse reading.
  return { text: rest, reasoning: parts.join("\n").trim() };
}

/**
 * The live view of a partial completion, for a family whose calls are delimited
 * by a start and an end marker.
 *
 * A half-written tool call must never reach the chat log as prose: it is not
 * something the user asked to read, and watching `<|tool_call_start|>[run_te`
 * appear character by character is how the parsing came to look broken from the
 * outside even though it worked. Everything from an unclosed marker onward is
 * withheld and reported as `pendingCall` instead, so the UI can say what is
 * actually happening.
 */
export function previewBlocks(
  raw: string,
  start: string,
  end: string,
  style: ThinkStyle = "none",
): StreamPreview {
  let rest = "";
  let cursor = 0;
  let pendingCall = false;

  for (;;) {
    const open = raw.indexOf(start, cursor);
    if (open === -1) {
      rest += raw.slice(cursor);
      break;
    }
    rest += raw.slice(cursor, open);
    const close = raw.indexOf(end, open + start.length);
    if (close === -1) {
      pendingCall = true;
      break;
    }
    cursor = close + end.length;
  }

  const { text, reasoning } = splitThinking(rest, style);
  return { text: stripSpecialTokens(text).trim(), reasoning: stripSpecialTokens(reasoning).trim(), pendingCall };
}

/** Thrown when a tool-call block is present but unusable. */
export class ToolCallParseError extends Error {}

/**
 * Pulls out every `start`…`end` region, returning the bodies and the text with
 * those regions removed.
 *
 * A missing `end` is an error rather than a best-effort parse: generation that
 * stopped mid-call would otherwise be turned into a call the model never
 * finished asking for.
 */
export function extractBlocks(
  raw: string,
  start: string,
  end: string,
): { bodies: string[]; rest: string } {
  const bodies: string[] = [];
  let rest = "";
  let cursor = 0;

  for (;;) {
    const open = raw.indexOf(start, cursor);
    if (open === -1) {
      rest += raw.slice(cursor);
      return { bodies, rest };
    }
    rest += raw.slice(cursor, open);
    const bodyStart = open + start.length;
    const close = raw.indexOf(end, bodyStart);
    if (close === -1) {
      throw new ToolCallParseError(
        `tool call block is unterminated (no ${end}); the model may have hit its token limit`,
      );
    }
    bodies.push(raw.slice(bodyStart, close));
    cursor = close + end.length;
  }
}

/**
 * Turns parsed JSON into calls. Accepts a single object or a list, and
 * `arguments` either as an object or as a JSON string, because models have seen
 * plenty of both in training.
 */
export function normalizeJsonCalls(parsed: unknown): ParsedCall[] {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    throw new ToolCallParseError("tool call block contained an empty list");
  }
  return items.map(toCall);
}

function toCall(item: unknown): ParsedCall {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new ToolCallParseError(`tool call must be an object, got ${describe(item)}`);
  }
  const obj = item as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== "string" || name === "") {
    throw new ToolCallParseError("tool call is missing a string `name`");
  }

  let rawArgs = obj.arguments ?? obj.parameters ?? {};
  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch (err) {
      throw new ToolCallParseError(
        `tool call \`arguments\` is a string but not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new ToolCallParseError(`tool call \`arguments\` must be an object, got ${describe(rawArgs)}`);
  }

  return { name, args: rawArgs as Record<string, unknown> };
}

/** Parses a body as JSON if it can, else as a Pythonic call list. */
export function parseCallBody(body: string): ParsedCall[] {
  const trimmed = body.trim();
  if (trimmed === "") {
    throw new ToolCallParseError("tool call block is empty");
  }
  try {
    return normalizeJsonCalls(JSON.parse(trimmed));
  } catch (err) {
    if (err instanceof ToolCallParseError) {
      throw err;
    }
    if (looksPythonic(trimmed)) {
      return parsePythonicCalls(trimmed);
    }
    throw new ToolCallParseError(
      `tool call body is not valid JSON: ${err instanceof Error ? err.message : String(err)}: ${truncate(trimmed)}`,
    );
  }
}

// A recursive-descent reader for the Pythonic call syntax. Small on purpose: it
// covers the literal forms models actually emit for this schema (strings, ints,
// floats, dicts, lists, True/False/None) and refuses anything else rather than
// guessing. It is not a Python expression evaluator and must not become one.
class PythonicReader {
  private i = 0;

  constructor(private readonly src: string) {}

  parseCalls(): ParsedCall[] {
    this.ws();
    const bracketed = this.peek() === "[";
    if (bracketed) {
      this.i++;
    }

    const calls: ParsedCall[] = [];
    for (;;) {
      this.ws();
      if (bracketed && this.peek() === "]") {
        this.i++;
        break;
      }
      calls.push(this.parseCall());
      this.ws();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (bracketed && this.peek() === "]") {
        this.i++;
      }
      break;
    }

    this.ws();
    if (this.i < this.src.length) {
      throw new ToolCallParseError(`trailing text after tool call: ${truncate(this.src.slice(this.i))}`);
    }
    if (calls.length === 0) {
      throw new ToolCallParseError("tool call block contained an empty list");
    }
    return calls;
  }

  private parseCall(): ParsedCall {
    const name = this.name();
    this.ws();
    this.expect("(");

    const args: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      const key = this.name();
      this.ws();
      this.expect("=");
      const value = this.value();
      // Python None means "not provided". Passing it through as null would trip
      // decodeArgs' type checks on what is really an absent optional argument.
      if (value !== null) {
        args[key] = value;
      }
      this.ws();
      if (this.peek() === ",") {
        this.i++;
      }
    }
    return { name, args };
  }

  private value(): unknown {
    this.ws();
    const c = this.peek();
    if (c === '"' || c === "'") {
      return this.string();
    }
    if (c === "{") {
      return this.dict();
    }
    if (c === "[") {
      return this.list();
    }
    if (/[-\d]/.test(c)) {
      return this.number();
    }
    for (const [lit, val] of [
      ["True", true],
      ["False", false],
      ["None", null],
    ] as const) {
      if (this.src.startsWith(lit, this.i)) {
        this.i += lit.length;
        return val;
      }
    }
    throw new ToolCallParseError(`unexpected value at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`);
  }

  private dict(): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      const key = this.value();
      if (typeof key !== "string") {
        throw new ToolCallParseError("dict keys must be strings");
      }
      this.ws();
      this.expect(":");
      out[key] = this.value();
      this.ws();
      if (this.peek() === ",") {
        this.i++;
      }
    }
  }

  private list(): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.peek() === ",") {
        this.i++;
      }
    }
  }

  private string(): string {
    const quote = this.src[this.i]!;
    this.i++;
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === "\\") {
        const next = this.src[this.i + 1];
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
        out += next !== undefined && next in escapes ? escapes[next] : `\\${next ?? ""}`;
        this.i += 2;
        continue;
      }
      if (c === quote) {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    throw new ToolCallParseError("unterminated string in tool call");
  }

  private number(): number {
    const m = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.i));
    if (!m) {
      throw new ToolCallParseError(`bad number at ${this.i}`);
    }
    this.i += m[0].length;
    return Number(m[0]);
  }

  private name(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) {
      throw new ToolCallParseError(`expected an identifier at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`);
    }
    this.i += m[0].length;
    return m[0];
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      throw new ToolCallParseError(`expected ${ch} at ${this.i}: ${truncate(this.src.slice(this.i), 40)}`);
    }
    this.i++;
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

export function parsePythonicCalls(body: string): ParsedCall[] {
  return new PythonicReader(body).parseCalls();
}

// Chat-scaffolding tokens that leak into decoded text. The tokenizer drops them
// when skip_special_tokens is set, but the raw string is what we parse, so the
// prose half has to be cleaned here.
const SPECIAL_TOKENS = [
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|startoftext\|>/g,
  /<\|endoftext\|>/g,
  /<\|eot_id\|>/g,
  /<\|eom_id\|>/g,
  /<\|start_header_id\|>/g,
  /<\|end_header_id\|>/g,
  // Granite 4.0, which is what Antares is built on. Note `end_of_text` is not
  // the same token as `endoftext` above — Granite spells it with underscores
  // and uses it as both BOS and EOS, so it turns up mid-stream routinely.
  /<\|end_of_text\|>/g,
  /<\|start_of_role\|>/g,
  /<\|end_of_role\|>/g,
];

export function stripSpecialTokens(s: string): string {
  let out = s;
  for (const re of SPECIAL_TOKENS) {
    out = out.replace(re, "");
  }
  return out;
}

export function looksPythonic(s: string): boolean {
  return /^\[?\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(s);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "an array" : typeof v;
}

export function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
