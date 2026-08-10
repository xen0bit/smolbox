import { describe, expect, test } from "bun:test";

import type { Request, Response } from "../protocol.ts";
import { toolName } from "../tool.ts";
import { ToolRegistry, UnknownToolError, builtinTemplates, defaultState } from "./tool-registry.ts";
import type { TemplateTool } from "./user-tools.ts";

function fakeSession(): { exec(req: Request): Promise<Response>; calls: Request[] } {
  const calls: Request[] = [];
  return {
    calls,
    exec: async (req: Request) => {
      calls.push(req);
      return {
        seq: calls.length,
        exit_code: 0,
        stdout: "ok\n",
        stderr: "",
        timed_out: false,
        truncated: false,
        duration_ms: 1,
      };
    },
  };
}

const userTool: TemplateTool = {
  name: "find_todo",
  description: "find TODOs",
  params: [{ name: "path", type: "string", description: "where", default: "/mnt/host" }],
  template: "grep -rn TODO {path}",
};

describe("ToolRegistry exposure", () => {
  test("only the exec tool is exposed by default", () => {
    const reg = new ToolRegistry();
    expect(reg.definitions()).toHaveLength(1);
    expect(reg.definitions()[0]!.function.name).toBe(toolName);
  });

  // Regression for a real turn, not a style preference: LFM2.5 350M handed the
  // unstripped schema opened its tool call with `$schema="https://…"` as the
  // first argument and never emitted `cmd` (PLAN §10.20). The published
  // artifacts under docs/schema keep both keys — they are documents — so this
  // asserts the divergence rather than assuming the two stay identical.
  test("document metadata never reaches the model", () => {
    const reg = new ToolRegistry();
    for (const def of reg.definitions()) {
      const params = def.function.parameters as Record<string, unknown>;
      expect(params, `${def.function.name} leaks $schema`).not.toHaveProperty("$schema");
      expect(params, `${def.function.name} leaks title`).not.toHaveProperty("title");
    }
  });

  test("stripping metadata leaves the parameters themselves alone", () => {
    const reg = new ToolRegistry();
    const params = reg.definitions()[0]!.function.parameters as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["cmd"]);
    expect(Object.keys(params.properties ?? {})).toEqual([
      "cmd",
      "cwd",
      "env",
      "stdin",
      "timeout_ms",
      "max_output",
    ]);
  });

  // The exec definition is rebuilt per call, but template definitions need not
  // be — a strip that mutated its input would corrupt the second read.
  test("definitions are stable across calls", () => {
    const reg = new ToolRegistry();
    reg.setEnabled("list_dir", true);
    expect(reg.definitions()).toEqual(reg.definitions());
  });

  // The prompt-cost argument (PLAN §10.1): narrow tools must be a choice.
  test("built-ins exist but are off until enabled", () => {
    const reg = new ToolRegistry();
    const names = reg.list().map((t) => t.name);
    for (const b of builtinTemplates) {
      expect(names).toContain(b.name);
      expect(reg.list().find((t) => t.name === b.name)!.enabled).toBe(false);
    }
    expect(reg.definitions()).toHaveLength(1);
  });

  test("enabling a built-in adds it to what the model sees", () => {
    const reg = new ToolRegistry();
    reg.setEnabled("list_dir", true);
    expect(reg.definitions().map((d) => d.function.name)).toEqual([toolName, "list_dir"]);
  });

  test("the exec tool can be turned off entirely", () => {
    const reg = new ToolRegistry();
    reg.setEnabled(toolName, false);
    reg.setEnabled("list_dir", true);
    expect(reg.definitions().map((d) => d.function.name)).toEqual(["list_dir"]);
  });

  test("a user tool shadows a built-in of the same name", () => {
    const reg = new ToolRegistry();
    reg.addUserTool({ ...userTool, name: "list_dir", description: "mine" });
    expect(reg.list().find((t) => t.name === "list_dir")).toMatchObject({ source: "user", description: "mine" });
  });

  test("an invalid user tool is refused at the door", () => {
    const reg = new ToolRegistry();
    expect(() => reg.addUserTool({ ...userTool, name: toolName })).toThrow(/reserved/);
    expect(() => reg.addUserTool({ ...userTool, template: "ls {nope}" })).toThrow(/undeclared/);
  });

  test("the exec tool's prompt text can be overridden and restored", () => {
    const reg = new ToolRegistry();
    reg.setExecDescription("terser instructions");
    expect(reg.definitions()[0]!.function.description).toBe("terser instructions");
    reg.setExecDescription(undefined);
    expect(reg.definitions()[0]!.function.description).toContain("persistent sandbox");
  });
});

describe("ToolRegistry dispatch", () => {
  test("an exec call goes through the M7 path", async () => {
    const reg = new ToolRegistry();
    const session = fakeSession();
    const out = await reg.run(session, { name: toolName, args: { cmd: "echo hi" } });
    expect(session.calls[0]!.cmd).toBe("echo hi");
    expect(out.text).toContain("exit_code: 0");
  });

  test("a template call compiles and executes", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    const session = fakeSession();
    await reg.run(session, { name: "find_todo", args: { path: "/mnt/host/sub" } });
    expect(session.calls[0]!.cmd).toBe("grep -rn TODO '/mnt/host/sub'");
    expect(session.calls[0]!.op).toBe("exec");
  });

  test("a disabled tool is not callable even though it exists", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    reg.setEnabled("find_todo", false);
    await expect(reg.run(fakeSession(), { name: "find_todo", args: {} })).rejects.toThrow(UnknownToolError);
  });

  test("a hallucinated tool name is a correctable error naming what exists", async () => {
    const reg = new ToolRegistry();
    await expect(reg.run(fakeSession(), { name: "read_the_web", args: {} })).rejects.toThrow(
      /no tool named "read_the_web"/,
    );
    await expect(reg.run(fakeSession(), { name: "read_the_web", args: {} })).rejects.toThrow(
      new RegExp(`available: ${toolName}`),
    );
  });

  test("session defaults fill in what a call omits", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    reg.setDefaults({ timeout_ms: 5000, max_output: 2048 });
    const session = fakeSession();
    await reg.run(session, { name: "find_todo", args: {} });
    expect(session.calls[0]!.timeout_ms).toBe(5000);
    expect(session.calls[0]!.max_output).toBe(2048);
  });

  test("session defaults never override what the call set", async () => {
    const reg = new ToolRegistry();
    reg.setDefaults({ timeout_ms: 5000 });
    const session = fakeSession();
    await reg.run(session, { name: toolName, args: { cmd: "x", timeout_ms: 100 } });
    expect(session.calls[0]!.timeout_ms).toBe(100);
  });

  // The bug the e2e suite caught: the loop's budget must reach the request
  // without ever entering the argument object, or every template call fails as
  // "unknown argument max_output".
  test("the loop budget caps a template call without touching its arguments", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    const session = fakeSession();
    const out = await reg.run(session, { name: "find_todo", args: {} }, { maxOutput: 4096 });
    expect(session.calls[0]!.max_output).toBe(4096);
    expect(out.request.max_output).toBe(4096);
  });

  test("the loop budget caps an exec call the same way", async () => {
    const reg = new ToolRegistry();
    const session = fakeSession();
    await reg.run(session, { name: toolName, args: { cmd: "x" } }, { maxOutput: 4096 });
    expect(session.calls[0]!.max_output).toBe(4096);
  });

  test("a smaller max_output the model asked for survives the budget", async () => {
    const reg = new ToolRegistry();
    const session = fakeSession();
    await reg.run(session, { name: toolName, args: { cmd: "x", max_output: 64 } }, { maxOutput: 4096 });
    expect(session.calls[0]!.max_output).toBe(64);
  });

  // The invariant, restated at the dispatch layer.
  test("every dispatch path produces an exec request", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    const session = fakeSession();
    await reg.run(session, { name: toolName, args: { cmd: "a" } });
    await reg.run(session, { name: "find_todo", args: {} });
    expect(session.calls.every((c) => c.op === "exec")).toBe(true);
  });

  test("op cannot be smuggled through a template call", async () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    await expect(reg.run(fakeSession(), { name: "find_todo", args: { op: "shutdown" } })).rejects.toThrow(
      /unknown argument/,
    );
  });

  test("op cannot be smuggled through an exec call either", async () => {
    const reg = new ToolRegistry();
    await expect(reg.run(fakeSession(), { name: toolName, args: { cmd: "x", op: "shutdown" } })).rejects.toThrow(
      /may not set op/,
    );
  });
});

describe("ToolRegistry persistence", () => {
  test("a snapshot round-trips through load", () => {
    const reg = new ToolRegistry();
    reg.addUserTool(userTool);
    reg.setEnabled("list_dir", true);
    reg.setDefaults({ max_output: 999 });
    const snap = reg.snapshot();

    const restored = new ToolRegistry(defaultState());
    restored.load(snap);
    expect(restored.definitions().map((d) => d.function.name).sort()).toEqual(
      reg.definitions().map((d) => d.function.name).sort(),
    );
    expect(restored.defaults().max_output).toBe(999);
  });

  test("loading a state with an invalid user tool is refused", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.load({ ...defaultState(), userTools: [{ ...userTool, template: "ls {ghost}" }] }),
    ).toThrow(/undeclared/);
  });

  test("a snapshot is a copy, not a live handle", () => {
    const reg = new ToolRegistry();
    const snap = reg.snapshot();
    snap.execEnabled = false;
    expect(reg.definitions()).toHaveLength(1);
  });
});
