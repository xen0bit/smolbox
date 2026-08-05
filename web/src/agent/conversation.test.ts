import { describe, expect, test } from "bun:test";

import { type AgentEvent, Conversation, DEFAULTS, type ToolRunner } from "./conversation.ts";
import { lfm2 } from "./dialects/lfm2.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import type { ParsedCall } from "./parse.ts";

const call = (cmd: string) => `<|tool_call_start|>[run_terminal_command(cmd="${cmd}")]<|tool_call_end|>`;

function build(scripts: FakeScript[], patch: Partial<Parameters<Conversation["configure"]>[0]> = {}) {
  const events: AgentEvent[] = [];
  const ran: ParsedCall[] = [];
  const runner: ToolRunner = {
    run: async (c) => {
      ran.push(c);
      return { text: `exit_code: 0\n\n<stdout>\nran ${String(c.args.cmd)}\n</stdout>\n`, exitCode: 0 };
    },
  };
  const convo = new Conversation(
    { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS, ...patch },
    new FakeModelClient(scripts),
    runner,
    (e) => events.push(e),
  );
  return { convo, events, ran };
}

const kinds = (events: AgentEvent[]) => events.map((e) => e.kind);

describe("Conversation", () => {
  test("a plain answer ends the turn without touching a tool", async () => {
    const { convo, events, ran } = build([{ name: "plain", turns: [{ text: "Hello there." }] }]);
    await convo.send("hi");
    expect(ran).toHaveLength(0);
    expect(kinds(events)).toContain("assistant");
    expect(events.find((e) => e.kind === "assistant")).toMatchObject({ text: "Hello there." });
  });

  test("a tool call is executed and its result fed back", async () => {
    const { convo, events, ran } = build([
      { name: "one", turns: [{ text: call("ls") }, { text: "There is one file." }] },
    ]);
    await convo.send("what files");

    expect(ran).toHaveLength(1);
    expect(ran[0]!.args.cmd).toBe("ls");
    // Tokens stream from both generations, so they land on either side of the
    // tool events; assert the order of the events that carry meaning.
    expect(kinds(events).filter((k) => k !== "token")).toEqual([
      "user",
      "tool-start",
      "tool-end",
      "assistant",
    ]);
    // The tool result must be in history as a `tool` message, which is what the
    // chat template wraps in <|tool_response_start|>.
    const hist = convo.messages();
    expect(hist.at(-2)?.role).toBe("tool");
    expect(hist.at(-2)?.content).toContain("ran ls");
  });

  test("several iterations chain until the model stops calling", async () => {
    const { convo, ran } = build([
      { name: "chain", turns: [{ text: call("a") }, { text: call("b") }, { text: "done" }] },
    ]);
    await convo.send("go");
    expect(ran.map((c) => c.args.cmd)).toEqual(["a", "b"]);
  });

  test("the iteration cap stops a model that never stops calling", async () => {
    const { convo, events, ran } = build(
      [{ name: "loop", turns: Array(20).fill({ text: call("again") }) }],
      { maxIterations: 3 },
    );
    await convo.send("go");
    expect(ran).toHaveLength(3);
    expect(events.at(-1)).toEqual({ kind: "stopped", reason: "iteration-cap" });
  });

  test("max_output is capped on every call", async () => {
    const { convo, ran } = build([{ name: "x", turns: [{ text: call("cat big") }, { text: "ok" }] }], {
      perCallMaxOutput: 1234,
    });
    await convo.send("go");
    expect(ran[0]!.args.max_output).toBe(1234);
  });

  test("a smaller max_output the model chose itself is respected", async () => {
    const { convo, ran } = build([
      {
        name: "x",
        turns: [
          { text: '<|tool_call_start|>[run_terminal_command(cmd="ls", max_output=64)]<|tool_call_end|>' },
          { text: "ok" },
        ],
      },
    ]);
    await convo.send("go");
    expect(ran[0]!.args.max_output).toBe(64);
  });

  test("an oversized max_output is pulled back to the cap", async () => {
    const { convo, ran } = build(
      [
        {
          name: "x",
          turns: [
            { text: '<|tool_call_start|>[run_terminal_command(cmd="ls", max_output=1048576)]<|tool_call_end|>' },
            { text: "ok" },
          ],
        },
      ],
      { perCallMaxOutput: 4096 },
    );
    await convo.send("go");
    expect(ran[0]!.args.max_output).toBe(4096);
  });

  test("a malformed tool call is reported back to the model rather than thrown", async () => {
    const { convo, events } = build([
      {
        name: "bad",
        turns: [{ text: "<|tool_call_start|>[run_terminal_command(cmd=)]<|tool_call_end|>" }, { text: "sorry" }],
      },
    ]);
    await convo.send("go");

    expect(kinds(events)).toContain("error");
    // The error is in history as a tool message, so the model gets a chance to
    // correct itself on the next iteration.
    expect(convo.messages().some((m) => m.role === "tool" && m.content.startsWith("error:"))).toBe(true);
    expect(kinds(events)).toContain("assistant");
  });

  test("history elision blanks oldest tool output but keeps its first line", async () => {
    const big = "x".repeat(5000);
    const runner: ToolRunner = { run: async () => ({ text: `exit_code: 0\n${big}`, exitCode: 0 }) };
    const events: AgentEvent[] = [];
    const convo = new Conversation(
      {
        systemPrompt: "sys",
        tools: [],
        dialect: lfm2,
        ...DEFAULTS,
        historyBudgetChars: 6000,
        maxIterations: 6,
      },
      new FakeModelClient([
        { name: "big", turns: [{ text: call("a") }, { text: call("b") }, { text: call("c") }, { text: "done" }] },
      ]),
      runner,
      (e) => events.push(e),
    );

    await convo.send("go");

    expect(kinds(events)).toContain("elided");
    const tools = convo.messages().filter((m) => m.role === "tool");
    expect(tools.some((m) => m.content.startsWith("[older output elided]"))).toBe(true);
    // The exit code survives elision: that it ran and worked outlives the bytes.
    expect(tools.some((m) => m.content.includes("exit_code: 0"))).toBe(true);
  });

  test("cancel stops the turn and says so", async () => {
    const { convo, events, ran } = build([
      { name: "slow", turns: [{ text: call("sleep"), delayMs: 400 }] },
    ]);
    const done = convo.send("go");
    await new Promise((r) => setTimeout(r, 50));
    convo.cancel();
    await done;

    expect(ran).toHaveLength(0);
    expect(events.at(-1)).toEqual({ kind: "stopped", reason: "cancelled" });
  });

  test("two turns in flight at once is a programming error", async () => {
    const { convo } = build([{ name: "slow", turns: [{ text: "hi", delayMs: 200 }] }]);
    const first = convo.send("a");
    await expect(convo.send("b")).rejects.toThrow(/already in flight/);
    await first;
  });

  test("the system prompt always leads the history", async () => {
    const { convo } = build([{ name: "x", turns: [{ text: "hi" }] }]);
    await convo.send("go");
    expect(convo.messages()[0]).toEqual({ role: "system", content: "sys" });
  });

  test("reset clears history but keeps the system prompt", async () => {
    const { convo } = build([{ name: "x", turns: [{ text: "hi" }] }]);
    await convo.send("go");
    convo.reset();
    expect(convo.messages()).toHaveLength(1);
  });
});
