// The Antares protocol, driven end to end by a scripted model.
//
// Every failure mode scripted here was observed in a real transcript during M12
// (PLAN §11.10) — flattened arguments, an empty <tool_call>, unwrapped JSON with
// hallucinated paths, a model that reasons forever without calling anything.
// A loop that has only seen well-formed turns will not survive a real one.

import { describe, expect, test } from "bun:test";
import { antares } from "./dialects/index.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import { antaresHostTools, extractRankedFiles, normalizeSubmittedPath } from "./host-tools.ts";
import { LOCALIZE_DEFAULTS, LocalizeRun, type LocalizeEvent } from "./localize.ts";
import type { ParsedCall } from "./parse.ts";
import { ANTARES_TERMINAL, applyProfile, profiledDefinition } from "./tool-profile.ts";
import { buildSystemPrompt, buildTaskMessage } from "./antares-prompt.ts";

/** A ToolRunner that records what reached it and returns canned output. */
function runner(output: (call: ParsedCall) => string = () => "ok") {
  const seen: ParsedCall[] = [];
  return {
    seen,
    run: async (call: ParsedCall, opts: { maxOutput: number }) => {
      seen.push(call);
      return { text: output(call), exitCode: 0, request: { cmd: String(call.args.cmd ?? ""), max_output: opts.maxOutput } };
    },
  };
}

function makeRun(
  turns: string[],
  opts: {
    files?: string[];
    tools?: ReturnType<typeof runner>;
    terminalBudget?: number;
    maxIterations?: number;
    historyBudgetChars?: number;
  } = {},
) {
  const script: FakeScript = { name: "localize", turns: turns.map((text) => ({ text })) };
  const model = new FakeModelClient([script]);
  const tools = opts.tools ?? runner();
  const events: LocalizeEvent[] = [];
  const files = new Set(opts.files ?? []);
  const run = new LocalizeRun(
    {
      systemPrompt: buildSystemPrompt({ terminalBudget: opts.terminalBudget }),
      taskMessage: buildTaskMessage(["CWE-89"]),
      tools: [profiledDefinition(ANTARES_TERMINAL)],
      dialect: antares,
      profile: ANTARES_TERMINAL,
      hostTools: antaresHostTools,
      terminalBudget: opts.terminalBudget,
      maxIterations: opts.maxIterations ?? 10,
      perCallMaxOutput: LOCALIZE_DEFAULTS.perCallMaxOutput,
      maxNewTokens: 256,
      historyBudgetChars: opts.historyBudgetChars ?? LOCALIZE_DEFAULTS.historyBudgetChars,
      checkPath: async (p) => files.has(p),
    },
    model,
    tools,
    (ev) => events.push(ev),
  );
  return { run, events, tools };
}

const call = (cmd: string) => `<tool_call>\n{"name": "terminal", "command": ${JSON.stringify(cmd)}}\n</tool_call>`;
const submit = (files: string[]) =>
  `<tool_call>\n{"name": "submit_vulnerable_files", "ranked_files": ${JSON.stringify(files)}}\n</tool_call>`;

// Profile schema fidelity and argument mapping live in tool-profile.test.ts,
// which checks the emitted JSON against the technical report's Appendix A.1
// verbatim. What is tested here is the profile inside a running loop.

describe("host tools", () => {
  test("no host tool can produce an exec request", () => {
    // The amended §10.5 invariant, asserted structurally: a HostTool exposes
    // only `resolve`, which takes arguments and a path checker and returns a
    // submission. There is no session to reach and no request to build.
    for (const tool of antaresHostTools) {
      expect(Object.keys(tool)).not.toContain("session");
      expect(typeof tool.resolve).toBe("function");
      expect(tool.terminal).toBe(true);
    }
  });

  test("rejects paths that escape, are absolute, or are globs", () => {
    expect(normalizeSubmittedPath("../../etc/passwd")).toBeUndefined();
    expect(normalizeSubmittedPath("/etc/passwd")).toBeUndefined();
    expect(normalizeSubmittedPath("src/**/*.py")).toBeUndefined();
    expect(normalizeSubmittedPath("  ./src/db.py ")).toBe("src/db.py");
    expect(normalizeSubmittedPath("src\\db.py")).toBe("src/db.py");
  });

  test("accepts the argument aliases and object entries real models emit", () => {
    expect(extractRankedFiles({ files: ["a.py"] }).paths).toEqual(["a.py"]);
    expect(extractRankedFiles({ ranked_files: [{ path: "b.py" }] }).paths).toEqual(["b.py"]);
    expect(extractRankedFiles({ ranked_files: ["c.py", "c.py"] }).paths).toEqual(["c.py"]);
  });
});

describe("localize run", () => {
  test("a normal run: explore, then submit verified files", async () => {
    const { run, events } = makeRun([call("ls /mnt/host"), submit(["src/db.py"])], {
      files: ["src/db.py"],
    });
    const result = await run.run();
    expect(result.submitted).toBe(true);
    // No command in this run mentioned the path, so there is no evidence to
    // attribute — and saying so is better than inventing a rationale.
    expect(result.findings).toEqual([
      { path: "src/db.py", rank: 1, exists: true, evidence: [] },
    ]);
    expect(result.terminalCallsUsed).toBe(1);
    expect(events.some((e) => e.kind === "submitted")).toBe(true);
  });

  test("a finding carries the commands whose output named it", async () => {
    // PLAN §11.5: a bare ranked path from a 0.135-F1 model is not actionable.
    // The evidence is a reconstruction — the model never states its reasoning —
    // so it has to be checkable against the trace, which means real commands.
    const tools = runner((c) =>
      String(c.args.cmd).includes("grep") ? "src/db.py:14:  query = 'SELECT ' + name" : "hello.txt",
    );
    const { run } = makeRun([call("ls /mnt/host"), call("grep -rn SELECT /mnt/host"), submit(["src/db.py"])], {
      files: ["src/db.py"],
      tools,
    });
    const result = await run.run();

    expect(result.findings[0]!.evidence).toEqual([
      {
        command: "grep -rn SELECT /mnt/host",
        exitCode: 0,
        line: "src/db.py:14:  query = 'SELECT ' + name",
      },
    ]);
    // The `ls` call did not name the file, so it is not offered as evidence.
    expect(result.findings[0]!.evidence).toHaveLength(1);
  });

  test("the run reports how long it took", async () => {
    const { run } = makeRun([submit([])]);
    const result = await run.run();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("the profile is applied before the call reaches the runner", async () => {
    const tools = runner();
    const { run } = makeRun([call("rg -n 'SELECT' /mnt/host"), submit([])], { tools });
    await run.run();
    expect(tools.seen[0]!.name).toBe("run_terminal_command");
    expect(tools.seen[0]!.args.cmd).toBe("rg -n 'SELECT' /mnt/host");
  });

  test("CAPTURED: a hallucinated path is rejected, not reported as a finding", async () => {
    // The single most important behaviour in the file. At 0.135 File F1 this is
    // routine output, and an unverifiable path reads exactly like a real one.
    const { run } = makeRun([submit(["src/real.py", "src/invented.py"])], { files: ["src/real.py"] });
    const result = await run.run();
    expect(result.findings.map((f) => f.path)).toEqual(["src/real.py"]);
    expect(result.rejected).toEqual(["src/invented.py"]);
  });

  test("CAPTURED: flattened arguments survive the whole pipeline", async () => {
    const tools = runner();
    const raw = '<tool_call>\n{"name": "terminal", "command": "find . -type f", "max_chars": 20000}\n</tool_call>';
    const { run } = makeRun([raw, submit([])], { tools });
    await run.run();
    expect(tools.seen[0]!.args).toEqual({ cmd: "find . -type f", max_output: 20000 });
  });

  test("the terminal budget is enforced and the model is told", async () => {
    const turns = [call("ls"), call("pwd"), call("whoami"), submit([])];
    const { run, events, tools } = makeRun(turns, { terminalBudget: 2 });
    const result = await run.run();
    expect(result.terminalCallsUsed).toBe(2);
    expect(tools.seen).toHaveLength(2);
    const nudge = events.find((e) => e.kind === "nudge" && e.reason === "budget");
    expect(nudge).toBeDefined();
    expect((nudge as { text: string }).text).toContain("budget exhausted (2/2)");
  });

  test("each observation carries the remaining-call footer the model was trained on", async () => {
    const { run, events } = makeRun([call("ls"), submit([])], { terminalBudget: 15 });
    await run.run();
    const end = events.find((e) => e.kind === "tool-end") as { rendered: string };
    expect(end.rendered).toContain("[14 tool-calls remaining]");
  });

  test("a repeated identical call is refused rather than re-run", async () => {
    const tools = runner();
    const { run, events } = makeRun([call("ls"), call("ls"), submit([])], { tools });
    await run.run();
    expect(tools.seen).toHaveLength(1);
    expect(events.some((e) => e.kind === "nudge" && e.reason === "duplicate")).toBe(true);
  });

  test("CAPTURED: a model that never calls a tool gets nudged, then stops", async () => {
    const prose = "I will inspect the repository for SQL injection.";
    const { run, events } = makeRun(Array(8).fill(prose));
    const result = await run.run();
    expect(result.submitted).toBe(false);
    expect(events.filter((e) => e.kind === "nudge" && e.reason === "no-tool").length).toBeGreaterThan(0);
    expect(result.stoppedBecause).toContain("without submitting");
  });

  test("CAPTURED: unwrapped JSON is not a submission", async () => {
    // q4 emitted exactly this. If bare JSON counted, a model quoting JSON at
    // the user would file findings.
    const { run } = makeRun(['Here is my answer: {"ranked_files": ["src/db.py"]}'], { files: ["src/db.py"] });
    const result = await run.run();
    expect(result.submitted).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  test("CAPTURED: an empty <tool_call> is reported, not executed", async () => {
    const { run, events, tools } = makeRun(["<tool_call></tool_call>", submit([])]);
    await run.run();
    expect(tools.seen).toHaveLength(0);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  test("submit_no_vulnerability_found is a real answer", async () => {
    const { run } = makeRun([`<tool_call>\n{"name": "submit_no_vulnerability_found"}\n</tool_call>`]);
    const result = await run.run();
    expect(result.submitted).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.stoppedBecause).toBe("submitted");
  });

  test("elision never drops the task message", async () => {
    // The whole run is conditioned on it. Conversation drops from the front of
    // history once tool outputs are spent; this loop must not (PLAN §11.4).
    const big = runner(() => "x".repeat(4000));
    const turns = [call("a"), call("b"), call("c"), call("d"), submit([])];
    const { run, events } = makeRun(turns, { tools: big, historyBudgetChars: 3000 });
    await run.run();
    expect(events.some((e) => e.kind === "elided")).toBe(true);
    const messages = run.messages();
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("CWE-89");
  });

  test("the iteration cap ends a run that would otherwise never stop", async () => {
    const { run, events } = makeRun(Array(30).fill(call("ls")), { maxIterations: 3, terminalBudget: 50 });
    const result = await run.run();
    expect(result.submitted).toBe(false);
    expect(events.some((e) => e.kind === "stopped" && e.reason === "iteration-cap")).toBe(true);
  });
});
