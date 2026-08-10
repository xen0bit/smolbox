// What the model is allowed to see, and how a call it makes gets executed.
//
// Three sources, one dispatch path:
//   1. the exec tool (run_terminal_command), generated from the Go wire types
//   2. built-in templates, generated from Go into docs/schema/builtin-tools.json
//   3. user-defined templates, created at runtime and validated against the
//      same rules
//
// Whatever the source, a call ends up as a protocol.Request with op fixed to
// exec. More tools never means more ways into the guest.
//
// Exposure is opt-in and defaults to the exec tool alone, because a definition
// is prompt text the model re-reads every turn: run_terminal_command alone
// already costs ~2301 characters (PLAN §10.1). Whether narrow tools help a
// small model at all is an open question, not an assumption (PLAN §10.7).

import builtinArtifact from "../../../docs/schema/builtin-tools.json" with { type: "json" };
import type { Request, Response } from "../protocol.ts";
import type { OpenAITool, ToolSession } from "../tool.ts";
import { decodeArgs, openaiTool, renderResult, toolDescription, toolName } from "../tool.ts";
import type { ParsedCall } from "./parse.ts";
import {
  type TemplateTool,
  compileTemplateTool,
  templateToolDefinition,
  validateTemplateTool,
} from "./user-tools.ts";

export const builtinTemplates = builtinArtifact as TemplateTool[];

/**
 * JSON Schema *document* keys, which a tool's `parameters` is not.
 *
 * `$schema` declares which dialect a standalone schema document is written in
 * and `title` names it. Both are meaningful in `docs/schema/*.json`, which are
 * documents someone validates against; neither is meaningful inside a
 * `function.parameters` fragment, where the model is being told what arguments
 * exist. They are removed here rather than at the source because the published
 * artifacts are a contract — `TestArtifactsAreCurrent` pins them to the Go
 * types — and this is the only path that ends up as prompt text.
 *
 * Measured, not tidied (PLAN §10.20). LFM2.5 350M given the unstripped schema
 * opened its call with `$schema="https://json-schema.org/draft/2020-12/schema"`
 * as the first argument and never emitted `cmd` at all: at that size the model
 * transcribes the schema's keys instead of filling them in, and `$schema` is
 * the first key it sees. The parser then died on `$` before any of it could be
 * called wrong. Bigger models ignore these two keys; small ones copy them.
 */
const SCHEMA_DOC_KEYS = ["$schema", "title"] as const;

/**
 * One definition with the document metadata removed.
 *
 * Copies rather than mutates: `openaiTool()` returns a fresh object each call
 * but `templateToolDefinition` need not, and a registry that quietly edited its
 * inputs would be a bug that only shows up on the second call.
 */
function stripSchemaMetadata(def: OpenAITool): OpenAITool {
  const { parameters } = def.function;
  if (!parameters || !SCHEMA_DOC_KEYS.some((k) => k in parameters)) {
    return def;
  }
  const cleaned: Record<string, unknown> = { ...parameters };
  for (const key of SCHEMA_DOC_KEYS) {
    delete cleaned[key];
  }
  return {
    ...def,
    function: { ...def.function, parameters: cleaned as OpenAITool["function"]["parameters"] },
  };
}

/** Per-session defaults applied to every call that does not set them itself. */
export interface SessionDefaults {
  timeout_ms?: number;
  max_output?: number;
  cwd?: string;
}

export interface ToolRegistryState {
  /** The exec tool. Off is legal — that is the "template-only session". */
  execEnabled: boolean;
  /** Overrides the exec tool's prompt text when set. */
  execDescription?: string;
  /** Template tool name -> exposed. Absent means off. */
  enabled: Record<string, boolean>;
  userTools: TemplateTool[];
  defaults: SessionDefaults;
}

export function defaultState(): ToolRegistryState {
  return { execEnabled: true, enabled: {}, userTools: [], defaults: {} };
}

export interface ToolListing {
  name: string;
  description: string;
  source: "exec" | "builtin" | "user";
  enabled: boolean;
}

export class ToolRegistry {
  constructor(private state: ToolRegistryState = defaultState()) {}

  snapshot(): ToolRegistryState {
    return structuredClone(this.state);
  }

  load(state: ToolRegistryState): void {
    for (const t of state.userTools ?? []) {
      validateTemplateTool(t);
    }
    this.state = { ...defaultState(), ...state };
  }

  /** Every template, built-in or user-defined, by name. */
  private templates(): Map<string, { tool: TemplateTool; source: "builtin" | "user" }> {
    const out = new Map<string, { tool: TemplateTool; source: "builtin" | "user" }>();
    for (const t of builtinTemplates) {
      out.set(t.name, { tool: t, source: "builtin" });
    }
    // A user tool of the same name shadows the built-in deliberately: editing a
    // shipped tool is the obvious way to adjust one you almost like.
    for (const t of this.state.userTools) {
      out.set(t.name, { tool: t, source: "user" });
    }
    return out;
  }

  list(): ToolListing[] {
    const out: ToolListing[] = [
      {
        name: toolName,
        description: this.state.execDescription ?? toolDescription,
        source: "exec",
        enabled: this.state.execEnabled,
      },
    ];
    for (const [name, { tool, source }] of this.templates()) {
      out.push({ name, description: tool.description, source, enabled: this.state.enabled[name] === true });
    }
    return out;
  }

  setEnabled(name: string, on: boolean): void {
    if (name === toolName) {
      this.state.execEnabled = on;
      return;
    }
    this.state.enabled[name] = on;
  }

  setExecDescription(text: string | undefined): void {
    this.state.execDescription = text?.trim() ? text : undefined;
  }

  setDefaults(d: SessionDefaults): void {
    this.state.defaults = { ...this.state.defaults, ...d };
  }

  defaults(): SessionDefaults {
    return { ...this.state.defaults };
  }

  addUserTool(tool: TemplateTool): void {
    validateTemplateTool(tool);
    this.state.userTools = [...this.state.userTools.filter((t) => t.name !== tool.name), tool];
    this.state.enabled[tool.name] = true;
  }

  removeUserTool(name: string): void {
    this.state.userTools = this.state.userTools.filter((t) => t.name !== name);
    delete this.state.enabled[name];
  }

  /** The definitions handed to the model. Order is stable: exec first. */
  definitions(): OpenAITool[] {
    const out: OpenAITool[] = [];
    if (this.state.execEnabled) {
      const def = openaiTool();
      if (this.state.execDescription) {
        def.function.description = this.state.execDescription;
      }
      out.push(def);
    }
    for (const [name, { tool }] of this.templates()) {
      if (this.state.enabled[name] === true) {
        out.push(templateToolDefinition(tool));
      }
    }
    return out.map(stripSchemaMetadata);
  }

  /**
   * Executes one call the model made.
   *
   * A call naming a tool that is not exposed is an error the model can correct,
   * not a crash: models hallucinate tool names, and the answer is to say so.
   *
   * `maxOutput` is the loop's per-call budget. It is applied to the compiled
   * *request*, never to the model's arguments: a template tool declares its own
   * parameters and rejects anything else, so injecting max_output into the
   * argument object would make every template call fail as "unknown argument".
   */
  async run(
    session: ToolSession,
    call: ParsedCall,
    opts: { maxOutput?: number } = {},
  ): Promise<{ text: string; response: Response; request: Request }> {
    let req: Request;

    if (call.name === toolName) {
      if (!this.state.execEnabled) {
        throw new UnknownToolError(call.name, this.exposedNames());
      }
      // decodeArgs rather than callTool, so the budget lands on the request the
      // same way it does for a template tool. Its guards (no `op`, no unknown
      // fields) are unchanged.
      req = decodeArgs(this.withDefaults(call.args));
    } else {
      const entry = this.templates().get(call.name);
      if (!entry || this.state.enabled[call.name] !== true) {
        throw new UnknownToolError(call.name, this.exposedNames());
      }
      req = compileTemplateTool(entry.tool, call.args);
      if (!req.timeout_ms && this.state.defaults.timeout_ms) {
        req.timeout_ms = this.state.defaults.timeout_ms;
      }
      if (!req.max_output && this.state.defaults.max_output) {
        req.max_output = this.state.defaults.max_output;
      }
      if (!req.cwd && this.state.defaults.cwd) {
        req.cwd = this.state.defaults.cwd;
      }
    }

    const cap = opts.maxOutput ?? 0;
    if (cap > 0 && (!req.max_output || req.max_output > cap)) {
      req.max_output = cap;
    }

    const response = await session.exec(req);
    return { text: renderResult(response), response, request: req };
  }

  private withDefaults(args: Record<string, unknown>): Record<string, unknown> {
    const out = { ...args };
    for (const key of ["timeout_ms", "max_output", "cwd"] as const) {
      if (out[key] === undefined && this.state.defaults[key] !== undefined) {
        out[key] = this.state.defaults[key];
      }
    }
    return out;
  }

  exposedNames(): string[] {
    return this.list()
      .filter((t) => t.enabled)
      .map((t) => t.name);
  }
}

export class UnknownToolError extends Error {
  constructor(name: string, exposed: string[]) {
    super(
      `tool: no tool named "${name}" is available` +
        (exposed.length ? ` (available: ${exposed.join(", ")})` : " (no tools are enabled)"),
    );
  }
}
