// Parses LFM2's tool-call output into calls the M7 tool surface can execute.
//
// The model wraps calls in <|tool_call_start|>...<|tool_call_end|>. Two body
// syntaxes are accepted, because the model produces both:
//
//   Pythonic: [run_terminal_command(cmd="ls", timeout_ms=0)]
//   JSON:     [{"name": "run_terminal_command", "arguments": {"cmd": "ls"}}]
//
// Pythonic is this checkpoint's default and, measured at M8, is what it actually
// emits — five different system-prompt wordings including the "Output function
// calls as JSON" line from Liquid's own docs all produced Pythonic calls with
// correct arguments. So it is parsed, not treated as an error. JSON stays
// supported because it costs nothing and is what a future checkpoint or a
// prompt that does take would produce.

export const TOOL_CALL_START = "<|tool_call_start|>";
export const TOOL_CALL_END = "<|tool_call_end|>";

/** A tool call the model asked for. `args` is still untrusted model output. */
export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/** What a model turn contained: prose, tool calls, or both. */
export interface ParsedTurn {
  text: string;
  calls: ParsedCall[];
}

/** Thrown when a tool-call block is present but unusable. */
export class ToolCallParseError extends Error {}

/**
 * Splits a raw model turn into its prose and its tool calls.
 *
 * A turn with no tool-call block is not an error: the model answering in plain
 * text is a legitimate outcome, and the caller decides whether it wanted one.
 */
export function parseTurn(raw: string): ParsedTurn {
  const text = stripSpecialTokens(raw).trim();
  const calls: ParsedCall[] = [];

  let cursor = 0;
  for (;;) {
    const open = raw.indexOf(TOOL_CALL_START, cursor);
    if (open === -1) {
      break;
    }
    const bodyStart = open + TOOL_CALL_START.length;
    const close = raw.indexOf(TOOL_CALL_END, bodyStart);
    // A missing close token means generation hit the token budget mid-call.
    // Parsing the truncated remainder would at best invent a call the model did
    // not finish asking for, so treat it as the error it is.
    if (close === -1) {
      throw new ToolCallParseError(
        `tool call block is unterminated (no ${TOOL_CALL_END}); the model may have hit its token limit`,
      );
    }
    calls.push(...parseCallBody(raw.slice(bodyStart, close)));
    cursor = close + TOOL_CALL_END.length;
  }

  return { text, calls };
}

function parseCallBody(body: string): ParsedCall[] {
  const trimmed = body.trim();
  if (trimmed === "") {
    throw new ToolCallParseError("tool call block is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    if (looksPythonic(trimmed)) {
      return parsePythonicCalls(trimmed);
    }
    throw new ToolCallParseError(
      `tool call body is not valid JSON: ${err instanceof Error ? err.message : String(err)}: ${truncate(trimmed)}`,
    );
  }

  // The template's own examples use a list, but a single object is the obvious
  // thing for a model to emit when it wants one call, and both are unambiguous.
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

  // OpenAI-dialect callers stringify the arguments; the template does not, but
  // the model has seen plenty of both in training. Accept either.
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

// A recursive-descent reader for the Pythonic call syntax. Small on purpose: it
// covers the literal forms the model actually emits for this schema (strings,
// ints, floats, dicts, lists, True/False/None) and refuses anything else rather
// than guessing. It is not a Python expression evaluator and must not become one.
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

function parsePythonicCalls(body: string): ParsedCall[] {
  return new PythonicReader(body).parseCalls();
}

// Only the tokens that leak into decoded text; the tokenizer already drops the
// rest when skip_special_tokens is set, but the raw string is what we parse.
const SPECIAL_TOKENS = [
  /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/g,
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|startoftext\|>/g,
  /<\|endoftext\|>/g,
];

function stripSpecialTokens(s: string): string {
  let out = s;
  for (const re of SPECIAL_TOKENS) {
    out = out.replace(re, "");
  }
  return out;
}

function looksPythonic(s: string): boolean {
  return /^\[?\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(s);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "an array" : typeof v;
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
