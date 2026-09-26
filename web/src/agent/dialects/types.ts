import type { ParsedTurn, StreamPreview } from "../parse.ts";

/**
 * A model family's tool-call syntax.
 *
 * `verified` is the load-bearing field. M8 implemented LFM2 against its
 * vendor's documentation, which said the model would emit JSON given the right
 * system prompt; it emitted Pythonic against five different wordings. So a
 * dialect written from documentation alone is a hypothesis, and the registry
 * says so out loud rather than letting a mis-parse look like a bug in the loop.
 *
 * A dialect becomes `verified` when a transcript has been captured from the
 * real model and checked in as a fixture — not before.
 */
export interface Dialect {
  name: string;
  label: string;
  verified: boolean;
  /** Notes shown in the UI when unverified: what is assumed and why. */
  note?: string;
  parseTurn(raw: string): ParsedTurn;
  /**
   * The live view of a partial completion, for the chat log to render mid-turn.
   *
   * Every family needs its own, because the markers that must not reach the
   * screen are exactly the ones that differ between families — a single
   * hardcoded `<|tool_call_start|>` in the page meant Qwen and Gemma streamed
   * their raw call syntax into the chat while LFM2 did not.
   */
  preview(raw: string): StreamPreview;
  /**
   * How this family's chat template wants tool results in the history.
   *
   * `raw` (the default) is what every LFM2/Qwen/Llama template does: the
   * assistant turn is replayed as the model's own text, markers and all, and a
   * tool result is a `{role: "tool", content}` message the template wraps.
   *
   * `structured` is for a template that reconstructs the call from data rather
   * than replaying text — it renders the assistant's `tool_calls` itself and
   * matches each result to one by `tool_call_id`. Gemma 4 does exactly that,
   * and fed a flat history it renders the tool message as *nothing at all*: the
   * model asks for a command and then never sees its output. Verified by
   * rendering the real template over both shapes.
   */
  historyStyle?: "raw" | "structured";
  /**
   * Whether past assistant turns carry their reasoning back into the prompt.
   *
   * Off by default: most templates drop or ignore it, and replaying it grows
   * every prompt. On for a backend whose cache cannot be rewound — Ternary
   * Bonsai 2's recurrent state — where the only way to reuse the cache is for
   * the next prompt to reproduce the last completion token for token. Its
   * template re-renders `reasoning_content` in exactly the bytes the model
   * wrote, so with this set a structured turn replays `content: prose` plus
   * `reasoning_content`, and the prefix holds (PLAN §10.28).
   */
  replayReasoning?: boolean;
}
