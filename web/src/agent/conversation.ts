// The multi-turn agent loop: generate, execute the tools the model asked for,
// feed the results back, repeat until it stops asking.
//
// Pure with respect to the model and the guest — both arrive as interfaces — so
// this whole file is testable without a GPU and without a VM. That is
// deliberate: it is the part most likely to grow subtle bugs and the part CI
// can actually reach (PLAN §10.2).

import type { ChatMessage, ModelErrorCode } from "./messages.ts";
import { ModelError, type ModelClient } from "./model-client.ts";
import type { Dialect } from "./dialects/index.ts";
import { CHARS_PER_TOKEN_ESTIMATE, type GenerationDefaults } from "./models.ts";
import { type ParsedCall, ToolCallParseError } from "./parse.ts";

export interface ToolRunner {
  /**
   * Executes one call and returns the text the model should see.
   *
   * The budget is passed rather than written into the call's arguments: a
   * template tool declares its own parameters and rejects anything else, so an
   * injected max_output would make every template call fail as an unknown
   * argument. The runner applies it to the compiled request instead.
   */
  run(
    call: ParsedCall,
    opts: { maxOutput: number },
  ): Promise<{ text: string; exitCode: number; request?: { cmd?: string; max_output?: number } }>;
}

export type AgentEvent =
  | { kind: "user"; text: string }
  | { kind: "token"; text: string }
  | {
      kind: "assistant";
      text: string;
      raw: string;
      reasoning?: string;
      /**
       * How many tool calls this turn asked for.
       *
       * The UI needs it to tell "thought, then answered nothing" from "thought,
       * then called a tool" — a reasoning model's tool-call turn has no prose at
       * all, and labelling that as a model that stopped without answering
       * describes a working turn as a failure.
       */
      toolCalls: number;
    }
  | { kind: "tool-start"; call: ParsedCall }
  | {
      kind: "tool-end";
      call: ParsedCall;
      rendered: string;
      exitCode: number;
      /** The request that actually ran, budget applied. */
      request?: { cmd?: string; max_output?: number };
    }
  | { kind: "elided"; messages: number; chars: number }
  | {
      /**
       * The loop lowered its own prompt budget after the model refused or the
       * device died at `was` characters, and is retrying the turn at `chars`.
       *
       * Emitted rather than done silently because both cases are otherwise
       * invisible: a `device-lost` retry rebuilds the whole session, which is
       * tens of seconds of apparently nothing happening, and the page wants to
       * remember the ceiling this machine actually proved (see settings.ts).
       */
      kind: "budget";
      reason: ModelErrorCode;
      was: number;
      chars: number;
    }
  | { kind: "stopped"; reason: "iteration-cap" | "cancelled" }
  | { kind: "error"; message: string };

export interface ConversationOptions {
  systemPrompt: string;
  tools: unknown[];
  /** The model family's tool-call syntax. Swapped when the model is. */
  dialect: Dialect;
  /** Hard cap on tool round-trips per user message. */
  maxIterations: number;
  /** Ceiling for Request.max_output on every call the model makes. */
  perCallMaxOutput: number;
  maxNewTokens: number;
  /**
   * Approximate ceiling for the WHOLE prompt, in characters: system turn,
   * history, and the serialised tool schema together.
   *
   * It covers the tool schema because that is prompt text too (see
   * overheadChars), and the thing it is protecting — the prefill allocation in
   * models.ts — does not care which part of the prompt the tokens came from.
   */
  promptBudgetChars: number;
  /**
   * Sampling overrides, layered over the checkpoint's registry defaults in the
   * worker. Empty means "whatever the model asks for", which is the state the
   * page is in until someone opens the settings panel and changes something.
   */
  generation: Partial<GenerationDefaults>;
}

// Budgets are counted in characters, not tokens: the tokenizer lives in the
// worker and a synchronous, deterministic number is worth more here than an
// exact one. The budget is a guardrail against a 1 MiB cat, not an accountant.
export { CHARS_PER_TOKEN_ESTIMATE } from "./models.ts";

export const DEFAULTS: Omit<ConversationOptions, "systemPrompt" | "tools" | "dialect"> = {
  generation: {},
  maxIterations: 5,
  // Three orders of magnitude below the protocol's 1 MiB default. A model that
  // needs more than this from one command should narrow the command; `truncated`
  // in the rendered result is what tells it so.
  perCallMaxOutput: 4096,
  maxNewTokens: 512,
  // A floor, not a recommendation: the page replaces this with the selected
  // checkpoint's own prefill ceiling (models.ts maxPromptChars) as soon as a
  // model is chosen. 24_000 was the old flat default and is what let LFM2.5
  // prefill itself to death, so it is deliberately no longer the largest number
  // any model runs with.
  promptBudgetChars: 16_000,
};

/**
 * How far below any budget the loop will let itself be pushed.
 *
 * A budget under this cannot hold a system prompt, a tool schema and one
 * question, so shrinking past it would trade a failing turn for an incoherent
 * one. Reaching it means the machine cannot run this checkpoint at all, which is
 * a thing to say out loud rather than to approximate.
 */
export const MIN_PROMPT_BUDGET_CHARS = 1000;

/**
 * What fraction of a prompt the device died on is safe to try again.
 *
 * The device gives no number back — only that this prompt was too much — so the
 * next attempt has to be a guess, and the only honest guess is "clearly less".
 * Half, because a step small enough to fail again wastes a whole rebuild to
 * learn nothing, and the loop only ever takes one step per turn.
 */
const DEVICE_LOSS_SHRINK = 0.5;

/**
 * How much of a measured ceiling a retry is allowed to aim at.
 *
 * The ratio it is applied to comes from one prompt, and the next one is a
 * different mix of prose, paths and command output, so it is close rather than
 * exact. Landing 5% under the ceiling costs a few hundred characters of history
 * and is the difference between a retry that works and one that spends another
 * prefill discovering the same refusal.
 */
const PROMPT_RETRY_MARGIN = 0.95;

export class Conversation {
  private history: ChatMessage[] = [];
  private cancelled = false;
  private running = false;
  // Serialising the tool schema on every elide() would be O(schema) per call
  // for a value that changes only when the registry does; the identity of the
  // array is enough to notice that.
  private toolsCache: { tools: unknown[]; chars: number } | null = null;
  // Only has to be unique within one conversation: it exists so a structured
  // template can match a result to the call it answers.
  private callSeq = 0;

  constructor(
    private opts: ConversationOptions,
    private readonly model: ModelClient,
    private readonly tools: ToolRunner,
    private readonly emit: (ev: AgentEvent) => void,
  ) {}

  /** The full history, system prompt first. Used by the UI and by tests. */
  messages(): ChatMessage[] {
    return [{ role: "system", content: this.opts.systemPrompt }, ...this.history];
  }

  configure(patch: Partial<ConversationOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  options(): ConversationOptions {
    return { ...this.opts };
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.cancelled = true;
    this.model.cancel();
  }

  async send(userText: string): Promise<void> {
    if (this.running) {
      throw new Error("conversation: a turn is already in flight");
    }
    this.running = true;
    this.cancelled = false;
    this.history.push({ role: "user", content: userText });
    this.emit({ kind: "user", text: userText });

    try {
      for (let i = 0; i < this.opts.maxIterations; i++) {
        const result = await this.generateWithRetry();
        if (!result) {
          return;
        }

        if (this.cancelled || result.stopped) {
          this.history.push({ role: "assistant", content: result.text });
          this.emit({ kind: "stopped", reason: "cancelled" });
          return;
        }

        let calls: ParsedCall[];
        let prose: string;
        let reasoning: string | undefined;
        try {
          const parsed = this.opts.dialect.parseTurn(result.text);
          calls = parsed.calls;
          prose = parsed.text;
          reasoning = parsed.reasoning;
        } catch (err) {
          // A malformed call is the model's mistake, not a crash. Tell it what
          // went wrong and let it try again — the same courtesy decodeArgs
          // extends for unknown fields.
          const message = err instanceof ToolCallParseError ? err.message : String(err);
          this.emit({ kind: "error", message });
          this.history.push({ role: "assistant", content: result.text });
          this.history.push({ role: "tool", content: `error: ${message}` });
          continue;
        }

        if (calls.length === 0) {
          this.history.push({ role: "assistant", content: result.text });
          this.emit({ kind: "assistant", text: prose, raw: result.text, reasoning, toolCalls: 0 });
          return;
        }

        // A structured dialect's template rebuilds the call from data rather
        // than replaying the model's text, so the assistant turn carries the
        // parsed calls and each result names the one it answers. See
        // Dialect.historyStyle: fed a flat history, Gemma 4 renders the tool
        // result as nothing at all.
        const structured = this.opts.dialect.historyStyle === "structured";
        const ids = calls.map((_, n) => `call_${++this.callSeq}_${n}`);
        this.history.push(
          structured
            ? {
                role: "assistant",
                content: prose,
                tool_calls: calls.map((c, n) => ({
                  id: ids[n]!,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : { role: "assistant", content: result.text },
        );
        // Reasoning alone is worth an event: a reasoning model that thinks for
        // a page and then calls a tool would otherwise leave the log with
        // nothing at all between the question and the command.
        if (prose || reasoning) {
          this.emit({ kind: "assistant", text: prose, raw: result.text, reasoning, toolCalls: calls.length });
        }

        for (const [n, call] of calls.entries()) {
          if (this.cancelled) {
            this.emit({ kind: "stopped", reason: "cancelled" });
            return;
          }
          const answers = structured ? { tool_call_id: ids[n]! } : {};
          this.emit({ kind: "tool-start", call });
          let out: Awaited<ReturnType<ToolRunner["run"]>>;
          try {
            out = await this.tools.run(call, { maxOutput: this.opts.perCallMaxOutput });
          } catch (err) {
            // A call the registry refuses — an unknown tool, a bad argument — is
            // the model's mistake and correctable, exactly like a parse failure.
            const message = err instanceof Error ? err.message : String(err);
            this.emit({ kind: "error", message });
            this.history.push({ role: "tool", content: `error: ${message}`, ...answers });
            continue;
          }
          this.emit({
            kind: "tool-end",
            call,
            rendered: out.text,
            exitCode: out.exitCode,
            request: out.request,
          });
          this.history.push({ role: "tool", content: out.text, ...answers });
        }
      }

      this.emit({ kind: "stopped", reason: "iteration-cap" });
    } finally {
      this.running = false;
    }
  }

  /**
   * One generation, elided into budget first, retried once per failure the loop
   * knows how to answer. Returns undefined when the turn is over — the error is
   * already on the chat log by then.
   *
   * A failed generate used to propagate straight out of send(), which left the
   * user turn in the history with no reply and no visible reason, so the next
   * message rebuilt the same oversized prompt and failed the same way: the chat
   * was dead with nothing on screen to say so. Every failure now ends the turn
   * as a visible event instead.
   *
   * Two codes are answerable, and each gets exactly one retry per generation:
   *
   *  - `prompt-too-long`: refused before the model ran, so nothing is damaged.
   *    The worker measured the prompt with the real tokenizer and reported both
   *    the ceiling and the count, so the retry is informed rather than hopeful.
   *  - `device-lost`: the run took the WebGPU device with it. The worker has
   *    already dropped the session and rebuilds it on the next request, so the
   *    retry pays for a reload — tens of seconds — and is worth it, because the
   *    alternative is a dead turn the user has to notice, resend, and watch fail
   *    at the same size.
   *
   * Anything else ends the turn.
   */
  private async generateWithRetry(): Promise<Awaited<ReturnType<ModelClient["generate"]>> | undefined> {
    const retried = new Set<ModelErrorCode>();
    for (;;) {
      this.elide();
      // What this attempt is actually about to send, which is the only honest
      // input to shrinking the budget: promptBudgetChars is a ceiling the prompt
      // may be well under, and halving a ceiling nothing was touching changes
      // nothing at all.
      const sent = this.charCount();
      try {
        return await this.model.generate({
          messages: this.messages(),
          tools: this.opts.tools,
          maxNewTokens: this.opts.maxNewTokens,
          generation: this.opts.generation,
          onToken: (t) => this.emit({ kind: "token", text: t }),
        });
      } catch (err) {
        const code = err instanceof ModelError ? err.code : undefined;
        if (code && !retried.has(code) && (code === "prompt-too-long" || code === "device-lost")) {
          // Stop means stop. A device-lost retry is a model reload and another
          // full generation — a minute of work — and starting it because the
          // failure happened to arrive after the stop button reads as a page
          // that ignored the button.
          if (this.cancelled) {
            this.emit({ kind: "stopped", reason: "cancelled" });
            return undefined;
          }
          retried.add(code);
          this.shrinkBudget(code, err as ModelError, sent);
          continue;
        }
        this.emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    }
  }

  /**
   * Lowers the prompt budget after a prompt this size did not work.
   *
   * The invariant is the whole point: the new budget is **always** below what
   * was just sent. Without that, the retry re-sends an identical prompt — which
   * is what happened on a refusal at 3198 tokens against a 3145-token ceiling.
   * The ceiling converted to 12 580 characters at the registry's estimate of
   * 4 chars per token, the ~12 300-character prompt was already under it,
   * `elide()` found nothing to do, and the second attempt failed exactly like
   * the first. The estimate was the error: that conversation ran at 3.85.
   *
   * So the token ceiling is converted with the ratio this prompt actually
   * measured, when the worker reported both halves of it, and the result is
   * clamped below the failing size either way.
   */
  private shrinkBudget(code: ModelErrorCode, err: ModelError, sent: number): void {
    const chars = Math.max(MIN_PROMPT_BUDGET_CHARS, Math.min(this.budgetTarget(code, err, sent), sent - 1));
    this.opts = { ...this.opts, promptBudgetChars: chars };
    this.emit({ kind: "budget", reason: code, was: sent, chars });
  }

  private budgetTarget(code: ModelErrorCode, err: ModelError, sent: number): number {
    const limit = err.limitTokens;
    // A device loss reports no ceiling — the GPU only ever says "not this much"
    // — so the size that killed it is the only number there is.
    if (code !== "prompt-too-long" || !limit || limit <= 0) {
      return Math.floor(sent * DEVICE_LOSS_SHRINK);
    }
    const measured = err.promptTokens;
    if (measured && measured > 0) {
      // The ratio this conversation actually ran at, less a margin, because the
      // retry has to land under the ceiling rather than on it.
      return Math.floor(limit * (sent / measured) * PROMPT_RETRY_MARGIN);
    }
    // No measurement: fall back to the registry's estimate, and charge the tool
    // schema twice — once as prompt text the ceiling already covers, once as
    // margin against the estimate being generous, which is the direction it errs.
    return limit * CHARS_PER_TOKEN_ESTIMATE - this.overheadChars();
  }

  // Oldest tool outputs go first, and only their bodies: the command and its
  // exit code stay, because "I ran this and it worked" keeps its value long
  // after the bytes stop being useful. Only once no tool output is left does
  // this start dropping whole turns.
  private elide(): void {
    let total = this.charCount();
    if (total <= this.opts.promptBudgetChars) {
      return;
    }

    let elided = 0;
    const freed = () => this.opts.promptBudgetChars;

    for (const msg of this.history) {
      if (total <= freed()) {
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

    while (total > freed() && this.history.length > 2) {
      const dropped = this.history.shift();
      total -= dropped?.content.length ?? 0;
      elided++;
    }

    if (elided > 0) {
      this.emit({ kind: "elided", messages: elided, chars: this.charCount() });
    }
  }

  private charCount(): number {
    return this.overheadChars() + this.messages().reduce((n, m) => n + m.content.length, 0);
  }

  /**
   * Prompt text the messages do not contain.
   *
   * The chat template serialises the tool schema into the system turn, so it is
   * on the wire every single turn and none of it was being counted:
   * run_terminal_command alone is ~2.3 KB, and a user who enables several
   * template tools can add ten times that to a prompt the budget still believes
   * is empty. Counting it is what makes promptBudgetChars mean "the prompt",
   * which is what the prefill ceiling in models.ts is actually about.
   */
  private overheadChars(): number {
    if (this.toolsCache?.tools !== this.opts.tools) {
      let chars = 0;
      try {
        chars = JSON.stringify(this.opts.tools)?.length ?? 0;
      } catch {
        // A tool definition that will not serialise cannot be prompted with
        // either; let the model client be the one to complain about it.
      }
      this.toolsCache = { tools: this.opts.tools, chars };
    }
    return this.toolsCache.chars;
  }
}

const ELIDED_PREFIX = "[older output elided] ";

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
