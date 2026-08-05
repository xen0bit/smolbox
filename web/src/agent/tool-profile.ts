// A naming profile over the exec tool.
//
// Antares was RL-trained against a tool literally named `terminal`, taking
// `command` and `max_chars`. smolbox's exec tool is `run_terminal_command`,
// taking `cmd` and `max_output`. Neither side can move: renaming smolbox's
// surface would break the M7 anti-drift gates that generate it from the Go wire
// types, and hoping a 1.8B model adapts to a name it never saw in training is
// not a plan.
//
// So a profile renames what the model READS, and nothing else. The renamed
// arguments are mapped back before `decodeArgs` ever sees them, which means
// every guard that file provides still applies: `op` stays unreachable, unknown
// fields are still rejected, and the compiled request is byte-identical to the
// one the unprofiled name produces. That last property is what
// tool-profile.test.ts exists to prove — a profile that could alter a request
// would be a hole in the anti-drift story, not a convenience.

import type { OpenAITool, Schema } from "../tool.ts";
import { inputSchema, toolDescription, toolName } from "../tool.ts";
import type { ParsedCall } from "./parse.ts";

/** One argument as the model sees it, and where it lands on the wire. */
export interface ProfileArgument {
  /** The smolbox wire name this maps to. Must exist in the generated schema. */
  wire: string;
  /** Prompt text. The trained wording, not smolbox's. */
  description: string;
  /** Rendered into the schema when present, as the trained definition has it. */
  default?: unknown;
}

export interface ToolProfile {
  /** What the model sees this tool called. */
  name: string;
  /** Prompt text for it. The model's trained description, not smolbox's. */
  description: string;
  /**
   * The complete argument surface, model-facing name -> mapping.
   *
   * This is an ALLOWLIST, not a rename table. An earlier version renamed keys
   * on smolbox's generated schema and left the rest in place, which exposed
   * `cwd`, `env`, `stdin` and `timeout_ms` to a model that was never trained on
   * them — four arguments it could hallucinate into, and ~1900 characters of
   * prompt on every turn (§10.1 measures what that costs a small model).
   * Substituting keys on our schema is not the same as presenting theirs.
   */
  arguments: Record<string, ProfileArgument>;
  /** Model-facing names that must be present. */
  required: readonly string[];
}

/**
 * The Antares tool interface, from the technical report's Appendix A.1.
 *
 * The description is the report's wording verbatim rather than a paraphrase:
 * it is the string GRPO optimised against, and §11.1.14 measured that prompt
 * wording moves this model's behaviour and its score.
 */
export const ANTARES_TERMINAL: ToolProfile = {
  name: "terminal",
  description:
    "Execute a read-only terminal command in the repository. Supports standard file navigation, search, and inspection utilities. Read-only access only. Output is truncated to max_chars.",
  arguments: {
    command: { wire: "cmd", description: "The shell command to run" },
    max_chars: {
      wire: "max_output",
      description: "Maximum number of output characters before truncation (default: 2000)",
      default: 2000,
    },
  },
  required: ["command"],
};

/** No renaming. What every non-Antares model gets. */
export const IDENTITY_PROFILE: ToolProfile = {
  name: toolName,
  description: toolDescription,
  arguments: Object.fromEntries(
    Object.entries(inputSchema.properties ?? {}).map(([name, schema]) => [
      name,
      { wire: name, description: schema.description ?? "" },
    ]),
  ),
  required: inputSchema.required ?? [],
};

/**
 * The tool definition the model is shown, with names substituted.
 *
 * Built from the generated `inputSchema` rather than hand-written, so a field
 * added to protocol.Request shows up here too — the profile cannot silently
 * describe a stale surface.
 */
export function profiledDefinition(profile: ToolProfile): OpenAITool {
  const generated = inputSchema.properties ?? {};
  const properties: Record<string, Schema> = {};

  for (const [shown, arg] of Object.entries(profile.arguments)) {
    const source = generated[arg.wire];
    // The anti-drift gate, kept: a profile may only expose arguments the
    // generated schema actually has. Rename `cmd` in the Go wire types and this
    // throws at startup rather than describing a surface that no longer exists.
    if (!source) {
      throw new Error(
        `tool profile "${profile.name}": argument "${shown}" maps to "${arg.wire}", ` +
          `which is not in the generated schema (have: ${Object.keys(generated).join(", ")})`,
      );
    }
    // Type comes from the generated schema so it cannot drift; description and
    // default come from the profile, because they are the trained prompt text.
    properties[shown] = {
      type: source.type,
      description: arg.description,
      ...(source.items ? { items: source.items } : {}),
      ...(source.additionalProperties ? { additionalProperties: source.additionalProperties } : {}),
      ...(source.contentEncoding ? { contentEncoding: source.contentEncoding } : {}),
      ...(arg.default !== undefined ? { default: arg.default } : {}),
    };
  }

  for (const name of profile.required) {
    if (!profile.arguments[name]) {
      throw new Error(`tool profile "${profile.name}": required argument "${name}" is not declared`);
    }
  }

  // No `$schema` and no `title`. The Granite chat template renders each tool
  // with `tojson`, so every stray key becomes prompt text the model pays for
  // and was not trained to see.
  return {
    type: "function",
    function: {
      name: profile.name,
      description: profile.description,
      parameters: { type: "object", properties, required: [...profile.required] },
    },
  };
}

/**
 * Rewrites a call the model made into smolbox's argument names.
 *
 * `max_chars` is a *character* cap in Antares and `max_output` is a *byte* cap
 * on the wire. They differ on non-ASCII, and this maps one onto the other
 * anyway — because the alternative is dropping the model's only lever for
 * asking for more output. The rendered result reports `truncated` either way,
 * so the model still learns it was cut; it just may be cut slightly earlier
 * than it asked for. Recorded here rather than silently assumed equal.
 */
export function applyProfile(profile: ToolProfile, call: ParsedCall): ParsedCall {
  if (call.name !== profile.name) {
    return call;
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.args)) {
    const arg = profile.arguments[key];
    // Rejected, not passed through. The profile IS the tool's argument surface,
    // so an argument outside it is one the model invented — and several of
    // smolbox's real arguments (`cwd`, `env`, `stdin`) would otherwise be
    // accepted by decodeArgs and quietly take effect, which is off-protocol
    // even though the sandbox makes it harmless. Telling the model beats
    // silently obeying an instruction it was never offered.
    if (!arg) {
      throw new ProfileArgumentError(
        `${profile.name}: unknown argument "${key}" (accepts: ${Object.keys(profile.arguments).join(", ")})`,
      );
    }
    args[arg.wire] = value;
  }
  for (const name of profile.required) {
    if (args[profile.arguments[name]!.wire] === undefined) {
      throw new ProfileArgumentError(`${profile.name}: missing required argument "${name}"`);
    }
  }
  return { name: toolName, args };
}

/** Thrown for a call whose arguments are outside the profile's surface. */
export class ProfileArgumentError extends Error {}

/** Whether this profile renames anything at all. */
export function isIdentity(profile: ToolProfile): boolean {
  return (
    profile.name === toolName &&
    Object.entries(profile.arguments).every(([shown, arg]) => shown === arg.wire)
  );
}
