// Does what we hand Antares match what Antares was trained on?
//
// The fixtures below are transcribed from the technical report's Appendix A.1
// ("Tool Definitions"), which is the controlled interface every model in VLoc
// Bench received. The report is explicit that only the *serialization* of tool
// calls was adapted per model — the task instructions, the budget, the
// submission protocol and these schemas were held constant. So a deviation here
// is not a style difference; it is evaluating a different agent.
//
// This caught a real bug. The first implementation renamed keys on smolbox's
// generated schema and left the remainder in place, which handed the model
// `cwd`, `env`, `stdin` and `timeout_ms` — four arguments it never saw in
// training, three of which decodeArgs would have accepted.

import { describe, expect, test } from "bun:test";
import type { OpenAITool } from "../tool.ts";
import { antaresHostTools, hostToolDefinition } from "./host-tools.ts";
import {
  ANTARES_TERMINAL,
  IDENTITY_PROFILE,
  ProfileArgumentError,
  applyProfile,
  profiledDefinition,
} from "./tool-profile.ts";

/** Appendix A.1, verbatim. */
const REPORT_TERMINAL: OpenAITool = {
  type: "function",
  function: {
    name: "terminal",
    description:
      "Execute a read-only terminal command in the repository. Supports standard file navigation, search, and inspection utilities. Read-only access only. Output is truncated to max_chars.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        max_chars: {
          type: "integer",
          description: "Maximum number of output characters before truncation (default: 2000)",
          default: 2000,
        },
      },
      required: ["command"],
    },
  },
};

const REPORT_SUBMIT_FILES: OpenAITool = {
  type: "function",
  function: {
    name: "submit_vulnerable_files",
    description:
      "Submit your answer: a ranked list of file paths you believe contain the vulnerability. Paths relative to repository root.",
    parameters: {
      type: "object",
      properties: {
        ranked_files: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of file paths",
        },
      },
      required: ["ranked_files"],
    },
  },
};

const REPORT_SUBMIT_NONE: OpenAITool = {
  type: "function",
  function: {
    name: "submit_no_vulnerability_found",
    description:
      "Declare that no vulnerability matching the CWE description was found in this codebase.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

describe("the tool schema Antares actually receives", () => {
  test("terminal matches the report's definition exactly", () => {
    // Deep equality, not a subset check: an EXTRA property is the failure this
    // test exists to catch, and a subset assertion would have passed the bug.
    expect(profiledDefinition(ANTARES_TERMINAL)).toEqual(REPORT_TERMINAL);
  });

  test("submit_vulnerable_files matches the report's definition exactly", () => {
    expect(hostToolDefinition(antaresHostTools[0]!)).toEqual(REPORT_SUBMIT_FILES);
  });

  test("submit_no_vulnerability_found matches the report's definition exactly", () => {
    expect(hostToolDefinition(antaresHostTools[1]!)).toEqual(REPORT_SUBMIT_NONE);
  });

  test("exactly three tools are exposed, as the evaluated protocol had", () => {
    // The antares-cli adds a fourth, read_file. The evaluated protocol that
    // GRPO trained against did not have it (PLAN §11.1.10), so it stays off.
    expect(antaresHostTools).toHaveLength(2);
  });

  test("no stray schema keys reach the prompt", () => {
    // Granite's chat template renders each tool with `tojson`, so $schema and
    // title would become prompt text the model pays for on every turn.
    const params = profiledDefinition(ANTARES_TERMINAL).function.parameters as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["properties", "required", "type"]);
  });

  test("the rendered definition is a fraction of the unprofiled one", () => {
    // §10.1 measured run_terminal_command at 2301 characters of system prompt.
    // The whole argument for a narrow surface is that a small model pays for
    // every one of them on every turn.
    const profiled = JSON.stringify(profiledDefinition(ANTARES_TERMINAL)).length;
    const identity = JSON.stringify(profiledDefinition(IDENTITY_PROFILE)).length;
    expect(profiled).toBeLessThan(identity / 2);
  });
});

describe("profile argument mapping", () => {
  test("maps the trained names onto the wire names", () => {
    expect(applyProfile(ANTARES_TERMINAL, { name: "terminal", args: { command: "ls", max_chars: 2000 } })).toEqual(
      { name: "run_terminal_command", args: { cmd: "ls", max_output: 2000 } },
    );
  });

  test("rejects an argument outside the profile's surface", () => {
    // `cwd` is a REAL smolbox argument that decodeArgs would accept. That is
    // exactly why it has to be refused here: the model was never offered it.
    expect(() => applyProfile(ANTARES_TERMINAL, { name: "terminal", args: { command: "ls", cwd: "/tmp" } })).toThrow(
      ProfileArgumentError,
    );
    for (const key of ["env", "stdin", "timeout_ms", "op"]) {
      expect(() =>
        applyProfile(ANTARES_TERMINAL, { name: "terminal", args: { command: "ls", [key]: "x" } }),
      ).toThrow(ProfileArgumentError);
    }
  });

  test("rejects a call missing its required argument", () => {
    expect(() => applyProfile(ANTARES_TERMINAL, { name: "terminal", args: { max_chars: 10 } })).toThrow(
      ProfileArgumentError,
    );
  });

  test("the error names what the tool does accept, so the model can correct", () => {
    try {
      applyProfile(ANTARES_TERMINAL, { name: "terminal", args: { command: "ls", recursive: true } });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).toContain("command, max_chars");
    }
  });

  test("a call to a different tool passes through untouched", () => {
    const other = { name: "submit_vulnerable_files", args: { ranked_files: ["a.py"] } };
    expect(applyProfile(ANTARES_TERMINAL, other)).toBe(other);
  });

  test("a profile naming an argument the wire does not have fails loudly", () => {
    // The anti-drift gate. Rename `cmd` in the Go types and this is what tells
    // you, instead of a prompt describing an argument that no longer exists.
    expect(() =>
      profiledDefinition({
        name: "terminal",
        description: "x",
        arguments: { command: { wire: "not_a_field", description: "y" } },
        required: ["command"],
      }),
    ).toThrow(/not in the generated schema/);
  });
});
