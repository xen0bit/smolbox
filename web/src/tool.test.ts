import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "./protocol.ts";
import { OpExec } from "./protocol.ts";
import {
  ToolArgumentError,
  anthropicTool,
  callTool,
  decodeArgs,
  inputSchema,
  openaiTool,
  renderResult,
  toolDescription,
  toolName,
} from "./tool.ts";

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
}

// The generated files come from the Go types. Deep-equality against them is the
// whole reason this TS twin can be trusted: a description edited on one side,
// a field added on the other, and these fail.
describe("the definition matches the generated Go artifacts", () => {
  test("anthropic dialect", () => {
    expect(anthropicTool()).toEqual(
      readJson("../../docs/schema/run_terminal_command.anthropic.json") as ReturnType<typeof anthropicTool>,
    );
  });

  test("openai dialect", () => {
    expect(openaiTool()).toEqual(
      readJson("../../docs/schema/run_terminal_command.openai.json") as ReturnType<typeof openaiTool>,
    );
  });

  test("the input schema hides op and requires cmd", () => {
    expect(inputSchema.properties?.op).toBeUndefined();
    expect(inputSchema.required).toEqual(["cmd"]);
    expect(toolName).toBe("run_terminal_command");
    expect(toolDescription).toContain("/mnt/host");
  });
});

describe("decodeArgs", () => {
  test("a minimal call becomes an exec request", () => {
    expect(decodeArgs('{"cmd":"echo hello"}')).toEqual({ op: OpExec, cmd: "echo hello" });
  });

  test("accepts an already-parsed object", () => {
    expect(decodeArgs({ cmd: "echo hello" })).toEqual({ op: OpExec, cmd: "echo hello" });
  });

  test("carries every optional argument", () => {
    const req = decodeArgs({
      cmd: "cat",
      cwd: "/tmp",
      env: { FOO: "bar" },
      stdin: "aGk=",
      timeout_ms: 500,
      max_output: 1024,
    });
    expect(req.cmd).toBe("cat");
    expect(req.cwd).toBe("/tmp");
    expect(req.env).toEqual({ FOO: "bar" });
    expect(req.timeout_ms).toBe(500);
    expect(req.max_output).toBe(1024);
    // Decoded to bytes, not left as base64: encodeRequest base64s a string
    // stdin, so leaving it would send the guest "aGk=" double-encoded.
    expect(req.stdin).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(req.stdin as Uint8Array)).toBe("hi");
  });

  for (const [name, args, want] of [
    ["missing cmd", "{}", "cmd is required"],
    ["blank cmd", '{"cmd":"  "}', "cmd is required"],
    ["hallucinated field", '{"cmd":"ls","recursive":true}', "unknown field"],
    ["op injection", '{"cmd":"ls","op":"shutdown"}', "may not set op"],
    ["op echoed back", '{"cmd":"ls","op":"exec"}', "may not set op"],
    ["negative timeout", '{"cmd":"ls","timeout_ms":-1}', "timeout_ms must not be negative"],
    ["negative max_output", '{"cmd":"ls","max_output":-1}', "max_output must not be negative"],
    ["fractional timeout", '{"cmd":"ls","timeout_ms":1.5}', "must be an integer"],
    ["cmd of the wrong type", '{"cmd":42}', "cmd must be a string"],
    ["env of the wrong type", '{"cmd":"ls","env":{"A":1}}', "env must be an object of strings"],
    ["an array", "[1,2]", "expected a JSON object"],
    ["a bare string", '"ls"', "expected a JSON object"],
    ["malformed json", '{"cmd":', "decode arguments"],
  ] as const) {
    test(`rejects: ${name}`, () => {
      expect(() => decodeArgs(args)).toThrow(want);
      expect(() => decodeArgs(args)).toThrow(ToolArgumentError);
    });
  }
});

// The golden table the Go tests also run. Both implementations must produce
// `want` byte for byte.
interface RenderCase {
  name: string;
  response: Partial<Record<"exit_code", number>> & Partial<Response>;
  want: string;
}

describe("renderResult matches the shared goldens", () => {
  const table = readJson("../../tests/tool/render-cases.json") as { cases: RenderCase[] };
  expect(table.cases.length).toBeGreaterThan(0);
  for (const c of table.cases) {
    test(c.name, () => {
      const resp: Response = {
        seq: 0,
        exit_code: c.response.exit_code ?? 0,
        stdout: c.response.stdout ?? "",
        stderr: c.response.stderr ?? "",
        timed_out: c.response.timed_out ?? false,
        truncated: c.response.truncated ?? false,
        duration_ms: 0,
        error: c.response.error,
      };
      expect(renderResult(resp)).toBe(c.want);
    });
  }
});

describe("callTool", () => {
  function fakeSession(resp: Partial<Response>): { seen: Request[]; exec(r: Request): Promise<Response> } {
    const seen: Request[] = [];
    return {
      seen,
      exec(r: Request): Promise<Response> {
        seen.push(r);
        return Promise.resolve({
          seq: 1,
          exit_code: 0,
          stdout: "",
          stderr: "",
          timed_out: false,
          truncated: false,
          duration_ms: 42,
          ...resp,
        });
      },
    };
  }

  test("renders the result and keeps the raw response", async () => {
    const s = fakeSession({ stdout: "hi\n" });
    const { text, response } = await callTool(s, '{"cmd":"echo hi"}');
    expect(s.seen).toEqual([{ op: OpExec, cmd: "echo hi" }]);
    expect(text).toBe("exit_code: 0\n\n<stdout>\nhi\n</stdout>\n");
    // Render drops the duration; the host still gets it.
    expect(response.duration_ms).toBe(42);
    expect(text).not.toContain("42");
  });

  test("a bad call never reaches the session", async () => {
    const s = fakeSession({});
    await expect(callTool(s, '{"cmd":"ls","op":"shutdown"}')).rejects.toThrow("may not set op");
    expect(s.seen).toEqual([]);
  });

  test("a non-zero exit is a result, not a rejection", async () => {
    const s = fakeSession({ exit_code: 3, stderr: "nope\n" });
    const { text, response } = await callTool(s, '{"cmd":"false"}');
    expect(response.exit_code).toBe(3);
    expect(text).toBe("exit_code: 3\n\n<stderr>\nnope\n</stderr>\n");
  });
});
