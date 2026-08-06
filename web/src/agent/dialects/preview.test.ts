// The live view of a partial completion, per dialect.
//
// This is the half of the chat UI that CI can reach. The page used to hold one
// hardcoded `<|tool_call_start|>` for every family, so Qwen, Antares and Llama
// streamed their raw call syntax into the log as if it were prose, and LFM2.5
// streamed its entire scratchpad as the answer and then replaced it when the
// turn finished. Both are "the parsing looks wonky but still works" from the
// outside, and neither had a test.

import { describe, expect, test } from "bun:test";

import { splitThinking } from "../parse.ts";
import { dialects } from "./index.ts";
import { antares } from "./antares.ts";
import { hermes } from "./hermes.ts";
import { lfm2 } from "./lfm2.ts";
import { lfm25 } from "./lfm25.ts";
import { llama } from "./llama.ts";

// One partial call per family, cut mid-marker the way a stream delivers it.
const partial: Record<string, string> = {
  lfm2: 'Let me look. <|tool_call_start|>[run_terminal_command(cmd="ls',
  "lfm2.5": 'thinking</think>Let me look. <|tool_call_start|>[run_terminal_command(cmd="ls',
  hermes: 'Let me look. <tool_call>{"name": "run_terminal_command", "argum',
  antares: 'thinking</think>Let me look. <tool_call>{"name": "terminal", "comm',
  llama: 'Let me look. <|python_tag|>{"name": "run_terminal_command"',
};

describe("every dialect previews a partial turn", () => {
  for (const [name, dialect] of Object.entries(dialects)) {
    test(`${name}: an unfinished call never reaches the log as prose`, () => {
      const p = dialect.preview(partial[name]!);
      expect(p.pendingCall, `${name} did not notice the open call`).toBe(true);
      expect(p.text).toBe("Let me look.");
      // Not one character of the call syntax leaks into the visible text.
      for (const marker of ["<|tool_call_start|>", "<tool_call>", "<|python_tag|>", "run_terminal_command", "terminal"]) {
        expect(p.text, `${name} leaked ${marker}`).not.toContain(marker);
      }
    });

    test(`${name}: a completed call leaves only the prose around it`, () => {
      const done = dialect.parseTurn(complete[name]!);
      const p = dialect.preview(complete[name]!);
      expect(done.calls.length, `${name} parsed no call from its own fixture`).toBe(1);
      expect(p.pendingCall).toBe(false);
      expect(p.text).toBe("Let me look.");
    });

    test(`${name}: plain prose previews as itself`, () => {
      const p = dialect.preview(prose[name]!);
      expect(p.text).toBe("There are three files.");
      expect(p.pendingCall).toBe(false);
    });
  }
});

const complete: Record<string, string> = {
  lfm2: 'Let me look. <|tool_call_start|>[run_terminal_command(cmd="ls")]<|tool_call_end|>',
  "lfm2.5": 'thinking</think>Let me look. <|tool_call_start|>[run_terminal_command(cmd="ls")]<|tool_call_end|>',
  hermes: 'Let me look. <tool_call>{"name": "run_terminal_command", "arguments": {"cmd": "ls"}}</tool_call>',
  antares: 'thinking</think>Let me look. <tool_call>{"name": "terminal", "command": "ls"}</tool_call>',
  llama: 'Let me look. <|python_tag|>{"name": "run_terminal_command", "arguments": {"cmd": "ls"}}<|eom_id|>',
};

const prose: Record<string, string> = {
  lfm2: "There are three files.",
  "lfm2.5": "counting them</think>There are three files.",
  hermes: "<think>counting them</think>There are three files.",
  antares: "counting them</think>There are three files.",
  llama: "There are three files.",
};

describe("reasoning is previewed as reasoning, never as the answer", () => {
  test("LFM2.5 mid-thought shows thinking and no prose", () => {
    // The prompt opened the block, so this whole completion is scratchpad. It
    // used to stream into the chat bubble as if it were the reply.
    const p = lfm25.preview("The user wants a listing, so I should run ls");
    expect(p.text).toBe("");
    expect(p.reasoning).toBe("The user wants a listing, so I should run ls");
  });

  test("LFM2.5 after the close shows the answer and keeps the thinking", () => {
    const p = lfm25.preview("The user wants a listing.</think>There are three files.");
    expect(p.text).toBe("There are three files.");
    expect(p.reasoning).toBe("The user wants a listing.");
  });

  test("Qwen3 opens and closes its own block", () => {
    const p = hermes.preview("<think>counting</think>There are three.");
    expect(p.reasoning).toBe("counting");
    expect(p.text).toBe("There are three.");
  });

  test("Antares reasons before every call, and the reasoning is not the answer", () => {
    const p = antares.preview("I should search the repo</think>");
    expect(p.reasoning).toBe("I should search the repo");
    expect(p.text).toBe("");
  });

  test("a family with no reasoning channel reports none", () => {
    expect(lfm2.preview("There are three files.").reasoning).toBe("");
    expect(llama.preview("There are three files.").reasoning).toBe("");
  });
});

describe("splitThinking", () => {
  test("none passes everything through", () => {
    expect(splitThinking("<think>a</think>b", "none")).toEqual({ text: "<think>a</think>b", reasoning: "" });
  });

  test("tagged keeps text outside the block on both sides", () => {
    expect(splitThinking("before<think>a</think>after", "tagged")).toEqual({
      text: "beforeafter",
      reasoning: "a",
    });
  });

  test("tagged treats an unclosed block as reasoning to the end", () => {
    expect(splitThinking("before<think>a and", "tagged")).toEqual({ text: "before", reasoning: "a and" });
  });

  test("prompt-opened collects a block the model reopened after answering", () => {
    const out = splitThinking("first</think>answer<think>second</think>more", "prompt-opened");
    expect(out.text).toBe("answermore");
    expect(out.reasoning).toBe("first\nsecond");
  });

  test("prompt-opened leaves a second close where the model wrote it", () => {
    // A model quoting the tag at the user must not lose the answer up to it.
    const out = splitThinking("thinking</think>write </think> like this", "prompt-opened");
    expect(out.text).toBe("write </think> like this");
  });
});
