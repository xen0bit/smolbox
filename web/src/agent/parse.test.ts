import { describe, expect, test } from "bun:test";

import { ToolCallParseError, parseTurn } from "./parse.ts";

const wrap = (body: string) => `<|tool_call_start|>${body}<|tool_call_end|>`;

describe("parseTurn", () => {
  test("a list containing one call", () => {
    const turn = parseTurn(wrap('[{"name": "run_terminal_command", "arguments": {"cmd": "ls /mnt/host"}}]'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "ls /mnt/host" } }]);
    expect(turn.text).toBe("");
  });

  test("a bare object, not wrapped in a list", () => {
    const turn = parseTurn(wrap('{"name": "run_terminal_command", "arguments": {"cmd": "pwd"}}'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "pwd" } }]);
  });

  test("stringified arguments, the OpenAI dialect habit", () => {
    const turn = parseTurn(wrap('[{"name": "run_terminal_command", "arguments": "{\\"cmd\\": \\"pwd\\"}"}]'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "pwd" } }]);
  });

  test("`parameters` is accepted as an alias for `arguments`", () => {
    const turn = parseTurn(wrap('[{"name": "run_terminal_command", "parameters": {"cmd": "id"}}]'));
    expect(turn.calls[0]?.args).toEqual({ cmd: "id" });
  });

  test("a call with no arguments at all", () => {
    const turn = parseTurn(wrap('[{"name": "run_terminal_command"}]'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: {} }]);
  });

  test("several calls in one block", () => {
    const turn = parseTurn(
      wrap('[{"name": "a", "arguments": {"cmd": "1"}}, {"name": "b", "arguments": {"cmd": "2"}}]'),
    );
    expect(turn.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("several blocks in one turn", () => {
    const turn = parseTurn(`${wrap('[{"name": "a", "arguments": {}}]')} and then ${wrap('[{"name": "b", "arguments": {}}]')}`);
    expect(turn.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("prose around a call is kept as text and the block removed", () => {
    const turn = parseTurn(`Let me look. ${wrap('[{"name": "x", "arguments": {}}]')} Done.`);
    expect(turn.text).toBe("Let me look.  Done.");
    expect(turn.calls).toHaveLength(1);
  });

  test("a plain text answer is not an error", () => {
    const turn = parseTurn("There are three files in that folder.");
    expect(turn.calls).toEqual([]);
    expect(turn.text).toBe("There are three files in that folder.");
  });

  test("chat special tokens are stripped from the text", () => {
    const turn = parseTurn("<|im_start|>assistant\nhello<|im_end|>");
    expect(turn.text).toBe("assistant\nhello");
  });

  // The failure modes below are the ones the spike needs named rather than
  // silently swallowed: each says something different about what went wrong.
  test("an unterminated block reports a truncated generation", () => {
    expect(() => parseTurn('<|tool_call_start|>[{"name": "x"')).toThrow(ToolCallParseError);
    expect(() => parseTurn('<|tool_call_start|>[{"name": "x"')).toThrow(/unterminated/);
  });

  test("malformed Pythonic reports where it gave up", () => {
    expect(() => parseTurn(wrap('[run_terminal_command(cmd=)]'))).toThrow(ToolCallParseError);
  });

  test("malformed JSON reports the parse error", () => {
    expect(() => parseTurn(wrap('[{"name": }]'))).toThrow(/not valid JSON/);
  });

  test("an empty block is an error", () => {
    expect(() => parseTurn(wrap("   "))).toThrow(/empty/);
  });

  test("a call without a name is an error", () => {
    expect(() => parseTurn(wrap('[{"arguments": {"cmd": "ls"}}]'))).toThrow(/missing a string `name`/);
  });

  test("non-object arguments are an error", () => {
    expect(() => parseTurn(wrap('[{"name": "x", "arguments": ["ls"]}]'))).toThrow(/must be an object/);
  });

  test("a non-object call is an error", () => {
    expect(() => parseTurn(wrap('["run_terminal_command"]'))).toThrow(/must be an object/);
  });
});

// This is the syntax the model actually emits (M8). The first case is a verbatim
// turn captured from a real run against testdata/mount.
describe("parseTurn: Pythonic calls", () => {
  test("a real captured turn", () => {
    const turn = parseTurn(
      wrap('[run_terminal_command(cmd="ls /mnt/host", cwd="/mnt/host", env={}, stdin="", timeout_ms=0, max_output=0)]'),
    );
    expect(turn.calls).toEqual([
      {
        name: "run_terminal_command",
        args: { cmd: "ls /mnt/host", cwd: "/mnt/host", env: {}, stdin: "", timeout_ms: 0, max_output: 0 },
      },
    ]);
  });

  test("None arguments are dropped, not passed through as null", () => {
    // decodeArgs type-checks every present field, so a None that survived as
    // null would be rejected as "stdin must be a string" — but None means the
    // model declined to set it.
    const turn = parseTurn(wrap('[run_terminal_command(cmd="pwd", stdin=None)]'));
    expect(turn.calls[0]!.args).toEqual({ cmd: "pwd" });
    expect("stdin" in turn.calls[0]!.args).toBe(false);
  });

  test("a call without the surrounding list", () => {
    const turn = parseTurn(wrap('run_terminal_command(cmd="pwd")'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "pwd" } }]);
  });

  test("several Pythonic calls", () => {
    const turn = parseTurn(wrap('[a(cmd="1"), b(cmd="2")]'));
    expect(turn.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("no arguments at all", () => {
    expect(parseTurn(wrap("[run_terminal_command()]")).calls).toEqual([
      { name: "run_terminal_command", args: {} },
    ]);
  });

  test("single quotes, escapes, and embedded quotes", () => {
    const turn = parseTurn(wrap(`[run_terminal_command(cmd='echo "hi"\\nthere')]`));
    expect(turn.calls[0]!.args.cmd).toBe('echo "hi"\nthere');
  });

  test("a quoted string containing a comma or paren is not split", () => {
    const turn = parseTurn(wrap('[run_terminal_command(cmd="echo a,b (c)")]'));
    expect(turn.calls[0]!.args.cmd).toBe("echo a,b (c)");
  });

  test("populated dicts and lists", () => {
    const turn = parseTurn(wrap('[f(env={"A": "1", "B": "2"}, xs=[1, 2, 3])]'));
    expect(turn.calls[0]!.args).toEqual({ env: { A: "1", B: "2" }, xs: [1, 2, 3] });
  });

  test("booleans and negative numbers", () => {
    const turn = parseTurn(wrap("[f(a=True, b=False, c=-5, d=1.5)]"));
    expect(turn.calls[0]!.args).toEqual({ a: true, b: false, c: -5, d: 1.5 });
  });

  test("an unterminated string is an error", () => {
    expect(() => parseTurn(wrap('[f(cmd="ls)]'))).toThrow(/unterminated string/);
  });

  test("trailing junk after the call is an error", () => {
    expect(() => parseTurn(wrap('[f(cmd="ls")] extra'))).toThrow(/trailing text/);
  });
});
