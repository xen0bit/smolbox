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

import type { GenerateRequest, GenerateResult, LoadOptions, LoadResult, ModelClient } from "./model-client.ts";

/** One scripted turn. `when` is matched against the last user message. */
export interface FakeTurn {
  /** Raw model output, including any tool-call markers. */
  text: string;
  /** Milliseconds to spend "generating", for testing the stop button. */
  delayMs?: number;
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
  private lastUser = "";
  private cancelled = false;

  constructor(private readonly scripts: FakeScript[]) {}

  load(_local?: boolean, _opts?: LoadOptions): Promise<LoadResult> {
    return Promise.resolve({ source: "fake", loadMs: 0 });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    this.cancelled = false;

    const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (user !== this.lastUser) {
      this.lastUser = user;
      this.queue = [...(this.pick(user)?.turns ?? [FALLBACK])];
    }
    const turn = this.queue.shift() ?? FALLBACK;

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
