import { describe, expect, test } from "bun:test";

import { ToolCallParseError } from "../parse.ts";
import { DEFAULT_MODEL_KEY, models, modelFor, pickDtype } from "../models.ts";
import { dialectFor, dialects } from "./index.ts";
import { hermes } from "./hermes.ts";
import { llama } from "./llama.ts";

describe("hermes dialect (Qwen-style)", () => {
  test("a single <tool_call> block", () => {
    const turn = hermes.parseTurn(
      '<tool_call>\n{"name": "run_terminal_command", "arguments": {"cmd": "ls /mnt/host"}}\n</tool_call>',
    );
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "ls /mnt/host" } }]);
  });

  test("two blocks in one turn", () => {
    const turn = hermes.parseTurn(
      '<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "b", "arguments": {}}</tool_call>',
    );
    expect(turn.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("prose is kept and the block removed", () => {
    const turn = hermes.parseTurn('Let me look. <tool_call>{"name": "a", "arguments": {}}</tool_call>');
    expect(turn.text).toBe("Let me look.");
    expect(turn.calls).toHaveLength(1);
  });

  test("Qwen3 <think> blocks are not shown as prose", () => {
    const turn = hermes.parseTurn("<think>The user wants a listing.</think>Here you go.");
    expect(turn.text).toBe("Here you go.");
  });

  test("a plain answer is not a call", () => {
    expect(hermes.parseTurn("There are three files.").calls).toEqual([]);
  });

  test("an unterminated block is an error, not a guess", () => {
    expect(() => hermes.parseTurn('<tool_call>{"name": "a"')).toThrow(ToolCallParseError);
  });
});

describe("llama dialect", () => {
  test("a python_tag call", () => {
    const turn = llama.parseTurn(
      '<|python_tag|>{"name": "run_terminal_command", "arguments": {"cmd": "pwd"}}<|eom_id|>',
    );
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "pwd" } }]);
  });

  test("a python_tag call with no eom terminator", () => {
    const turn = llama.parseTurn('<|python_tag|>{"name": "x", "arguments": {"cmd": "pwd"}}');
    expect(turn.calls).toHaveLength(1);
  });

  test("prose before the tag is kept", () => {
    const turn = llama.parseTurn('Checking. <|python_tag|>{"name": "x", "arguments": {}}<|eom_id|>');
    expect(turn.text).toBe("Checking.");
  });

  test("a bare JSON call with no tag", () => {
    const turn = llama.parseTurn('{"name": "run_terminal_command", "arguments": {"cmd": "id"}}');
    expect(turn.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "id" } }]);
  });

  // The dangerous direction: a model quoting JSON at the user must not be
  // turned into a command execution.
  test("JSON that is not a call stays prose", () => {
    const turn = llama.parseTurn('{"some": "config", "value": 1}');
    expect(turn.calls).toEqual([]);
    expect(turn.text).toContain("config");
  });

  test("prose that merely mentions JSON stays prose", () => {
    const turn = llama.parseTurn('You could write {"name": "x"} in the file.');
    expect(turn.calls).toEqual([]);
  });
});

describe("the dialect registry", () => {
  test("every dialect is reachable by name", () => {
    for (const [name, d] of Object.entries(dialects)) {
      expect(dialectFor(name as keyof typeof dialects)).toBe(d);
      expect(d.name).toBe(name);
    }
  });

  // The verified/unverified split is the whole point (PLAN §10.4): a dialect
  // written from documentation is a hypothesis until a real transcript exists.
  test("only lfm2 is verified, and unverified dialects explain themselves", () => {
    expect(dialects.lfm2.verified).toBe(true);
    for (const d of Object.values(dialects)) {
      if (!d.verified) {
        expect(d.note, `${d.name} must say why it is unverified`).toBeTruthy();
      }
    }
  });
});

describe("the model registry", () => {
  test("the default entry exists and is the verified one", () => {
    const entry = modelFor(DEFAULT_MODEL_KEY);
    expect(dialectFor(entry.dialect).verified).toBe(true);
  });

  test("every entry pins a full 40-character revision", () => {
    for (const m of models) {
      expect(m.revision, `${m.key} must pin a full sha`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("every entry names a known dialect and at least one dtype", () => {
    for (const m of models) {
      expect(() => dialectFor(m.dialect)).not.toThrow();
      expect(m.dtypes.length).toBeGreaterThan(0);
    }
  });

  test("keys are unique", () => {
    expect(new Set(models.map((m) => m.key)).size).toBe(models.length);
  });

  test("an unknown key names the ones that exist", () => {
    expect(() => modelFor("nope")).toThrow(/known:/);
  });

  test("f16 quantizations are skipped when the adapter lacks shader-f16", () => {
    const entry = modelFor(DEFAULT_MODEL_KEY);
    expect(pickDtype(entry, new Set())).toBe("q4");
    expect(pickDtype(entry, new Set(["shader-f16"]))).toBe("q4");
  });

  test("an f16-only entry is unrunnable without the feature, and says so by returning undefined", () => {
    const f16Only = { ...modelFor(DEFAULT_MODEL_KEY), dtypes: ["q4f16" as const] };
    expect(pickDtype(f16Only, new Set())).toBeUndefined();
    expect(pickDtype(f16Only, new Set(["shader-f16"]))).toBe("q4f16");
  });
});
