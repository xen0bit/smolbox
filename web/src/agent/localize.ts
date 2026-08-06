// The Antares localization run.
//
// A sibling of Conversation, not a configuration of it. They share interfaces —
// ModelClient, ToolRunner, the dialect — and differ in policy in ways that are
// not parameters:
//
//   * A chat turn ENDS when the model stops calling tools. A localization run
//     must not: "stopped talking" is not an answer, so the loop nudges instead
//     (PLAN §11.4). It ends on a submit call or on a budget.
//   * The terminal-call budget is counted separately from loop iterations, and
//     is interpolated into the system prompt, so the model knows what it has
//     left. Spending it is a normal outcome, not an error.
//   * The task message is PINNED during elision. Conversation.elide drops from
//     the front of history once tool outputs are exhausted, which for a run
//     conditioned entirely on one CWE statement would be fatal.
//
// Like Conversation, this file is pure with respect to the model and the guest,
// so the whole protocol is drivable by FakeModelClient in CI with no GPU.

import type { Dialect } from "./dialects/index.ts";
import {
  budgetExhausted,
  duplicateNudge,
  noToolNudge,
  resolveTerminalBudget,
} from "./antares-prompt.ts";
import type { Finding, HostTool, PathChecker, SubmissionResult } from "./host-tools.ts";
import { findHostTool } from "./host-tools.ts";
import type { ChatMessage } from "./messages.ts";
import type { ModelClient } from "./model-client.ts";
import { type ParsedCall, ToolCallParseError } from "./parse.ts";
import { type ToolProfile, applyProfile } from "./tool-profile.ts";
import type { ToolRunner } from "./conversation.ts";

export type LocalizeEvent =
  | { kind: "task"; text: string }
  | { kind: "token"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-start"; call: ParsedCall; remaining: number }
  | { kind: "tool-end"; call: ParsedCall; rendered: string; exitCode: number; remaining: number }
  | { kind: "nudge"; text: string; reason: "no-tool" | "duplicate" | "budget" }
  | { kind: "elided"; messages: number }
  | { kind: "submitted"; result: SubmissionResult }
  | { kind: "stopped"; reason: "iteration-cap" | "budget-and-no-submission" | "cancelled" }
  | { kind: "error"; message: string };

export interface LocalizeOptions {
  systemPrompt: string;
  taskMessage: string;
  /** Definitions shown to the model: the profiled terminal tool plus host tools. */
  tools: unknown[];
  dialect: Dialect;
  profile: ToolProfile;
  hostTools: readonly HostTool[];
  /** Read-only calls into the mount the model may make. Default 15. */
  terminalBudget?: number;
  /** Hard cap on model turns, independent of the tool budget. */
  maxIterations: number;
  perCallMaxOutput: number;
  maxNewTokens: number;
  historyBudgetChars: number;
  /** Resolves a submitted path against the real mounted tree. */
  checkPath: PathChecker;
}

export const LOCALIZE_DEFAULTS = {
  // The CLI's MAXIMUM_MODEL_LOOP_ITERATIONS is 50. It is a runaway guard, not a
  // budget: the terminal budget is what actually bounds the work.
  maxIterations: 50,
  perCallMaxOutput: 4096,
  // The report's rollout setting. Enough for reasoning plus a call.
  maxNewTokens: 4096,
  historyBudgetChars: 48_000,
} as const;

/** How many identical repeats before the loop forces a submission. */
const DUPLICATE_FORCE_THRESHOLD = 3;
/** Nudge stages before the loop gives up on getting a submission. */
const NO_TOOL_LIMIT = 5;

/** One command that mentioned a submitted path, and what it returned. */
export interface Evidence {
  command: string;
  exitCode: number;
  /** The matching line of output, when the path appeared there rather than in the command. */
  line?: string;
}

/**
 * A finding plus the commands that led to it.
 *
 * The trace is the product here, not a debug view: at 0.135 File F1 a bare
 * ranked path is not something a person can act on, and "which command made the
 * model think this?" is the first question they will ask (PLAN §11.5).
 */
export interface EvidencedFinding extends Finding {
  evidence: Evidence[];
}

export interface LocalizeResult {
  submitted: boolean;
  findings: EvidencedFinding[];
  rejected: string[];
  terminalCallsUsed: number;
  stoppedBecause: string;
  /** Wall-clock milliseconds for the whole run. */
  elapsedMs: number;
}

export class LocalizeRun {
  /** Everything after the system prompt. history[0] is the pinned task message. */
  private history: ChatMessage[] = [];
  private cancelled = false;
  private terminalCallsUsed = 0;
  private noToolTurns = 0;
  private readonly callCounts = new Map<string, number>();
  private result: SubmissionResult | null = null;
  /** Every executed command and what it returned, for evidence attribution. */
  private readonly commandLog: { command: string; output: string; exitCode: number }[] = [];
  private startedAt = 0;

  constructor(
    private readonly opts: LocalizeOptions,
    private readonly model: ModelClient,
    private readonly tools: ToolRunner,
    private readonly emit: (ev: LocalizeEvent) => void,
  ) {}

  messages(): ChatMessage[] {
    return [{ role: "system", content: this.opts.systemPrompt }, ...this.history];
  }

  cancel(): void {
    this.cancelled = true;
    this.model.cancel();
  }

  private get budget(): number {
    return resolveTerminalBudget(this.opts.terminalBudget);
  }

  async run(): Promise<LocalizeResult> {
    this.startedAt = Date.now();
    this.history = [{ role: "user", content: this.opts.taskMessage }];
    this.emit({ kind: "task", text: this.opts.taskMessage });

    let stoppedBecause = "iteration-cap";

    for (let i = 0; i < this.opts.maxIterations; i++) {
      if (this.cancelled) {
        this.emit({ kind: "stopped", reason: "cancelled" });
        stoppedBecause = "cancelled";
        break;
      }
      this.elide();

      const generated = await this.model.generate({
        messages: this.messages(),
        tools: this.opts.tools,
        maxNewTokens: this.opts.maxNewTokens,
        onToken: (t) => this.emit({ kind: "token", text: t }),
      });

      if (this.cancelled || generated.stopped) {
        this.history.push({ role: "assistant", content: generated.text });
        this.emit({ kind: "stopped", reason: "cancelled" });
        stoppedBecause = "cancelled";
        break;
      }

      let calls: ParsedCall[];
      let prose: string;
      try {
        const parsed = this.opts.dialect.parseTurn(generated.text);
        calls = parsed.calls;
        prose = parsed.text;
      } catch (err) {
        const message = err instanceof ToolCallParseError ? err.message : String(err);
        this.emit({ kind: "error", message });
        this.history.push({ role: "assistant", content: generated.text });
        this.history.push({ role: "tool", content: `error: ${message}` });
        continue;
      }

      this.history.push({ role: "assistant", content: generated.text });
      if (prose) {
        this.emit({ kind: "thinking", text: prose });
      }

      if (calls.length === 0) {
        // The chat loop would return here. This one escalates, because a run
        // that ends without a submission has produced no answer at all.
        const text = noToolNudge(this.noToolTurns, NO_TOOL_LIMIT);
        this.noToolTurns++;
        if (this.noToolTurns > NO_TOOL_LIMIT) {
          this.emit({ kind: "stopped", reason: "budget-and-no-submission" });
          stoppedBecause = "model stopped calling tools without submitting";
          break;
        }
        this.emit({ kind: "nudge", text, reason: "no-tool" });
        this.history.push({ role: "tool", content: text });
        continue;
      }
      this.noToolTurns = 0;

      const done = await this.runCalls(calls);
      if (done) {
        stoppedBecause = "submitted";
        break;
      }
    }

    if (stoppedBecause === "iteration-cap") {
      this.emit({ kind: "stopped", reason: "iteration-cap" });
    }
    return {
      submitted: this.result !== null,
      findings: (this.result?.findings ?? []).map((f) => ({
        ...f,
        evidence: this.evidenceFor(f.path),
      })),
      rejected: this.result?.rejected ?? [],
      terminalCallsUsed: this.terminalCallsUsed,
      stoppedBecause,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  /**
   * The commands that mentioned a submitted path.
   *
   * A deliberately simple attribution: the model does not tell us why it chose
   * a file, so the honest reconstruction is "these are the commands whose
   * output or arguments named it". Presenting that as a guess the reader can
   * check beats inventing a rationale the model never gave.
   */
  private evidenceFor(path: string): Evidence[] {
    const out: Evidence[] = [];
    for (const entry of this.commandLog) {
      const inCommand = entry.command.includes(path);
      const line = entry.output.split("\n").find((l) => l.includes(path));
      if (!inCommand && line === undefined) {
        continue;
      }
      out.push({
        command: entry.command,
        exitCode: entry.exitCode,
        ...(line !== undefined && !inCommand ? { line: line.trim().slice(0, 200) } : {}),
      });
      if (out.length === 3) {
        break;
      }
    }
    return out;
  }

  /** Returns true when the run should end (a submission landed). */
  private async runCalls(calls: ParsedCall[]): Promise<boolean> {
    for (const call of calls) {
      if (this.cancelled) {
        return false;
      }

      const host = findHostTool(this.opts.hostTools, call.name);
      if (host) {
        // A host tool never touches the session. This is the amended §10.5
        // invariant in code: there is no path from here to an exec Request.
        const result = await host.resolve(call.args, this.opts.checkPath);
        this.result = result;
        this.emit({ kind: "submitted", result });
        return host.terminal;
      }

      if (this.isDuplicate(call)) {
        const count = this.callCounts.get(fingerprint(call)) ?? 0;
        const force = count >= DUPLICATE_FORCE_THRESHOLD;
        const text = duplicateNudge(force);
        this.emit({ kind: "nudge", text, reason: "duplicate" });
        this.history.push({ role: "tool", content: text });
        continue;
      }

      if (this.terminalCallsUsed >= this.budget) {
        const text = budgetExhausted(this.budget);
        this.emit({ kind: "nudge", text, reason: "budget" });
        this.history.push({ role: "tool", content: text });
        continue;
      }

      this.terminalCallsUsed++;
      const remaining = this.budget - this.terminalCallsUsed;
      this.emit({ kind: "tool-start", call, remaining });

      let out: Awaited<ReturnType<ToolRunner["run"]>>;
      try {
        // The profile maps back to smolbox's wire arguments here, before the
        // registry sees the call, so decodeArgs' guards all still apply. It
        // also rejects arguments outside the trained surface — inside the try,
        // because that rejection is a correctable model mistake like any other,
        // not a crash.
        const wireCall = applyProfile(this.opts.profile, call);
        out = await this.tools.run(wireCall, { maxOutput: this.opts.perCallMaxOutput });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ kind: "error", message });
        this.history.push({ role: "tool", content: `error: ${message}` });
        continue;
      }

      // The budget footer is what the model was trained to read after every
      // observation (PLAN §11.1.13). It is also the only way it learns the
      // budget is running out before it is gone.
      const rendered = `${out.text}\n[${remaining} tool-calls remaining]`;
      this.commandLog.push({
        command: String(call.args.command ?? call.args.cmd ?? ""),
        output: out.text,
        exitCode: out.exitCode,
      });
      this.emit({ kind: "tool-end", call, rendered, exitCode: out.exitCode, remaining });
      this.history.push({ role: "tool", content: rendered });
    }
    return false;
  }

  private isDuplicate(call: ParsedCall): boolean {
    const key = fingerprint(call);
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);
    return count > 1;
  }

  /**
   * Elides oldest tool output first, exactly as Conversation does — but never
   * touches history[0].
   *
   * That message is the CWE task statement, and it is the entire conditioning
   * for the run. Conversation drops from the front of history once tool outputs
   * are spent, which would eventually delete it.
   */
  private elide(): void {
    let total = this.charCount();
    if (total <= this.opts.historyBudgetChars) {
      return;
    }
    let elided = 0;
    for (const msg of this.history) {
      if (total <= this.opts.historyBudgetChars) {
        break;
      }
      if (msg.role !== "tool" || msg.content.startsWith(ELIDED_PREFIX)) {
        continue;
      }
      const before = msg.content.length;
      msg.content = `${ELIDED_PREFIX}${firstLine(msg.content)}`;
      total -= before - msg.content.length;
      elided++;
    }
    // Drop whole turns only after that, and never index 0.
    while (total > this.opts.historyBudgetChars && this.history.length > 2) {
      const dropped = this.history.splice(1, 1)[0];
      total -= dropped?.content.length ?? 0;
      elided++;
    }
    if (elided > 0) {
      this.emit({ kind: "elided", messages: elided });
    }
  }

  private charCount(): number {
    return this.messages().reduce((n, m) => n + m.content.length, 0);
  }
}

const ELIDED_PREFIX = "[older output elided] ";

function fingerprint(call: ParsedCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`;
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
