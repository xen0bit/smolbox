import { describe, expect, test } from "bun:test";

import { ToolCallParseError } from "../parse.ts";
import { QUOTE, TOOL_CALL_END, TOOL_CALL_START, parseTurn, preview } from "./gemma4.ts";

const q = (s: string) => `${QUOTE}${s}${QUOTE}`;
const wrap = (body: string) => `${TOOL_CALL_START}${body}${TOOL_CALL_END}`;

// The expectations below come from rendering google/gemma-4-E2B-it-qat-mobile-
// transformers' own chat_template.jinja, not from documentation — its
// format_argument macro is the specification for the value grammar.
describe("gemma4 call grammar", () => {
  test("the shape the template renders", () => {
    const turn = parseTurn(wrap(`call:run_terminal_command{cmd:${q("ls /mnt/host")}}`));
    expect(turn.calls).toEqual([
      { name: "run_terminal_command", args: { cmd: "ls /mnt/host" } },
    ]);
    expect(turn.text).toBe("");
  });

  test("several arguments, mixed types", () => {
    const turn = parseTurn(
      wrap(`call:run_terminal_command{cmd:${q("ls")},timeout_ms:5000,max_output:1024}`),
    );
    expect(turn.calls[0]!.args).toEqual({ cmd: "ls", timeout_ms: 5000, max_output: 1024 });
  });

  test("booleans and nested objects with quoted keys", () => {
    const turn = parseTurn(
      wrap(`call:t{flag:true,off:false,env:{${q("PATH")}:${q("/bin")}}}`),
    );
    expect(turn.calls[0]!.args).toEqual({ flag: true, off: false, env: { PATH: "/bin" } });
  });

  // RENDERED: these are what the checkpoint's own chat_template.jinja emits for
  // the given arguments, taken verbatim from a round trip through it. They are
  // not a captured model turn — that is still owed, and is why this dialect is
  // unverified — but they do pin the grammar to the template rather than to a
  // reading of it. Note nested keys come out BARE: the tool-call path passes
  // escape_keys=False all the way down, unlike a tool declaration.
  test("RENDERED: the template's own output for every value type", () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        `<|tool_call>call:run_terminal_command{cmd:<|"|>ls /mnt/host<|"|>}<tool_call|>`,
        { cmd: "ls /mnt/host" },
      ],
      [
        `<|tool_call>call:run_terminal_command{cmd:<|"|>ls<|"|>,max_output:1024,timeout_ms:5000}<tool_call|>`,
        { cmd: "ls", max_output: 1024, timeout_ms: 5000 },
      ],
      [
        `<|tool_call>call:run_terminal_command{cmd:<|"|>ls<|"|>,env:{HOME:<|"|>/root<|"|>,PATH:<|"|>/bin<|"|>}}<tool_call|>`,
        { cmd: "ls", env: { HOME: "/root", PATH: "/bin" } },
      ],
      [
        `<|tool_call>call:run_terminal_command{argv:[<|"|>a<|"|>,<|"|>b<|"|>,3],cmd:<|"|>ls<|"|>}<tool_call|>`,
        { argv: ["a", "b", 3], cmd: "ls" },
      ],
      [
        `<|tool_call>call:run_terminal_command{cmd:<|"|>ls<|"|>,quiet:false,verbose:true}<tool_call|>`,
        { cmd: "ls", quiet: false, verbose: true },
      ],
      [
        `<|tool_call>call:run_terminal_command{cmd:<|"|>awk -F, '{print $1, $2}' a.csv\ngrep -c "x" b.txt<|"|>}<tool_call|>`,
        { cmd: `awk -F, '{print $1, $2}' a.csv\ngrep -c "x" b.txt` },
      ],
    ];
    for (const [wire, args] of cases) {
      expect(parseTurn(wire).calls, wire).toEqual([{ name: "run_terminal_command", args }]);
    }
  });

  test("arrays", () => {
    const turn = parseTurn(wrap(`call:t{args:[${q("a")},${q("b")},3]}`));
    expect(turn.calls[0]!.args.args).toEqual(["a", "b", 3]);
  });

  // Same call the Pythonic reader makes about `None`: an argument the model
  // declined to supply must be absent, not null, or decodeArgs rejects it.
  test("a null argument is dropped rather than passed through", () => {
    const turn = parseTurn(wrap(`call:t{cmd:${q("ls")},cwd:null}`));
    expect(turn.calls[0]!.args).toEqual({ cmd: "ls" });
    expect("cwd" in turn.calls[0]!.args).toBe(false);
  });

  // The delimiters are not escaped, so the string runs to the next delimiter and
  // everything inside is content. A brace-balancing parser would stop early here.
  test("braces, commas and newlines inside a string are content", () => {
    const cmd = 'awk -F, \'{print $1, $2}\' a.csv\ngrep -c "x" b.txt';
    const turn = parseTurn(wrap(`call:run_terminal_command{cmd:${q(cmd)}}`));
    expect(turn.calls[0]!.args.cmd).toBe(cmd);
  });

  test("two calls in one turn, each in its own block", () => {
    const turn = parseTurn(
      `${wrap(`call:t{cmd:${q("a")}}`)}${wrap(`call:t{cmd:${q("b")}}`)}`,
    );
    expect(turn.calls.map((c) => c.args.cmd)).toEqual(["a", "b"]);
  });

  test("prose around a call is kept and the markers removed", () => {
    const turn = parseTurn(`Let me look. ${wrap(`call:t{cmd:${q("ls")}}`)} Done.`);
    expect(turn.text).toBe("Let me look.  Done.");
    expect(turn.calls).toHaveLength(1);
  });

  test("turn scaffolding is stripped from the prose", () => {
    expect(parseTurn("<|turn>model\nhello<turn|>").text).toBe("model\nhello");
  });
});

describe("gemma4 refuses what it cannot read", () => {
  test("an unterminated block is an error, not a guess", () => {
    expect(() => parseTurn(`${TOOL_CALL_START}call:t{cmd:${q("ls")}}`)).toThrow(ToolCallParseError);
  });

  test("an unterminated string is an error", () => {
    expect(() => parseTurn(wrap(`call:t{cmd:${QUOTE}ls}`))).toThrow(ToolCallParseError);
  });

  test("a body that does not start with call: is refused", () => {
    expect(() => parseTurn(wrap('{"name": "t", "arguments": {}}'))).toThrow(ToolCallParseError);
  });

  // That is Hermes' grammar. A Gemma model emitting it is malformed output, and
  // saying so beats parsing a format this checkpoint does not use.
  test("JSON is not silently accepted", () => {
    expect(() => parseTurn(wrap('call:t{"cmd": "ls"}'))).toThrow(ToolCallParseError);
  });

  test("trailing text after the call is refused", () => {
    expect(() => parseTurn(wrap(`call:t{cmd:${q("ls")}} and more`))).toThrow(ToolCallParseError);
  });
});

describe("gemma4 reasoning channel", () => {
  test("a thought channel is reasoning, not the answer", () => {
    const turn = parseTurn("<|channel>thought\nI should list it.<channel|>There are three files.");
    expect(turn.reasoning).toBe("I should list it.");
    expect(turn.text).toBe("There are three files.");
  });

  test("the channel name is routing, not reasoning", () => {
    expect(parseTurn("<|channel>thought\nhmm<channel|>ok").reasoning).toBe("hmm");
  });

  test("an unclosed channel is reasoning to the end", () => {
    const turn = parseTurn("<|channel>thought\nstill going");
    expect(turn.reasoning).toBe("still going");
    expect(turn.text).toBe("");
  });

  test("a turn with no channel is all answer", () => {
    expect(parseTurn("There are three files.").text).toBe("There are three files.");
    expect(parseTurn("There are three files.").reasoning).toBe("");
  });
});

describe("gemma4 preview", () => {
  test("a half-written call is withheld and reported as pending", () => {
    const p = preview(`Let me look. ${TOOL_CALL_START}call:run_terminal_command{cmd:${QUOTE}ls`);
    expect(p.pendingCall).toBe(true);
    expect(p.text).toBe("Let me look.");
    expect(p.text).not.toContain("tool_call");
  });

  test("reasoning streams as reasoning", () => {
    const p = preview("<|channel>thought\nworking on it");
    expect(p.reasoning).toBe("working on it");
    expect(p.text).toBe("");
  });
});
