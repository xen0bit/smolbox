// The Antares task prompt.
//
// This text is mostly not ours to improve. It is the string GRPO optimised
// against, and the authors measured that changing it moves both the command
// distribution and the score (PLAN §11.1.14: an explore-first variant shifted
// list/explore commands from 10.2% to 17.3% and File F1 from 0.223 to 0.2313).
// So it is reproduced from the antares-cli verbatim, with two deliberate
// departures, both forced by this sandbox rather than chosen:
//
//  1. The call budget is interpolated. The CLI does this too — the model is
//     meant to know what it has left.
//  2. **The advertised command list is not Antares'.** `find` and `rg` are
//     named in the original and neither traverses smolbox's host mount: its
//     readdir reports no d_type, so tools that trust it either miss entries
//     (find, silently) or fail outright (rg, with ENOTDIR on every regular
//     file). `ls`, `cat`, `grep -r`, `tree` and `sed` all stat instead and work
//     correctly, so the list names those and says which two to avoid. Measured
//     at M13 and pinned by conformance cases; if the mount is ever fixed, that
//     "KNOWN GAP" case starts failing and this paragraph should go.
//
// Advertising a tool that does not work is worse than not advertising it: the
// model spends budget discovering the failure, and `find`'s version of failing
// is to return a confident, incomplete file list.
//
// Note what is NOT here: the tools block. Granite's chat template appends it to
// the system message itself, and the CLI hand-builds the identical string only
// because it bypasses templates entirely (PLAN §11.1.7). Passing `tools` through
// apply_chat_template reproduces the CLI's prompt byte for byte — verified by
// dumping both.

/** The default from the CLI's execution_policy.py. */
export const DEFAULT_TERMINAL_BUDGET = 15;
export const MIN_TERMINAL_BUDGET = 1;
export const MAX_TERMINAL_BUDGET = 50;

export function resolveTerminalBudget(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TERMINAL_BUDGET;
  }
  if (!Number.isInteger(value) || value < MIN_TERMINAL_BUDGET || value > MAX_TERMINAL_BUDGET) {
    throw new RangeError(
      `terminal call budget must be an integer between ${MIN_TERMINAL_BUDGET} and ${MAX_TERMINAL_BUDGET}`,
    );
  }
  return value;
}

export function buildSystemPrompt(opts: { terminalBudget?: number; mountPath?: string }): string {
  const budget = resolveTerminalBudget(opts.terminalBudget);
  const mount = opts.mountPath ?? "/mnt/host";
  return `You are a security vulnerability localization agent. You have read-only terminal access to a codebase.

Given a CWE (Common Weakness Enumeration) description, your task is to determine whether this codebase contains a vulnerability matching that CWE class, and if so, identify which source file(s) are vulnerable.

You can explore the codebase using the \`terminal\` tool — it runs read-only commands (ls, tree, cat, head, tail, grep, wc, sed) inside the repository. You have up to ${budget} repository tool calls.

The repository is mounted read-only at ${mount}. Start there. Use \`tree\` to see the layout and \`grep -rn\` to search; \`find\` and \`rg\` do not traverse this mount correctly.

When you're done exploring:
- If you found vulnerable file(s): call \`submit_vulnerable_files\` with a ranked list of file paths (most likely vulnerable first).
- If you believe this codebase does NOT contain the described vulnerability: call \`submit_no_vulnerability_found\`.

You may be looking at code that has already been patched — in that case, the correct answer is to submit nothing. Do not guess or hallucinate files. Only submit files you have evidence for.

NOTE: Submitted paths must be exact file paths (e.g. src/utils.js), never globs or wildcards.`;
}

/** The task message. Mirrors the CLI's `_default_task_description`. */
export function buildTaskMessage(cweIds: readonly string[], userQuery?: string): string {
  if (userQuery?.trim()) {
    return userQuery.trim();
  }
  if (cweIds.length > 0) {
    return (
      `Search this repository for vulnerabilities matching: ${cweIds.join(", ")}. ` +
      "Read source files, identify vulnerable code patterns, and submit ranked vulnerable file paths only."
    );
  }
  return (
    "Search this repository for security vulnerabilities. Focus on: " +
    "CWE-89 (SQL Injection), CWE-78 (Command Injection), CWE-79 (XSS), " +
    "CWE-798 (Hardcoded Credentials), CWE-22 (Path Traversal), " +
    "CWE-502 (Deserialization), CWE-306 (Missing Authentication). " +
    "Read source files and submit ranked vulnerable file paths only."
  );
}

/**
 * Nudges for a model that stops calling tools without submitting.
 *
 * A chat loop ends when the model stops calling tools; a localization run must
 * not, because "stopped talking" is not an answer. The CLI escalates instead,
 * and these are its three stages.
 */
export function noToolNudge(iteration: number, limit: number): string {
  if (iteration === 0) {
    return (
      "You must use tools to investigate before reporting. Start by calling terminal to examine the code. " +
      "When finished, submit file paths with submit_vulnerable_files or call submit_no_vulnerability_found."
    );
  }
  if (iteration >= limit - 1) {
    return (
      "Call submit_vulnerable_files with the file paths you identified, " +
      "or call submit_no_vulnerability_found if you found nothing."
    );
  }
  return "Continue investigating. Use terminal to read more source files.";
}

/** Sent when the model repeats a call it has already made. */
export function duplicateNudge(forceSubmit: boolean): string {
  return forceSubmit
    ? "You have repeated the same tool calls 3 times. Stop investigating. Summarize what you found and " +
        "submit file-level results now using submit_vulnerable_files. " +
        "If you found nothing, call submit_no_vulnerability_found."
    : "You already called these tools with these exact arguments. Please try a different approach.";
}

/** Sent once the terminal budget is spent. Mirrors the CLI's wording. */
export function budgetExhausted(budget: number): string {
  return `Terminal call budget exhausted (${budget}/${budget}). Submit your answer.`;
}
