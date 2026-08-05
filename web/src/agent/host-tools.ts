// Host tools: the kind of tool that never reaches the guest.
//
// PLAN §10.5 set an invariant — every tool compiles to an exec `Request`, so
// there is exactly one way into the VM. Antares breaks it, because
// `submit_vulnerable_files` and `submit_no_vulnerability_found` are not
// commands. They are how a localization run ENDS. There is nothing to execute.
//
// The invariant is amended rather than abandoned:
//
//   every tool that reaches the guest compiles to an exec Request,
//   and a host tool reaches nothing.
//
// That is enforced structurally, not by convention. A `HostTool` has no
// `ToolSession` in scope and no way to obtain one; its `resolve` returns a
// plain value. host-tools.test.ts asserts the negative directly: no path from
// here produces a Request, and the exec registry refuses these names.

import type { OpenAITool } from "../tool.ts";

/** A ranked file the model submitted, after validation against the mount. */
export interface Finding {
  path: string;
  rank: number;
  /** False when the path does not exist in the mounted tree. */
  exists: boolean;
}

export interface SubmissionResult {
  kind: "vulnerable-files" | "no-vulnerability";
  findings: Finding[];
  /** Paths the model submitted that could not be resolved in the mount. */
  rejected: string[];
}

/**
 * Checks a submitted path against the real mounted tree.
 *
 * Not cosmetic. At 0.135 File F1 a hallucinated path is a routine output, not
 * an edge case, and an unverifiable path in a findings list is worse than no
 * path — it reads exactly like a real one. The antares-cli validates the same
 * way and for the same reason.
 */
export type PathChecker = (path: string) => Promise<boolean>;

export interface HostTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Ends the run when true. Both submit tools do. */
  terminal: boolean;
  resolve(args: Record<string, unknown>, check: PathChecker): Promise<SubmissionResult>;
}

/**
 * Normalises a path the way the antares-cli does before checking it.
 *
 * Rejects absolute paths and anything climbing out of the tree: a submission is
 * a repository-relative file path by definition, and `../../etc/passwd` is not
 * a finding about the user's code.
 */
export function normalizeSubmittedPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
    return undefined;
  }
  // The model is told "never globs or wildcards" and sometimes emits them
  // anyway; a glob cannot be checked for existence, so it is not a finding.
  if (path.includes("*") || path.includes("?")) {
    return undefined;
  }
  return path;
}

/**
 * Pulls the ranked list out of the model's arguments.
 *
 * Accepts the aliases the antares-cli accepts (`ranked_files`, `files`,
 * `file_paths`) and entries that are either strings or objects carrying a path
 * — both of which real models produce.
 */
export function extractRankedFiles(args: Record<string, unknown>): { paths: string[]; rejected: string[] } {
  const raw = args.ranked_files ?? args.files ?? args.file_paths;
  const paths: string[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(raw)) {
    return { paths, rejected };
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    const candidate =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ((entry as Record<string, unknown>).file_path ??
            (entry as Record<string, unknown>).path ??
            (entry as Record<string, unknown>).file)
          : undefined;
    const normalized = normalizeSubmittedPath(candidate);
    if (normalized === undefined) {
      if (typeof candidate === "string") {
        rejected.push(candidate);
      }
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return { paths, rejected };
}

export const submitVulnerableFiles: HostTool = {
  name: "submit_vulnerable_files",
  // The report's Appendix A.1 wording, verbatim.
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
  terminal: true,
  async resolve(args, check) {
    const { paths, rejected } = extractRankedFiles(args);
    const findings: Finding[] = [];
    const missing = [...rejected];
    let rank = 0;
    for (const path of paths) {
      const exists = await check(path);
      if (!exists) {
        missing.push(path);
        continue;
      }
      rank++;
      findings.push({ path, rank, exists });
    }
    return { kind: "vulnerable-files", findings, rejected: missing };
  },
};

export const submitNoVulnerabilityFound: HostTool = {
  name: "submit_no_vulnerability_found",
  description: "Declare that no vulnerability matching the CWE description was found in this codebase.",
  parameters: { type: "object", properties: {}, required: [] },
  terminal: true,
  async resolve() {
    return { kind: "no-vulnerability", findings: [], rejected: [] };
  },
};

export const antaresHostTools: readonly HostTool[] = [
  submitVulnerableFiles,
  submitNoVulnerabilityFound,
];

export function hostToolDefinition(tool: HostTool): OpenAITool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  } as OpenAITool;
}

export function findHostTool(
  tools: readonly HostTool[],
  name: string,
): HostTool | undefined {
  return tools.find((t) => t.name === name);
}
