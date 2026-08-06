// The message contract between the page and the model worker. Shared by both
// ends so the pair cannot drift, in the same spirit as protocol.ts.

/** A chat message in the shape the LFM2 chat template consumes. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Page -> worker. */
export type ModelRequest =
  | { type: "load"; local: boolean; modelKey?: string; dtype?: string }
  | {
      type: "generate";
      id: number;
      messages: ChatMessage[];
      tools: unknown[];
      maxNewTokens?: number;
    }
  // Cancel is fire-and-forget and deliberately carries no id: there is only
  // ever one generation in flight, and a cancel that arrives after it finished
  // must be harmless rather than an error.
  | { type: "cancel" };

/** Worker -> page. */
export type ModelResponse =
  | { type: "log"; message: string }
  | { type: "progress"; file: string; pct: number }
  | { type: "ready"; source: "local" | "hub"; loadMs: number; modelKey: string; dtype: string }
  | { type: "token"; id: number; text: string }
  | {
      type: "generated";
      id: number;
      text: string;
      prompt: string;
      tokens: number;
      ms: number;
      /** True when generation was cut short by cancel() rather than by EOS. */
      stopped: boolean;
    }
  | { type: "error"; message: string };

/**
 * Renders a thrown value for the `error` message above, message first.
 *
 * `err.stack` alone is not enough, and which half goes missing depends on the
 * engine: V8 starts the stack with "Error: <message>", SpiderMonkey does not.
 * So on Firefox a bare stack reaches the page as five anonymous frames with no
 * statement of what went wrong — which is exactly how a missing chat template
 * presented before this existed.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (!err.stack) {
    return err.message;
  }
  return err.stack.includes(err.message) ? err.stack : `${err.message}\n${err.stack}`;
}
