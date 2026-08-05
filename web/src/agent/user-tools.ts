// The TS twin of internal/tool/template.go: narrow, task-shaped tools that
// compile to an ordinary exec request.
//
// Like protocol.ts and tool.ts this is hand-written rather than generated, and
// held to the Go original by a shared golden table — tests/tool/template-cases.json,
// run by both the Go tests and the bun tests. Change one side and the other fails.
//
// Every tool here, built-in or user-defined, ends up as a Request with op fixed
// to exec. That is the invariant the whole extension mechanism rests on: more
// tools must never mean more ways into the guest.

import type { Request } from "../protocol.ts";
import { OpExec } from "../protocol.ts";
import type { OpenAITool, Schema } from "../tool.ts";
import { toolName as execToolName } from "../tool.ts";

export type ParamType = "string" | "integer" | "number" | "boolean";

export interface TemplateParam {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean;
  default?: string;
}

export interface TemplateTool {
  name: string;
  description: string;
  params: TemplateParam[];
  template: string;
  timeout_ms?: number;
  max_output?: number;
}

export class TemplateToolError extends Error {}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)(:raw)?\}/g;
const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean"]);

/** Names a template may not take. Shadowing the exec tool would let a macro
 * impersonate the surface everything else is specified against. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([execToolName]);

export function validateTemplateTool(t: TemplateTool): void {
  if (typeof t?.name !== "string" || !NAME_RE.test(t.name)) {
    throw new TemplateToolError(`tool: invalid template tool: name ${JSON.stringify(t?.name)} must match ${NAME_RE}`);
  }
  if (RESERVED_NAMES.has(t.name)) {
    throw new TemplateToolError(`tool: invalid template tool: name "${t.name}" is reserved`);
  }
  if (typeof t.description !== "string" || t.description.trim() === "") {
    throw new TemplateToolError(`tool: invalid template tool: ${t.name} has no description`);
  }
  if (typeof t.template !== "string" || t.template.trim() === "") {
    throw new TemplateToolError(`tool: invalid template tool: ${t.name} has an empty template`);
  }
  if ((t.timeout_ms ?? 0) < 0 || (t.max_output ?? 0) < 0) {
    throw new TemplateToolError(`tool: invalid template tool: ${t.name} has a negative timeout_ms or max_output`);
  }

  const declared = new Set<string>();
  for (const p of t.params ?? []) {
    if (typeof p?.name !== "string" || !NAME_RE.test(p.name)) {
      throw new TemplateToolError(
        `tool: invalid template tool: ${t.name}: parameter ${JSON.stringify(p?.name)} must match ${NAME_RE}`,
      );
    }
    if (declared.has(p.name)) {
      throw new TemplateToolError(`tool: invalid template tool: ${t.name}: duplicate parameter "${p.name}"`);
    }
    if (!PARAM_TYPES.has(p.type)) {
      throw new TemplateToolError(
        `tool: invalid template tool: ${t.name}: parameter "${p.name}" has unknown type ${JSON.stringify(p.type)}`,
      );
    }
    if (typeof p.description !== "string" || p.description.trim() === "") {
      throw new TemplateToolError(
        `tool: invalid template tool: ${t.name}: parameter "${p.name}" has no description`,
      );
    }
    declared.add(p.name);
  }

  for (const m of t.template.matchAll(PLACEHOLDER_RE)) {
    if (!declared.has(m[1]!)) {
      throw new TemplateToolError(
        `tool: invalid template tool: ${t.name}: template uses undeclared parameter {${m[1]}}`,
      );
    }
  }
}

/**
 * Turns a model's arguments into an exec request.
 *
 * Interpolations are single-quoted so a value containing a space, a quote or a
 * semicolon lands as one argument rather than as syntax; `{param:raw}` opts out.
 * The quoting is for correctness, not security — while run_terminal_command is
 * exposed the model can already run arbitrary shell — but it is what makes a
 * future template-only session safe by construction.
 */
export function compileTemplateTool(t: TemplateTool, args: Record<string, unknown>): Request {
  validateTemplateTool(t);

  const params = t.params ?? [];
  const byName = new Map(params.map((p) => [p.name, p]));

  const known = params.map((p) => p.name).sort();
  for (const key of Object.keys(args ?? {})) {
    if (!byName.has(key)) {
      throw new TemplateToolError(
        `tool: invalid template tool: ${t.name}: unknown argument "${key}" (known: ${known.join(", ")})`,
      );
    }
  }

  const values = new Map<string, string>();
  for (const p of params) {
    const raw = args?.[p.name];
    if (raw === undefined || raw === null) {
      if (p.required) {
        throw new TemplateToolError(`tool: missing required argument: ${t.name}: ${p.name}`);
      }
      values.set(p.name, p.default ?? "");
      continue;
    }
    values.set(p.name, scalarString(raw, p, t.name));
  }

  const cmd = t.template.replace(PLACEHOLDER_RE, (_m, name: string, raw?: string) => {
    const v = values.get(name) ?? "";
    return raw ? v : shellQuote(v);
  });

  const req: Request = { op: OpExec, cmd };
  if (t.timeout_ms) {
    req.timeout_ms = t.timeout_ms;
  }
  if (t.max_output) {
    req.max_output = t.max_output;
  }
  return req;
}

function scalarString(v: unknown, p: TemplateParam, toolNameForError: string): string {
  switch (p.type) {
    case "string":
      if (typeof v !== "string") {
        throw new TemplateToolError(`tool: invalid template tool: ${toolNameForError}: ${p.name} must be a string`);
      }
      return v;
    case "boolean":
      if (typeof v !== "boolean") {
        throw new TemplateToolError(`tool: invalid template tool: ${toolNameForError}: ${p.name} must be a boolean`);
      }
      return v ? "true" : "false";
    case "integer":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TemplateToolError(`tool: invalid template tool: ${toolNameForError}: ${p.name} must be a number`);
      }
      if (p.type === "integer" && !Number.isInteger(v)) {
        throw new TemplateToolError(`tool: invalid template tool: ${toolNameForError}: ${p.name} must be an integer`);
      }
      return String(v);
    }
  }
}

// Single quotes are fully literal in sh. The one character that cannot appear
// inside them is a single quote, so it is closed, escaped, and reopened.
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Renders the tool for function calling, deriving the schema from its params. */
export function templateToolDefinition(t: TemplateTool): OpenAITool {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of t.params ?? []) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.required) {
      required.push(p.name);
    }
  }
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: `${t.name} arguments`,
        type: "object",
        properties,
        required,
      },
    },
  };
}
