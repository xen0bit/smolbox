// A scripted stand-in for the WebGPU model.
//
// It is not a mock in the usual sense: it emits the *same raw strings* a real
// model emits, tool-call markers and all, so everything downstream — the
// dialect parser, the loop, the budgets, the UI — runs unmodified. The only
// thing it removes is the GPU, which is the one thing CI cannot have.
//
// Its scripts deliberately include the failure modes M8 actually produced (a
// Pythonic call, a malformed block, a silent command), because a loop that has
// only ever seen well-formed turns will not survive a real one (PLAN §10.8,
// risk 17).

import type { ModelErrorCode } from "./messages.ts";
import {
  ModelError,
  type GenerateRequest,
  type GenerateResult,
  type LoadOptions,
  type LoadResult,
  type ModelClient,
} from "./model-client.ts";

/** One scripted turn. `when` is matched against the last user message. */
export interface FakeTurn {
  /** Raw model output, including any tool-call markers. */
  text: string;
  /** Milliseconds to spend "generating", for testing the stop button. */
  delayMs?: number;
  /**
   * Fail this turn instead of answering it.
   *
   * The two codes the loop knows how to answer are the two things a real model
   * does that the page has to survive, and neither can be provoked without a
   * GPU: a refusal measured by the real tokenizer, and a device that dies
   * mid-prefill (PLAN §10.16). Scripting them is what lets the recovery — the
   * shrunken budget, the rebuild, the learned ceiling — run in CI.
   */
  fail?: { code: ModelErrorCode; message?: string; limitTokens?: number; promptTokens?: number };
}

export interface FakeScript {
  name: string;
  /** Substring matched case-insensitively against the triggering user message. */
  when?: string;
  /** Turns are consumed in order across the iterations of one send(). */
  turns: FakeTurn[];
}

const FALLBACK: FakeTurn = { text: "I do not have a scripted answer for that." };

export class FakeModelClient implements ModelClient {
  private queue: FakeTurn[] = [];
  // A new turn is detected by the user-message COUNT, not by the text: asking
  // the same question twice is a legitimate thing for a test to do, and keying
  // on the text would leave the second one replaying an exhausted queue.
  private lastUserCount = -1;
  private cancelled = false;

  constructor(private readonly scripts: FakeScript[]) {}

  load(_local?: boolean, _opts?: LoadOptions): Promise<LoadResult> {
    return Promise.resolve({ source: "fake", loadMs: 0 });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    this.cancelled = false;

    const userMessages = req.messages.filter((m) => m.role === "user");
    const user = userMessages.at(-1)?.content ?? "";
    if (userMessages.length !== this.lastUserCount) {
      this.lastUserCount = userMessages.length;
      this.queue = [...(this.pick(user)?.turns ?? [FALLBACK])];
    }
    const turn = this.queue.shift() ?? FALLBACK;
    if (turn.fail) {
      // Thrown before a token is emitted, as both real failures are: the
      // refusal happens before the forward pass, and a device that dies in
      // prefill dies before the first token too.
      throw new ModelError(
        turn.fail.message ?? `scripted ${turn.fail.code}`,
        turn.fail.code,
        turn.fail.limitTokens,
        turn.fail.promptTokens,
      );
    }

    // Stream in chunks so the UI's incremental path and the tool-call hold-back
    // (which must not render half a call) are genuinely exercised.
    const chunks = turn.text.match(/.{1,24}/gs) ?? [];
    const per = turn.delayMs ? Math.floor(turn.delayMs / Math.max(chunks.length, 1)) : 0;
    let emitted = "";
    for (const chunk of chunks) {
      if (this.cancelled) {
        return { text: emitted, tokens: emitted.length, ms: Date.now() - started, stopped: true };
      }
      emitted += chunk;
      req.onToken?.(chunk);
      if (per > 0) {
        await new Promise((r) => setTimeout(r, per));
      }
    }

    return { text: emitted, tokens: emitted.length, ms: Date.now() - started, stopped: false };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private pick(user: string): FakeScript | undefined {
    const hay = user.toLowerCase();
    return (
      this.scripts.find((s) => s.when && hay.includes(s.when.toLowerCase())) ??
      this.scripts.find((s) => !s.when)
    );
  }
}
