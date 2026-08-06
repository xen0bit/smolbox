// Fixtures here are real Antares output, not invented shapes.
//
// Every string marked CAPTURED came out of fdtn-ai/antares-1b at fp16 during the
// M12 conversion work (PLAN §11.10), running the antares-cli's exact system
// prompt through the checkpoint's own chat template. That provenance is the
// point: PLAN §10.2 says a dialect is only `verified` once a transcript backs
// it, and these are the transcripts.

import { describe, expect, test } from "bun:test";
import { ToolCallParseError } from "../parse.ts";
import { antares, parseTurn } from "./antares.ts";

describe("antares dialect", () => {
  test("is marked verified, because captured transcripts back it", () => {
    expect(antares.verified).toBe(true);
  });

  test("CAPTURED: flattened arguments at the top level", () => {
    // The single most important case. This is what the model actually emits,
    // and both its own chat template and the antares-cli specify the nested
    // form instead. The CLI's parser would reject this outright.
    const raw = `I'll search the repository for SQL-related keywords.
</think>
<tool_call>
{"name": "terminal", "command": "find . -type f | grep -E \\"\\\\.(sql|db)\\" | head -n 200", "max_chars": 20000}
</tool_call>`;
    const { calls, text, reasoning } = parseTurn(raw);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("terminal");
    expect(calls[0]!.args.command).toBe('find . -type f | grep -E "\\.(sql|db)" | head -n 200');
    expect(calls[0]!.args.max_chars).toBe(20000);
    // The reasoning is kept, but as its own channel — not as prose for the user
    // and not as the answer. The scan page shows it under its own event kind.
    expect(text).toBe("");
    expect(reasoning).toContain("SQL-related keywords");
    expect(reasoning).not.toContain("</think>");
  });

  test("CAPTURED: nested arguments still work, and take precedence", () => {
    const raw = `<tool_call>
{"name": "terminal", "arguments": {"command": "ls -la /mnt/host", "max_chars": 2000}}
</tool_call>`;
    const { calls } = parseTurn(raw);
    expect(calls).toEqual([
      { name: "terminal", args: { command: "ls -la /mnt/host", max_chars: 2000 } },
    ]);
  });

  test("a no-argument submit call is a call, not a parse failure", () => {
    const { calls } = parseTurn('<tool_call>\n{"name": "submit_no_vulnerability_found"}\n</tool_call>');
    expect(calls).toEqual([{ name: "submit_no_vulnerability_found", args: {} }]);
  });

  test("submit_vulnerable_files carries its array through the flattened path", () => {
    const raw = `<tool_call>
{"name": "submit_vulnerable_files", "ranked_files": ["src/db.py", "src/api/users.py"]}
</tool_call>`;
    const { calls } = parseTurn(raw);
    expect(calls[0]!.args.ranked_files).toEqual(["src/db.py", "src/api/users.py"]);
  });

  test("`tool` is accepted as an alias for `name`", () => {
    const { calls } = parseTurn('<tool_call>{"tool": "terminal", "command": "pwd"}</tool_call>');
    expect(calls).toEqual([{ name: "terminal", args: { command: "pwd" } }]);
  });

  test("surplus closing braces are peeled", () => {
    // Copied from the CLI's _lenient_json_loads, which exists for this reason.
    const { calls } = parseTurn('<tool_call>{"name": "terminal", "command": "ls"}}</tool_call>');
    expect(calls).toEqual([{ name: "terminal", args: { command: "ls" } }]);
  });

  test("trailing junk after a complete object is ignored", () => {
    const { calls } = parseTurn('<tool_call>{"name": "terminal", "command": "ls"} extra</tool_call>');
    expect(calls[0]!.args.command).toBe("ls");
  });

  test("braces inside strings do not end the object early", () => {
    const raw = '<tool_call>{"name": "terminal", "command": "grep -r \\"}{\\" ."}</tool_call>';
    const { calls } = parseTurn(raw);
    expect(calls[0]!.args.command).toBe('grep -r "}{" .');
  });

  test("CAPTURED: an empty <tool_call> is an error, not a phantom call", () => {
    // q4 produced exactly this before fp16 replaced it. It must not become
    // `{name: "", args: {}}` or a silent no-op.
    expect(() => parseTurn("<tool_call></tool_call>")).toThrow(ToolCallParseError);
  });

  test("an unterminated block is an error rather than a guess", () => {
    expect(() => parseTurn('<tool_call>\n{"name": "terminal", "command": "ls"')).toThrow(
      ToolCallParseError,
    );
  });

  test("CAPTURED: bare JSON in prose is NOT a call", () => {
    // q4 emitted a raw {"ranked_files": [...]} object with hallucinated paths
    // and no wrapper. Treating unwrapped JSON as a submission would let a model
    // quoting JSON at the user file a finding. Same refusal as the llama
    // dialect (PLAN §10.9).
    const raw = 'Here is what I found: {"ranked_files": ["src/app/index.js"]}';
    const { calls, text, reasoning } = parseTurn(raw);
    expect(calls).toHaveLength(0);
    // No `</think>` yet, so this checkpoint is still inside the block its own
    // prompt opened: the text is reasoning, and either way it is not a call.
    expect(`${text}${reasoning}`).toContain("ranked_files");
  });

  test("Pythonic syntax is refused rather than parsed", () => {
    // That is LFM2's grammar. A Granite model emitting it is malformed output,
    // and the shared parseCallBody would have accepted it.
    expect(() => parseTurn('<tool_call>terminal(command="ls")</tool_call>')).toThrow(
      ToolCallParseError,
    );
  });

  test("several calls in one turn are all returned", () => {
    const raw =
      '<tool_call>{"name": "terminal", "command": "ls"}</tool_call>\n' +
      '<tool_call>{"name": "terminal", "command": "pwd"}</tool_call>';
    const { calls } = parseTurn(raw);
    expect(calls.map((c) => c.args.command)).toEqual(["ls", "pwd"]);
  });

  test("a turn with no call splits into reasoning and the prose after it", () => {
    const { calls, text, reasoning } = parseTurn("I'll look at the repo.\n</think>\nStarting now.");
    expect(calls).toHaveLength(0);
    expect(reasoning).toBe("I'll look at the repo.");
    expect(text).toBe("Starting now.");
  });

  test("special tokens are stripped from both channels", () => {
    // Still inside the block the prompt opened, so this is reasoning.
    expect(parseTurn("done<|end_of_text|>").reasoning).toBe("done");
    expect(parseTurn("thinking</think>done<|end_of_text|>").text).toBe("done");
  });
});
