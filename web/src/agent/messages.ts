// The message contract between the page and the model worker. Shared by both
// ends so the pair cannot drift, in the same spirit as protocol.ts.

/** One call, in the OpenAI shape chat templates read structured history from. */
export interface ToolCallRecord {
  id: string;
  type: "function";
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * A chat message, in the shape a chat template consumes.
 *
 * `content` alone is enough for every template that replays the assistant's own
 * text — LFM2, Qwen, Llama, Granite. The two optional fields exist for templates
 * that rebuild the call from data instead: Gemma 4 renders the assistant's
 * `tool_calls` itself and matches each result to one by `tool_call_id`, and
 * given a history without them it renders the tool result as nothing at all.
 *
 * They are only populated for a dialect whose `historyStyle` is "structured",
 * because a template that reads both would render the call twice — LFM2.5's
 * does exactly that.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
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
      /**
       * Sampling overrides for this turn, layered over the checkpoint's own
       * defaults in the registry. Only the keys the user actually changed are
       * sent, so an untouched setting keeps following the model it belongs to.
       */
      generation?: Partial<import("./models.ts").GenerationDefaults>;
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
  | {
      type: "error";
      message: string;
      code?: ModelErrorCode;
      /** For `prompt-too-long`: the ceiling the worker enforced. */
      limitTokens?: number;
      /**
       * For `prompt-too-long`: what the prompt actually measured.
       *
       * Both numbers travel because the caller counts characters and the worker
       * counts tokens, and the conversion between them is the thing that was
       * wrong. Given the pair, the loop can divide the prompt it sent by the
       * tokens it turned into and get this checkpoint's real ratio for this
       * conversation instead of the registry's estimate of 4 (models.ts
       * CHARS_PER_TOKEN_ESTIMATE). Measured 3.85 for an LFM2.5 chat full of
       * paths and command output, which is enough to make a refused prompt look
       * as though it were already inside the budget it had just been refused
       * for — so the retry re-sent it unchanged and was refused again.
       */
      promptTokens?: number;
    };

/**
 * Why a model request failed, when the page can do something about it.
 *
 * Untyped failures stay untyped — most of them are one-offs a caller cannot
 * act on. These two exist because the loop reacts differently to each:
 *
 *  - `prompt-too-long`: refused before the model ran, so nothing is damaged.
 *    The loop elides to the reported ceiling and tries the turn again.
 *  - `device-lost`: the WebGPU device errored mid-run. Everything afterwards
 *    fails with "invalid due to a previous error" until the session is rebuilt,
 *    so the worker drops the model and reloads it on the next request.
 */
export type ModelErrorCode = "prompt-too-long" | "device-lost";

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
