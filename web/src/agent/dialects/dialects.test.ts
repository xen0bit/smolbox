import { describe, expect, test } from "bun:test";

import { ToolCallParseError } from "../parse.ts";
import { describeError } from "../messages.ts";
import {
  CHAT_TEMPLATE_FILE,
  DEFAULT_MODEL_KEY,
  OPTIONAL_FILES,
  chatTemplateUrl,
  models,
  modelFor,
  pickDtype,
} from "../models.ts";
import { dialectFor, dialects } from "./index.ts";
import { hermes } from "./hermes.ts";
import { llama } from "./llama.ts";

describe("hermes dialect (Qwen-style)", () => {
  // What onnx-community/Qwen2.5-0.5B-Instruct at q4 actually emitted on WebGPU,
  // verbatim including the trailing <|im_end|>, for
  // "Use the tool to run `cat /mnt/host/hello.txt` and tell me the contents."
  // This is what `verified: true` on this dialect asserts the existence of.
  test("CAPTURED: a real turn from Qwen2.5 0.5B Instruct at q4", () => {
    const raw =
      '<tool_call>\n{"name": "run_terminal_command", "arguments": {"cmd": "cat /mnt/host/hello.txt", "timeout_ms": 500}}\n</tool_call><|im_end|>';
    const turn = hermes.parseTurn(raw);
    expect(turn.calls).toEqual([
      { name: "run_terminal_command", args: { cmd: "cat /mnt/host/hello.txt", timeout_ms: 500 } },
    ]);
    // The turn was only a call, so there is no prose and the marker is gone.
    expect(turn.text).toBe("");
  });

  // The same model, same session, inventing a tool that does not exist. Kept
  // because it is the failure the registry has to report as correctable rather
  // than as a parse error: the syntax was fine, the name was not.
  test("CAPTURED: a hallucinated tool name parses cleanly and fails later", () => {
    const turn = hermes.parseTurn('<tool_call>\n{"name": "ls", "arguments": {}}\n</tool_call><|im_end|>');
    expect(turn.calls).toEqual([{ name: "ls", args: {} }]);
  });

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

  // Every field here is spread into transformers.js' generate(), where an
  // unknown name is ignored rather than rejected — so a typo would look like
  // the checkpoint misbehaving.
  test("declared sampling settings are ones the runtime implements", () => {
    // eos_token_id is checked the same way as the rest — it is a real
    // GenerationConfig field, verified against the bundle before being added
    // (PLAN §10.20) — even though it is a correctness override rather than a
    // preference. The point of this list is that generate() ignores what it
    // does not know, and that is true of stop tokens as much as temperature.
    const known = new Set([
      "do_sample",
      "temperature",
      "top_p",
      "top_k",
      "repetition_penalty",
      "max_new_tokens",
      "eos_token_id",
    ]);
    for (const m of models) {
      for (const k of Object.keys(m.generation ?? {})) {
        expect(known.has(k), `${m.key} declares an unknown sampling field: ${k}`).toBe(true);
      }
    }
  });

  test("an unknown key names the ones that exist", () => {
    expect(() => modelFor("nope")).toThrow(/known:/);
  });

  // A repo that keeps its template only in chat_template.jinja loads fine and
  // then throws on the first turn, because transformers.js' tokenizer reads an
  // inline template and nothing else. Newer HF exports increasingly prefer the
  // standalone file, so the URL has to follow the weights rather than assume.
  test("the chat template is read from the same place the weights are", () => {
    const entry = modelFor("gemma4-e2b-onnx");
    expect(chatTemplateUrl(entry, true)).toBe(`/models/${entry.repo}/${CHAT_TEMPLATE_FILE}`);
    expect(chatTemplateUrl(entry, false)).toBe(
      `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${CHAT_TEMPLATE_FILE}`,
    );
  });

  test("the hub URL pins the revision, so it cannot drift from the fetched copy", () => {
    for (const m of models) {
      expect(chatTemplateUrl(m, false)).toContain(`/resolve/${m.revision}/`);
    }
  });

  test("the fetcher pulls the standalone template, so a local load can find it", () => {
    expect(OPTIONAL_FILES).toContain(CHAT_TEMPLATE_FILE);
  });
});

// What reaches the page when the worker throws. The scan page showed five
// anonymous Firefox frames and no message for exactly this reason.
describe("describeError", () => {
  test("a V8 stack, which already carries the message, is passed through", () => {
    const err = new Error("chat_template is not set");
    err.stack = "Error: chat_template is not set\n    at generate (model-worker.js:1:1)";
    expect(describeError(err)).toBe(err.stack);
  });

  test("a SpiderMonkey stack, which does not, gets the message prepended", () => {
    const err = new Error("chat_template is not set");
    err.stack = "get_chat_template@http://localhost:8080/agent/model-worker.js:13623:15";
    const out = describeError(err);
    expect(out.startsWith("chat_template is not set\n")).toBe(true);
    expect(out).toContain("get_chat_template@");
  });

  test("an error with no stack still says what went wrong", () => {
    const err = new Error("boom");
    err.stack = undefined;
    expect(describeError(err)).toBe("boom");
  });

  test("a thrown non-Error is stringified rather than dropped", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(undefined)).toBe("undefined");
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
