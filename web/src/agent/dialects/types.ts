import type { ParsedTurn } from "../parse.ts";

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
}
