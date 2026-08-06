import { describe, expect, test } from "bun:test";

import { type AgentEvent, Conversation, DEFAULTS, type ToolRunner } from "./conversation.ts";
import { lfm2 } from "./dialects/lfm2.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import { ModelError } from "./model-client.ts";
import type { ParsedCall } from "./parse.ts";

const call = (cmd: string) => `<|tool_call_start|>[run_terminal_command(cmd="${cmd}")]<|tool_call_end|>`;

function build(scripts: FakeScript[], patch: Partial<Parameters<Conversation["configure"]>[0]> = {}) {
  const events: AgentEvent[] = [];
  const ran: ParsedCall[] = [];
  const budgets: number[] = [];
  const runner: ToolRunner = {
    run: async (c, opts) => {
      ran.push(c);
      budgets.push(opts.maxOutput);
      // The budget lands on the request, as the registry does it for real.
      const max = typeof c.args.max_output === "number" && c.args.max_output > 0
        ? Math.min(c.args.max_output, opts.maxOutput)
        : opts.maxOutput;
      return {
        text: `exit_code: 0\n\n<stdout>\nran ${String(c.args.cmd)}\n</stdout>\n`,
        exitCode: 0,
        request: { cmd: String(c.args.cmd ?? ""), max_output: max },
      };
    },
  };
  const convo = new Conversation(
    { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS, ...patch },
    new FakeModelClient(scripts),
    runner,
    (e) => events.push(e),
  );
  return { convo, events, ran, budgets };
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

  test("the budget is handed to the runner on every call", async () => {
    const { convo, budgets, events } = build(
      [{ name: "x", turns: [{ text: call("cat big") }, { text: "ok" }] }],
      { perCallMaxOutput: 1234 },
    );
    await convo.send("go");
    expect(budgets).toEqual([1234]);
    expect(events.find((e) => e.kind === "tool-end")).toMatchObject({ request: { max_output: 1234 } });
  });

  // The budget must not be written into the model's arguments: a template tool
  // declares its own parameters and rejects anything else, so an injected
  // max_output would make every template call fail as an unknown argument.
  test("the budget never appears in the call's arguments", async () => {
    const { convo, ran } = build([{ name: "x", turns: [{ text: call("ls") }, { text: "ok" }] }], {
      perCallMaxOutput: 4096,
    });
    await convo.send("go");
    expect("max_output" in ran[0]!.args).toBe(false);
  });

  test("a smaller max_output the model chose itself is preserved", async () => {
    const { convo, ran, events } = build([
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
    expect(events.find((e) => e.kind === "tool-end")).toMatchObject({ request: { max_output: 64 } });
  });

  test("an oversized max_output is pulled back to the cap", async () => {
    const { convo, events } = build(
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
    expect(events.find((e) => e.kind === "tool-end")).toMatchObject({ request: { max_output: 4096 } });
  });

  test("a runner error is reported to the model rather than thrown", async () => {
    const events: AgentEvent[] = [];
    const convo = new Conversation(
      { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS },
      new FakeModelClient([
        { name: "bad", turns: [{ text: call("x") }, { text: "sorry" }] },
      ]),
      { run: async () => { throw new Error('no tool named "x" is available'); } },
      (e) => events.push(e),
    );
    await convo.send("go");
    expect(events.some((e) => e.kind === "error" && /no tool named/.test(e.message))).toBe(true);
    expect(events.some((e) => e.kind === "assistant")).toBe(true);
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
        promptBudgetChars: 6000,
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

  // The LFM2.5 failure: a prompt past the checkpoint's prefill ceiling killed
  // the WebGPU device, the rejection propagated straight out of send(), and the
  // page was left with a user message, no reply, and nothing on screen saying
  // why. Every later message rebuilt the same prompt and died the same way.
  test("a model failure ends the turn as a visible event, not a rejection", async () => {
    const events: AgentEvent[] = [];
    const convo = new Conversation(
      { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS },
      {
        load: async () => ({ source: "fake", loadMs: 0 }),
        generate: async () => {
          throw new Error("failed to call OrtRun()");
        },
        cancel: () => {},
      },
      { run: async () => ({ text: "", exitCode: 0 }) },
      (e) => events.push(e),
    );

    await convo.send("go");
    expect(events.some((e) => e.kind === "error" && /OrtRun/.test(e.message))).toBe(true);
    // And no phantom assistant turn was invented to stand in for the reply.
    expect(convo.messages().some((m) => m.role === "assistant")).toBe(false);
  });

  test("a prompt-too-long refusal elides to the reported ceiling and retries", async () => {
    const events: AgentEvent[] = [];
    const seen: number[] = [];
    let turn = 0;
    const convo = new Conversation(
      // A budget the loop believes is roomy, which is the situation the char
      // estimate gets wrong and the worker's real tokenizer catches.
      { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS, promptBudgetChars: 1_000_000 },
      {
        load: async () => ({ source: "fake", loadMs: 0 }),
        generate: async (req) => {
          seen.push(req.messages.reduce((n, m) => n + m.content.length, 0));
          turn++;
          // First a tool call, to put a large result in history. Then the
          // refusal, and only then an answer.
          if (turn === 1) {
            return { text: call("ls"), tokens: 1, ms: 0, stopped: false };
          }
          if (turn === 2) {
            // 500 tokens ≈ 2000 chars, which is the budget the loop must adopt.
            throw new ModelError("prompt is 9001 tokens", "prompt-too-long", 500);
          }
          return { text: "ok", tokens: 1, ms: 0, stopped: false };
        },
        cancel: () => {},
      },
      { run: async () => ({ text: `exit_code: 0\n${"x".repeat(8000)}`, exitCode: 0 }) },
      (e) => events.push(e),
    );

    await convo.send("go");

    expect(seen).toHaveLength(3);
    // The retry is a smaller prompt than the one that was refused.
    expect(seen[2]!).toBeLessThan(seen[1]!);
    // 500 tokens of room, less the two characters the empty tool list costs.
    expect(convo.options().promptBudgetChars).toBe(1998);
    expect(events.some((e) => e.kind === "assistant" && e.text === "ok")).toBe(true);
  });

  test("a second prompt-too-long is reported rather than retried forever", async () => {
    const events: AgentEvent[] = [];
    let calls = 0;
    const convo = new Conversation(
      { systemPrompt: "sys", tools: [], dialect: lfm2, ...DEFAULTS },
      {
        load: async () => ({ source: "fake", loadMs: 0 }),
        generate: async () => {
          calls++;
          throw new ModelError("still too long", "prompt-too-long", 10);
        },
        cancel: () => {},
      },
      { run: async () => ({ text: "", exitCode: 0 }) },
      (e) => events.push(e),
    );

    await convo.send("go");
    expect(calls).toBe(2);
    expect(events.some((e) => e.kind === "error" && /still too long/.test(e.message))).toBe(true);
  });

  // The tool schema is prompt text the messages never contain: the chat template
  // serialises it into the system turn on every single turn. Leaving it out of
  // the budget meant a user with several template tools enabled was ~10 KB over
  // a ceiling the loop believed it was under.
  test("the serialised tool schema counts against the prompt budget", async () => {
    const script: FakeScript[] = [
      { name: "x", turns: [{ text: call("a".repeat(700)) }, { text: call("b".repeat(700)) }, { text: "done" }] },
    ];
    const opts = { promptBudgetChars: 4500, maxIterations: 4 };

    // ~3 KB of conversation fits the budget on its own…
    const { convo: roomy, events: quiet } = build(script, { ...opts, tools: [] });
    await roomy.send("go");
    expect(kinds(quiet)).not.toContain("elided");

    // …and does not once the tool schema on every prompt is counted too.
    const { convo, events } = build(script, {
      ...opts,
      tools: [{ name: "t", description: "d".repeat(4000) }],
    });
    await convo.send("go");
    expect(kinds(events)).toContain("elided");
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
