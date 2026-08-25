// What the VM is doing, in a form a page can render.
//
// The worker's life before the guest answers has three steps — fetch ~150 MB,
// instantiate it, start it — and both pages used to infer which one they were
// in by comparing the worker's log line against the string "fetching wasm".
// That is not a state machine, it is a substring, and it had two consequences
// on the deployment:
//
//   The VM page's header froze on "booting the VM". That message is posted
//   just *before* wasi.start(), and nothing after it ever set the status again,
//   so the last thing a working VM said about itself was that it was still
//   starting. (It used to say "ready (agent v…)" from the run button's own
//   handler; the button became a terminal and the line went with it.)
//
//   The agent page's VM chip froze on "downloading", because the only thing
//   that moved it off was bootVm(), and the only caller of bootVm() is the
//   start button. The download had finished minutes earlier.
//
// So the worker names its phase, the pages map it, and nobody parses prose. The
// mapping is pure and lives here because neither page has CI — the same reason
// status.ts keeps chipText separable from the DOM.

/**
 * Where the VM is. The first three are the worker's own steps, tagged onto the
 * log message it already posts; the last three arrive as the ready/exit/error
 * messages Session is listening for anyway.
 */
export type VmPhase =
  | "fetching"
  | "instantiating"
  | "booting"
  | "ready"
  | "exited"
  | "failed";

/** The phases the worker tags its log messages with, for a narrowing check. */
const WORKER_PHASES = new Set<string>(["fetching", "instantiating", "booting"]);

/** True when `value` is a phase the worker put on a log message. */
export function isWorkerPhase(value: unknown): value is VmPhase {
  return typeof value === "string" && WORKER_PHASES.has(value);
}

/** Whether the download bar still has a job at this phase. */
export function isDownloading(phase: VmPhase): boolean {
  return phase === "fetching";
}

export interface VmChip {
  state: "idle" | "loading" | "ready" | "error";
  detail: string;
}

/**
 * The agent page's VM chip: a state for the dot's colour and a word for the
 * text. `note` carries the one detail a phase cannot know by itself — the
 * agent's version on ready, the exit code or the message on the two failures.
 */
export function vmChip(phase: VmPhase, note?: string): VmChip {
  switch (phase) {
    case "fetching":
      return { state: "loading", detail: "downloading" };
    case "instantiating":
      return { state: "loading", detail: "instantiating" };
    case "booting":
      return { state: "loading", detail: "booting" };
    case "ready":
      return { state: "ready", detail: note ?? "ready" };
    case "exited":
      return { state: "error", detail: note ? `exited (${note})` : "exited" };
    case "failed":
      return { state: "error", detail: "failed" };
  }
}

/**
 * The VM page's header, which is one span rather than three chips and so has to
 * say the whole thing in a sentence.
 *
 * The download percentage is not here: it changes a hundred times and is
 * written straight to the span by the progress handler, which knows the byte
 * counts this function does not. What this returns is the line before the first
 * progress message and the line after the last one.
 */
export function vmStatusLine(phase: VmPhase, note?: string): string {
  switch (phase) {
    case "fetching":
      return "loading smolbox.wasm…";
    case "instantiating":
      return "instantiating smolbox.wasm…";
    case "booting":
      return "booting the VM…";
    case "ready":
      return note ? `ready (${note})` : "ready";
    case "exited":
      return note ? `the VM exited (${note})` : "the VM exited";
    case "failed":
      return note ? `error: ${note}` : "error";
  }
}
