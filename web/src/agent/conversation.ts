// The multi-turn agent loop: generate, execute the tools the model asked for,
// feed the results back, repeat until it stops asking.
//
// Pure with respect to the model and the guest — both arrive as interfaces — so
// this whole file is testable without a GPU and without a VM. That is
// deliberate: it is the part most likely to grow subtle bugs and the part CI
// can actually reach (PLAN §10.2).

import type { ChatMessage } from "./messages.ts";
import type { ModelClient } from "./model-client.ts";
import { type ParsedCall, ToolCallParseError, parseTurn } from "./parse.ts";

export interface ToolRunner {
  /** Executes one call and returns the text the model should see. */
  run(call: ParsedCall): Promise<{ text: string; exitCode: number }>;
}

export type AgentEvent =
  | { kind: "user"; text: string }
  | { kind: "token"; text: string }
  | { kind: "assistant"; text: string; raw: string }
  | { kind: "tool-start"; call: ParsedCall }
  | { kind: "tool-end"; call: ParsedCall; rendered: string; exitCode: number }
  | { kind: "elided"; messages: number; chars: number }
  | { kind: "stopped"; reason: "iteration-cap" | "cancelled" }
  | { kind: "error"; message: string };

export interface ConversationOptions {
  systemPrompt: string;
  tools: unknown[];
  /** Hard cap on tool round-trips per user message. */
  maxIterations: number;
  /** Ceiling for Request.max_output on every call the model makes. */
  perCallMaxOutput: number;
  maxNewTokens: number;
  /** Approximate history budget, in characters. See noteOnChars below. */
  historyBudgetChars: number;
}

// Budgets are counted in characters, not tokens: the tokenizer lives in the
// worker and a synchronous, deterministic number is worth more here than an
// exact one. Roughly 4 chars/token for this vocabulary — the budget is a
// guardrail against a 1 MiB cat, not an accountant.
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export const DEFAULTS: Omit<ConversationOptions, "systemPrompt" | "tools"> = {
  maxIterations: 5,
  // Three orders of magnitude below the protocol's 1 MiB default. A model that
  // needs more than this from one command should narrow the command; `truncated`
  // in the rendered result is what tells it so.
  perCallMaxOutput: 4096,
  maxNewTokens: 512,
  historyBudgetChars: 24_000,
};

export class Conversation {
  private history: ChatMessage[] = [];
  private cancelled = false;
  private running = false;

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
        this.elide();

        const result = await this.model.generate({
          messages: this.messages(),
          tools: this.opts.tools,
          maxNewTokens: this.opts.maxNewTokens,
          onToken: (t) => this.emit({ kind: "token", text: t }),
        });

        if (this.cancelled || result.stopped) {
          this.history.push({ role: "assistant", content: result.text });
          this.emit({ kind: "stopped", reason: "cancelled" });
          return;
        }

        let calls: ParsedCall[];
        let prose: string;
        try {
          const parsed = parseTurn(result.text);
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
          const budgeted = this.applyCallBudget(call);
          const out = await this.tools.run(budgeted);
          this.emit({ kind: "tool-end", call: budgeted, rendered: out.text, exitCode: out.exitCode });
          this.history.push({ role: "tool", content: out.text });
        }
      }

      this.emit({ kind: "stopped", reason: "iteration-cap" });
    } finally {
      this.running = false;
    }
  }

  // The protocol already has the knob and Render already reports `truncated`,
  // so the budget is applied by setting max_output rather than by trimming the
  // text afterwards — two truncation layers would show the model two different
  // stories about the same command.
  private applyCallBudget(call: ParsedCall): ParsedCall {
    const requested = call.args.max_output;
    const cap = this.opts.perCallMaxOutput;
    if (typeof requested === "number" && requested > 0 && requested <= cap) {
      return call;
    }
    return { ...call, args: { ...call.args, max_output: cap } };
  }

  // Oldest tool outputs go first, and only their bodies: the command and its
  // exit code stay, because "I ran this and it worked" keeps its value long
  // after the bytes stop being useful. Only once no tool output is left does
  // this start dropping whole turns.
  private elide(): void {
    let total = this.charCount();
    if (total <= this.opts.historyBudgetChars) {
      return;
    }

    let elided = 0;
    const freed = () => this.opts.historyBudgetChars;

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
    return this.messages().reduce((n, m) => n + m.content.length, 0);
  }
}

const ELIDED_PREFIX = "[older output elided] ";

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
