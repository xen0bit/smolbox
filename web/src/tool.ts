// TS mirror of internal/tool: the model-facing surface of the exec API.
//
// Like protocol.ts, this is a hand-written twin rather than a generated file,
// and tool.test.ts is what holds it to the Go original — it asserts the
// definition against docs/schema/*.json (generated from the Go types) and the
// rendering against tests/tool/render-cases.json, the same table the Go tests
// run. Change one side and the other fails.

import type { Request, Response } from "./protocol.ts";
import { OpExec } from "./protocol.ts";

/** The function-calling name of the exec tool. */
export const toolName = "run_terminal_command";

/** The tool's prompt text. Byte-identical to tool.Description in Go. */
export const toolDescription = `Run a shell command inside the smolbox Linux VM and return its exit code, stdout, and stderr.

The VM is a persistent sandbox. The working directory and anything written to /tmp survive between calls, so you can cd into a directory once and keep working there, or build up intermediate files across several calls.

The user's folder is mounted read-only at /mnt/host. You can list, read, and search it; writes to it fail with EROFS. Nothing else in the VM touches the user's machine, so use /tmp freely for scratch work.

The command is interpreted by sh -c, so pipes, redirection, globs, quoting, and && all work. There is no network access. Prefer one focused command per call and read its output before choosing the next one.`;

/** A JSON Schema node, in the subset the wire types need. */
export interface Schema {
  $schema?: string;
  title?: string;
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema;
  items?: Schema;
  contentEncoding?: string;
}

/**
 * The tool's input schema: protocol.Request minus `op` (the tool always issues
 * exec) and with `cmd` required (the wire allows a request without one; a tool
 * call without one is meaningless).
 */
export const inputSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: `${toolName} arguments`,
  type: "object",
  properties: {
    cmd: {
      type: "string",
      description:
        "The shell command to run, as a single string. It is passed to `sh -c`, so pipes, redirection, globs, quoting, and `&&` all work.",
    },
    cwd: {
      type: "string",
      description:
        "Directory to run this command in. Defaults to the session's current directory, which carries over from earlier calls.",
    },
    env: {
      type: "object",
      description:
        "Environment variables for this command only. A guest-side `export` does not carry over to the next call; this does not either.",
      additionalProperties: { type: "string" },
    },
    stdin: {
      type: "string",
      description: "Bytes to feed to the command's standard input, base64-encoded.",
      contentEncoding: "base64",
    },
    timeout_ms: {
      type: "integer",
      description:
        "Kill the command after this many milliseconds. The whole process group is killed and `timed_out` is set on the response. 0 means no timeout.",
    },
    max_output: {
      type: "integer",
      description:
        "Cap stdout and stderr at this many bytes each. Output past the cap is dropped and `truncated` is set on the response. 0 uses the session default.",
    },
  },
  required: ["cmd"],
};

/** The Anthropic Messages API tool shape. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Schema;
}

/** The OpenAI / llama.cpp / transformers.js function shape. */
export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Schema };
}

/** The tool in the Anthropic dialect. */
export function anthropicTool(): AnthropicTool {
  return { name: toolName, description: toolDescription, input_schema: inputSchema };
}

/** The tool in the OpenAI dialect. */
export function openaiTool(): OpenAITool {
  return {
    type: "function",
    function: { name: toolName, description: toolDescription, parameters: inputSchema },
  };
}

/** Thrown when a tool call cannot be turned into a request. */
export class ToolArgumentError extends Error {}

const allowedArgs = new Set(["cmd", "cwd", "env", "stdin", "timeout_ms", "max_output"]);

/**
 * Turns a model's argument object into a protocol Request. Accepts the raw JSON
 * string or an already-parsed object, since SDKs differ on which they hand back.
 *
 * Unknown fields are rejected rather than ignored, so a hallucinated argument
 * surfaces as an error the caller can feed back to the model instead of
 * silently doing something other than what was asked.
 */
export function decodeArgs(args: string | Record<string, unknown>): Request {
  let raw: unknown = args;
  if (typeof args === "string") {
    try {
      raw = JSON.parse(args);
    } catch (err) {
      throw new ToolArgumentError(`tool: decode arguments: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolArgumentError("tool: decode arguments: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  // `op` is the one argument that could turn a read into a session teardown.
  if ("op" in obj) {
    throw new ToolArgumentError(`tool: arguments may not set op; ${toolName} always issues exec`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowedArgs.has(key)) {
      throw new ToolArgumentError(`tool: decode arguments: unknown field ${JSON.stringify(key)}`);
    }
  }

  if (obj.cmd === undefined || (typeof obj.cmd === "string" && obj.cmd.trim() === "")) {
    throw new ToolArgumentError("tool: cmd is required and must not be blank");
  }
  const req: Request = { op: OpExec, cmd: requireString(obj, "cmd") };
  if (obj.cwd !== undefined) {
    req.cwd = requireString(obj, "cwd");
  }
  if (obj.env !== undefined) {
    req.env = requireStringMap(obj.env);
  }
  if (obj.stdin !== undefined) {
    // The argument is base64 and Request.stdin as a string means *plain text*
    // that encodeRequest will base64 for us — so decode to bytes here or the
    // guest gets a double-encoded stdin. This is where Go's json.Unmarshal
    // into []byte and the TS twin would otherwise part ways.
    req.stdin = decodeBase64(requireString(obj, "stdin"));
  }
  if (obj.timeout_ms !== undefined) {
    req.timeout_ms = requireNonNegativeInt(obj.timeout_ms, "timeout_ms");
  }
  if (obj.max_output !== undefined) {
    req.max_output = requireNonNegativeInt(obj.max_output, "max_output");
  }
  return req;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new ToolArgumentError(`tool: decode arguments: ${key} must be a string`);
  }
  return v;
}

function requireStringMap(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ToolArgumentError("tool: decode arguments: env must be an object of strings");
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new ToolArgumentError("tool: decode arguments: env must be an object of strings");
    }
    out[k] = val;
  }
  return out;
}

function requireNonNegativeInt(v: unknown, key: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ToolArgumentError(`tool: decode arguments: ${key} must be an integer`);
  }
  if (v < 0) {
    throw new ToolArgumentError(`tool: ${key} must not be negative, got ${v}`);
  }
  return v;
}

function decodeBase64(s: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new ToolArgumentError("tool: decode arguments: stdin is not valid base64");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** The part of Session that callTool needs, so tests can pass a fake. */
export interface ToolSession {
  exec(req: Request, timeoutMs?: number): Promise<Response>;
}

/** What a tool call produced: text for the model, raw response for the host. */
export interface ToolResult {
  text: string;
  response: Response;
}

/**
 * Decodes a tool call, runs it, and returns both renderings. A non-zero exit
 * code is a result, not a rejection: only a malformed call or a broken session
 * throws.
 */
export async function callTool(
  session: ToolSession,
  args: string | Record<string, unknown>,
  timeoutMs?: number,
): Promise<ToolResult> {
  const req = decodeArgs(args);
  const response = await session.exec(req, timeoutMs);
  return { text: renderResult(response), response };
}

/**
 * Formats a response as the tool result text for a model. Mirrors tool.Render
 * in Go byte for byte — see tests/tool/render-cases.json.
 *
 * duration_ms is deliberately absent: the rendering is asserted verbatim by the
 * mock caller, and a wall-clock number would make every transcript unstable.
 * Callers that want the timing have the raw response.
 */
export function renderResult(r: Response): string {
  const flags: string[] = [];
  if (r.timed_out) {
    flags.push("timed out");
  }
  if (r.truncated) {
    flags.push("output truncated");
  }
  let out = `exit_code: ${r.exit_code}`;
  if (flags.length > 0) {
    out += ` [${flags.join(", ")}]`;
  }
  out += "\n";
  if (r.error) {
    out += `error: ${r.error}\n`;
  }
  let wrote = false;
  if (r.stdout.length > 0) {
    out += block("stdout", r.stdout);
    wrote = true;
  }
  if (r.stderr.length > 0) {
    out += block("stderr", r.stderr);
    wrote = true;
  }
  if (!wrote && !r.error) {
    out += "\n(no output)\n";
  }
  return out;
}

// Exactly one trailing newline comes off: shell output almost always ends in
// one, and keeping it would put a blank line before the closing tag.
function block(name: string, data: string): string {
  const body = data.endsWith("\n") ? data.slice(0, -1) : data;
  return `\n<${name}>\n${body}\n</${name}>\n`;
}
