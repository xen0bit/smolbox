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
