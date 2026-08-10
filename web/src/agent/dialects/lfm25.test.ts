import { describe, expect, test } from "bun:test";

import { ToolCallParseError } from "../parse.ts";
import { parseTurn } from "./lfm25.ts";

const wrap = (body: string) => `<|tool_call_start|>${body}<|tool_call_end|>`;

// The syntax half is LFM2's and covered in depth by lfm2.test.ts; what is
// checked here is that it still holds after the reasoning channel is removed.
describe("parseTurn: LFM2.5 keeps LFM2's call syntax", () => {
  test("a Pythonic call", () => {
    const turn = parseTurn(wrap('[run_terminal_command(cmd="ls /mnt/host")]'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "ls /mnt/host" } }]);
  });

  test("a JSON call", () => {
    const turn = parseTurn(wrap('[{"name": "run_terminal_command", "arguments": {"cmd": "pwd"}}]'));
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "pwd" } }]);
  });

  test("an unterminated block is still an error, not a guess", () => {
    expect(() => parseTurn('<|tool_call_start|>[f(cmd="ls"')).toThrow(ToolCallParseError);
  });

  test("chat special tokens are stripped from the text", () => {
    expect(parseTurn("thinking</think><|im_start|>assistant\nhello<|im_end|>").text).toBe(
      "assistant\nhello",
    );
  });
});

// The reason this dialect exists. LFM2.5's chat template ends the generation
// prompt with a bare `<think>`, so the completion opens inside the scratchpad
// and only ever emits the closing tag.
describe("parseTurn: the reasoning channel", () => {
  test("reasoning ahead of an unpaired </think> is not the answer", () => {
    const turn = parseTurn("The user wants a listing, so I should run ls.</think>Here you go.");
    expect(turn.text).toBe("Here you go.");
    expect(turn.calls).toEqual([]);
  });

  test("a tool call after the reasoning survives it", () => {
    const turn = parseTurn(`I need to look first.</think>${wrap('[run_terminal_command(cmd="ls")]')}`);
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "ls" } }]);
    expect(turn.text).toBe("");
  });

  test("a whole <think>…</think> block the model opened itself is removed", () => {
    expect(parseTurn("<think>counting the files</think>There are three.").text).toBe("There are three.");
  });

  test("only the first </think> closes the prompt's block", () => {
    // A model quoting the tag back at the user must not swallow the answer up
    // to the last one it wrote.
    const turn = parseTurn("thinking</think>The tag is written </think> like this.");
    expect(turn.text).toBe("The tag is written </think> like this.");
  });

  test("a completion with no </think> at all is all reasoning, and still kept", () => {
    // The prompt opened the block, so a completion that never closes it never
    // left the scratchpad — reasoning that hit max_new_tokens. This used to be
    // reported as the answer, on the grounds that blanking the turn was the
    // worse guess. Now that reasoning is a channel of its own rather than
    // something the parser drops, nothing is lost by naming it correctly.
    const turn = parseTurn("Let me think about what the user is asking for and");
    expect(turn.text).toBe("");
    expect(turn.reasoning).toBe("Let me think about what the user is asking for and");
  });

  test("reasoning is handed back separately, not merged into the answer", () => {
    const turn = parseTurn("The user wants a listing.</think>There are three files.");
    expect(turn.reasoning).toBe("The user wants a listing.");
    expect(turn.text).toBe("There are three files.");
  });

  test("a block reopened and left unclosed drops only the tail", () => {
    const turn = parseTurn("thinking</think>Three files.<think>although maybe");
    expect(turn.text).toBe("Three files.");
  });
});

// Every case above is constructed. lfm2.test.ts has "a real captured turn",
// because that fixture is what `verified: true` asserts — the dialect was
// promoted ahead of this one, so this is the debt.
//
// To take the capture: `make model MODEL=lfm2.5-2.6b`, `make serve`, open
// /agent/, pick LFM2.5 2.6B, mount a folder, ask something that needs the tool,
// then in the console:
//
//   copy(JSON.stringify(__smolagent.messages(), null, 2))
//
// The assistant entries hold the completion verbatim — `</think>` and the
// tool-call markers included — which is exactly what parseTurn is fed.
test.todo("a real captured turn from LFM2.5-2.6B at q4", () => {
  // A body, because `test.todo` needs one to typecheck, and a throwing one so
  // that running the suite with --todo reports the gap rather than a pass.
  throw new Error("no transcript captured yet");
});
