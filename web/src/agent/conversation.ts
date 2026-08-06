// The multi-turn agent loop: generate, execute the tools the model asked for,
// feed the results back, repeat until it stops asking.
//
// Pure with respect to the model and the guest — both arrive as interfaces — so
// this whole file is testable without a GPU and without a VM. That is
// deliberate: it is the part most likely to grow subtle bugs and the part CI
// can actually reach (PLAN §10.2).

import type { ChatMessage } from "./messages.ts";
import { ModelError, type ModelClient } from "./model-client.ts";
import type { Dialect } from "./dialects/index.ts";
import { CHARS_PER_TOKEN_ESTIMATE } from "./models.ts";
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
  | { kind: "assistant"; text: string; raw: string }
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
}

// Budgets are counted in characters, not tokens: the tokenizer lives in the
// worker and a synchronous, deterministic number is worth more here than an
// exact one. The budget is a guardrail against a 1 MiB cat, not an accountant.
export { CHARS_PER_TOKEN_ESTIMATE } from "./models.ts";

export const DEFAULTS: Omit<ConversationOptions, "systemPrompt" | "tools" | "dialect"> = {
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

export class Conversation {
  private history: ChatMessage[] = [];
  private cancelled = false;
  private running = false;
  // Serialising the tool schema on every elide() would be O(schema) per call
  // for a value that changes only when the registry does; the identity of the
  // array is enough to notice that.
  private toolsCache: { tools: unknown[]; chars: number } | null = null;

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
        try {
          const parsed = this.opts.dialect.parseTurn(result.text);
          calls = parsed.calls;
          prose = parsed.text;
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
          this.emit({ kind: "assistant", text: prose, raw: result.text });
          return;
        }

        this.history.push({ role: "assistant", content: result.text });
        if (prose) {
          this.emit({ kind: "assistant", text: prose, raw: result.text });
        }

        for (const call of calls) {
          if (this.cancelled) {
            this.emit({ kind: "stopped", reason: "cancelled" });
            return;
          }
          this.emit({ kind: "tool-start", call });
          let out: Awaited<ReturnType<ToolRunner["run"]>>;
          try {
            out = await this.tools.run(call, { maxOutput: this.opts.perCallMaxOutput });
          } catch (err) {
            // A call the registry refuses — an unknown tool, a bad argument — is
            // the model's mistake and correctable, exactly like a parse failure.
            const message = err instanceof Error ? err.message : String(err);
            this.emit({ kind: "error", message });
            this.history.push({ role: "tool", content: `error: ${message}` });
            continue;
          }
          this.emit({
            kind: "tool-end",
            call,
            rendered: out.text,
            exitCode: out.exitCode,
            request: out.request,
          });
          this.history.push({ role: "tool", content: out.text });
        }
      }

      this.emit({ kind: "stopped", reason: "iteration-cap" });
    } finally {
      this.running = false;
    }
  }

  /**
   * One generation, elided into budget first, retried once if that was not
   * enough. Returns undefined when the turn is over — the error is already on
   * the chat log by then.
   *
   * A failed generate used to propagate straight out of send(), which left the
   * user turn in the history with no reply and no visible reason, so the next
   * message rebuilt the same oversized prompt and failed the same way: the chat
   * was dead with nothing on screen to say so. Every failure now ends the turn
   * as a visible event instead.
   *
   * The retry is only for `prompt-too-long`, which the worker raises *before*
   * running the model — nothing is damaged, and the worker tells us the real
   * ceiling it measured with the real tokenizer, so the second attempt is
   * informed rather than hopeful. Anything else ends the turn.
   */
  private async generateWithRetry(): Promise<Awaited<ReturnType<ModelClient["generate"]>> | undefined> {
    for (let attempt = 0; ; attempt++) {
      this.elide();
      try {
        return await this.model.generate({
          messages: this.messages(),
          tools: this.opts.tools,
          maxNewTokens: this.opts.maxNewTokens,
          onToken: (t) => this.emit({ kind: "token", text: t }),
        });
      } catch (err) {
        const retryable = err instanceof ModelError && err.code === "prompt-too-long" && attempt === 0;
        if (retryable) {
          const limit = (err as ModelError).limitTokens;
          if (limit && limit > 0) {
            this.opts = {
              ...this.opts,
              promptBudgetChars: Math.max(1000, limit * CHARS_PER_TOKEN_ESTIMATE - this.overheadChars()),
            };
          } else {
            this.opts = { ...this.opts, promptBudgetChars: Math.max(1000, this.opts.promptBudgetChars >> 1) };
          }
          continue;
        }
        this.emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    }
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
