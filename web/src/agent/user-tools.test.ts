import { describe, expect, test } from "bun:test";

import builtins from "../../../docs/schema/builtin-tools.json" with { type: "json" };
import table from "../../../tests/tool/template-cases.json" with { type: "json" };
import { OpExec } from "../protocol.ts";
import { toolName as execToolName } from "../tool.ts";
import {
  type TemplateTool,
  TemplateToolError,
  compileTemplateTool,
  templateToolDefinition,
  validateTemplateTool,
} from "./user-tools.ts";

// The same table the Go tests run (internal/tool/template_test.go). It is what
// stops the two template compilers from drifting.
describe("template compilation (shared golden table)", () => {
  for (const c of table.cases) {
    test(c.name, () => {
      const req = compileTemplateTool(c.tool as TemplateTool, c.args);
      expect(req.cmd).toBe(c.cmd);
      expect(req.op).toBe(OpExec);
    });
  }

  for (const c of table.errorCases) {
    test(`rejects: ${c.name}`, () => {
      expect(() => compileTemplateTool(c.tool as TemplateTool, c.args)).toThrow(TemplateToolError);
      expect(() => compileTemplateTool(c.tool as TemplateTool, c.args)).toThrow(new RegExp(c.error));
    });
  }
});

// The built-ins are generated from the Go source of truth, so the TS validator
// must accept every one of them. A failure here means the two halves disagree
// about what a valid tool is.
describe("built-in templates from the generated artifact", () => {
  test("the artifact is non-empty", () => {
    expect(Array.isArray(builtins)).toBe(true);
    expect(builtins.length).toBeGreaterThan(0);
  });

  for (const t of builtins as TemplateTool[]) {
    test(`${t.name} validates and compiles`, () => {
      expect(() => validateTemplateTool(t)).not.toThrow();
      const args: Record<string, unknown> = {};
      for (const p of t.params ?? []) {
        if (p.required) {
          args[p.name] = p.type === "string" ? "x" : p.type === "boolean" ? true : 1;
        }
      }
      const req = compileTemplateTool(t, args);
      expect(req.op).toBe(OpExec);
      expect(req.cmd?.length ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("the invariants that must survive any extension", () => {
  const base: TemplateTool = {
    name: "demo",
    description: "d",
    params: [{ name: "x", type: "string", description: "x" }],
    template: "echo {x}",
  };

  test("op can never be set through arguments", () => {
    expect(() => compileTemplateTool(base, { op: "shutdown" })).toThrow(/unknown argument/);
  });

  test("a parameter named op reaches the command, never the wire", () => {
    const t: TemplateTool = {
      ...base,
      name: "op_named",
      params: [{ name: "op", type: "string", description: "not the wire op" }],
      template: "echo {op}",
    };
    const req = compileTemplateTool(t, { op: "shutdown" });
    expect(req.op).toBe(OpExec);
    expect(req.cmd).toBe("echo 'shutdown'");
  });

  test("a tool cannot shadow the exec tool", () => {
    expect(() => validateTemplateTool({ ...base, name: execToolName })).toThrow(/reserved/);
  });

  test("compiling always yields an exec request", () => {
    expect(compileTemplateTool(base, { x: "1" }).op).toBe(OpExec);
  });
});

describe("shell quoting", () => {
  const t: TemplateTool = {
    name: "q",
    description: "d",
    params: [{ name: "v", type: "string", description: "v" }],
    template: "echo {v}",
  };

  // Not a security boundary while raw shell is exposed — but it is what keeps a
  // pattern with a space or a quote working, and what would make a
  // template-only session safe (PLAN §10.8 risk 15).
  const cases: [string, string][] = [
    ["plain", "echo 'plain'"],
    ["two words", "echo 'two words'"],
    ["semi;colon", "echo 'semi;colon'"],
    ["$(whoami)", "echo '$(whoami)'"],
    ["`id`", "echo '`id`'"],
    ["a && b", "echo 'a && b'"],
    ["new\nline", "echo 'new\nline'"],
    ["it's", `echo 'it'\\''s'`],
    ["", "echo ''"],
  ];
  for (const [input, expected] of cases) {
    test(`quotes ${JSON.stringify(input)}`, () => {
      expect(compileTemplateTool(t, { v: input }).cmd).toBe(expected);
    });
  }

  test("raw interpolation is not quoted", () => {
    const raw: TemplateTool = {
      name: "r",
      description: "d",
      params: [{ name: "n", type: "integer", description: "n" }],
      template: "head -n {n:raw} f",
    };
    expect(compileTemplateTool(raw, { n: 5 }).cmd).toBe("head -n 5 f");
  });
});

describe("definitions rendered for function calling", () => {
  test("params become schema properties and required is honoured", () => {
    const def = templateToolDefinition({
      name: "search",
      description: "find things",
      params: [
        { name: "pattern", type: "string", description: "what", required: true },
        { name: "path", type: "string", description: "where" },
      ],
      template: "grep {pattern} {path}",
    });
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("search");
    expect(Object.keys(def.function.parameters.properties ?? {})).toEqual(["pattern", "path"]);
    expect(def.function.parameters.required).toEqual(["pattern"]);
  });
});
