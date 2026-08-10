import { describe, expect, test } from "bun:test";

import { ToolCallParseError } from "../parse.ts";
import { qwen35 } from "./qwen35.ts";

describe("qwen3.5 dialect (<tool_call> XML)", () => {
  // What onnx-community/Qwen3.5-0.8B-Text-ONNX at q4 actually emitted on WebGPU,
  // verbatim, for "List the files in /mnt/host using the tool, then tell me
  // what is there." This is what `verified: true` asserts the existence of —
  // and it is also the transcript that disproved the entry's first dialect
  // (PLAN §10.20). Note the DUPLICATE `</parameter>`: the model closed one more
  // than it opened, and this is the fixture that keeps the parser tolerant of
  // it, because a real model did it on the very first turn ever run.
  const CAPTURED =
    "<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\nls /mnt/host\n</parameter>\n" +
    "<parameter=max_output>\n1024\n</parameter>\n</parameter>\n</function>\n</tool_call><|im_end|>";

  test("CAPTURED: a real turn from Qwen3.5 0.8B at q4", () => {
    const turn = qwen35.parseTurn(CAPTURED);
    expect(turn.calls).toEqual([
      { name: "run_terminal_command", args: { cmd: "ls /mnt/host", max_output: 1024 } },
    ]);
    expect(turn.text).toBe("");
  });

  // The half decodeArgs cares about: `cmd` must reach it as a string and
  // `max_output` as a real integer. The XML wire has neither type, so getting
  // this wrong fails the call after a correct parse.
  test("CAPTURED: numeric parameters arrive as numbers, text as text", () => {
    const [call] = qwen35.parseTurn(CAPTURED).calls;
    expect(typeof call!.args.cmd).toBe("string");
    expect(typeof call!.args.max_output).toBe("number");
  });

  test("a command containing JSON-ish punctuation stays a string", () => {
    const turn = qwen35.parseTurn(
      "<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\n" +
        "grep -r '{\"a\": 1}' /mnt/host\n</parameter>\n</function>\n</tool_call>",
    );
    expect(turn.calls[0]!.args.cmd).toBe("grep -r '{\"a\": 1}' /mnt/host");
  });

  test("prose outside the block survives, markers do not", () => {
    const turn = qwen35.parseTurn(
      "Let me look.\n<tool_call>\n<function=run_terminal_command>\n" +
        "<parameter=cmd>\nls\n</parameter>\n</function>\n</tool_call>",
    );
    expect(turn.text).toBe("Let me look.");
    expect(turn.calls).toHaveLength(1);
  });

  test("reasoning is separated rather than shown as prose", () => {
    const turn = qwen35.parseTurn("<think>\nI should list it.\n</think>Here you go.");
    expect(turn.reasoning).toBe("I should list it.");
    expect(turn.text).toBe("Here you go.");
  });

  test("two calls in one turn", () => {
    const turn = qwen35.parseTurn(
      "<tool_call>\n<function=a>\n<parameter=cmd>\nls\n</parameter>\n</function>\n</tool_call>" +
        "<tool_call>\n<function=b>\n<parameter=cmd>\npwd\n</parameter>\n</function>\n</tool_call>",
    );
    expect(turn.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("a parameterless call is a call, not an error", () => {
    const turn = qwen35.parseTurn("<tool_call>\n<function=list_dir>\n</function>\n</tool_call>");
    expect(turn.calls).toEqual([{ name: "list_dir", args: {} }]);
  });

  test("a block naming no function is a parse error, not a silent skip", () => {
    expect(() => qwen35.parseTurn("<tool_call>\n{\"name\": \"x\"}\n</tool_call>")).toThrow(
      ToolCallParseError,
    );
  });

  // The streaming view: a marker reaching the chat log is the bug this exists
  // to prevent, and the outer markers here are hermes'.
  test("preview never leaks a marker mid-stream", () => {
    const partial = "Working.\n<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\nls";
    const view = qwen35.preview(partial);
    expect(view.text).not.toContain("<tool_call>");
    expect(view.text).not.toContain("<function=");
  });
});
