// The message contract between the page and the model worker. Shared by both
// ends so the pair cannot drift, in the same spirit as protocol.ts.

/** A chat message in the shape the LFM2 chat template consumes. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Page -> worker. */
export type ModelRequest =
  | { type: "load"; local: boolean }
  | { type: "generate"; messages: ChatMessage[]; tools: unknown[]; maxNewTokens?: number };

/** Worker -> page. */
export type ModelResponse =
  | { type: "log"; message: string }
  | { type: "progress"; file: string; pct: number }
  | { type: "ready"; source: "local" | "hub"; loadMs: number }
  | { type: "generated"; text: string; prompt: string; tokens: number; ms: number }
  | { type: "error"; message: string };
