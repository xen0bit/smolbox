// The seam between the conversation loop and whatever is generating text.
//
// This interface exists so the loop can be driven by a scripted fake in CI.
// Nothing that needs a GPU can run on a runner (PLAN §2.11.24), so the loop,
// the budgets, the history policy and the UI would otherwise have no automated
// coverage at all — the same reasoning that produced M7's mock caller, one
// level up.

import type { ChatMessage, ModelErrorCode, ModelRequest, ModelResponse } from "./messages.ts";
import type { GenerationDefaults } from "./models.ts";

/**
 * A model failure the caller can act on.
 *
 * An Error subclass rather than a plain message because it crosses the worker
 * boundary as data and has to become a throwable again on this side without the
 * loop having to pattern-match on error strings.
 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly code?: ModelErrorCode,
    /** For `prompt-too-long`: the ceiling the worker enforced. */
    readonly limitTokens?: number,
    /** For `prompt-too-long`: what the prompt measured. See messages.ts. */
    readonly promptTokens?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface GenerateRequest {
  messages: ChatMessage[];
  tools: unknown[];
  maxNewTokens?: number;
  /** Sampling overrides for this turn. See ModelRequest in messages.ts. */
  generation?: Partial<GenerationDefaults>;
  /** Called with each decoded chunk as it is produced. */
  onToken?(text: string): void;
}

export interface GenerateResult {
  text: string;
  tokens: number;
  ms: number;
  stopped: boolean;
  /**
   * What the prompt measured, and the ceiling it was measured against.
   *
   * Optional because the scripted fake has no tokenizer and therefore no honest
   * answer, and a fake that invented one would be calibrating the loop against
   * fiction. Absent means "no measurement this turn", which the loop treats as
   * "keep the budget you have".
   */
  promptTokens?: number;
  limitTokens?: number;
}

export interface LoadResult {
  source: string;
  loadMs: number;
}

/** Which checkpoint to load, and at which quantization. */
export interface LoadOptions {
  modelKey?: string;
  dtype?: string;
}

export interface ModelClient {
  load(local?: boolean, opts?: LoadOptions): Promise<LoadResult>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Best-effort interrupt of an in-flight generate. Safe to call when idle. */
  cancel(): void;
}

/** What a Worker needs to look like for WorkerModelClient to drive it. */
export interface WorkerLike {
  postMessage(msg: ModelRequest): void;
  addEventListener(type: "message", fn: (ev: { data: ModelResponse }) => void): void;
  /** Present on a real Worker; absent on the fakes CI drives this with. */
  terminate?(): void;
}

/**
 * How many device losses in a row before the worker itself is replaced.
 *
 * One is not enough and is the right call: an allocation that failed did not
 * take the device away, and disposing the sessions gives the memory back, so the
 * worker's own reload is the cheap fix and it works (PLAN §10.10 part 4). Two in
 * a row means it did not work, and the reason §10.16 recorded as "not fixed" is
 * the only one left — the rebuild runs on the same onnxruntime module and
 * therefore the same WebGPU device, so if the browser genuinely *lost* that
 * device, reloading onto it will keep succeeding and keep failing. Only a new
 * worker gets a new device.
 *
 * The cost is real: a respawn re-reads the weights (from IndexedDB, so seconds
 * rather than a download) and starts the session over. Paying it on the first
 * failure would slow down the common case to fix the rare one.
 */
const DEVICE_LOSSES_BEFORE_RESPAWN = 2;

/** Drives the real transformers.js worker. */
export class WorkerModelClient implements ModelClient {
  private seq = 0;
  private pendingLoad: { resolve(r: LoadResult): void; reject(e: Error): void } | null = null;
  private pendingGen:
    | { id: number; resolve(r: GenerateResult): void; reject(e: Error): void; onToken?(t: string): void }
    | null = null;
  private worker: WorkerLike;
  // Reset by any generation that completes. A count that only ever went up
  // would respawn on the second loss of a long, otherwise healthy session.
  private deviceLosses = 0;
  // What to say to a worker that has just been born. Remembered rather than
  // asked for again, because the page has moved on by the time this matters.
  private lastLoad: { local: boolean; opts: LoadOptions } | null = null;

  constructor(
    worker: WorkerLike,
    private readonly onLog?: (line: string) => void,
    private readonly onProgress?: (file: string, pct: number) => void,
    /**
     * How to build a replacement worker. Absent means never respawn — which is
     * what the tests and the fakes want, and what a caller who did not opt in
     * gets.
     */
    private readonly spawn?: () => WorkerLike,
  ) {
    this.worker = worker;
    this.listen();
  }

  private listen(): void {
    this.worker.addEventListener("message", (ev) => this.receive(ev.data));
  }

  /**
   * Replaces the worker, and with it the WebGPU device.
   *
   * Deliberately does not resolve anything: the caller's request has already
   * failed and is about to be rejected with the real reason. This only makes the
   * *next* request land somewhere that can serve it.
   */
  private respawn(): void {
    if (!this.spawn) {
      return;
    }
    this.onLog?.(
      `two device losses in a row — replacing the model worker to get a new WebGPU device ` +
        `(the in-process reload runs on the same one)`,
    );
    try {
      this.worker.terminate?.();
    } catch {
      // Terminating a worker that has already gone is not worth reporting.
    }
    this.deviceLosses = 0;
    this.worker = this.spawn();
    this.listen();
    if (this.lastLoad) {
      // Fire and forget: nothing is awaiting a load, and a `ready` arriving with
      // no pendingLoad is a no-op by construction.
      this.worker.postMessage({
        type: "load",
        local: this.lastLoad.local,
        modelKey: this.lastLoad.opts.modelKey,
        dtype: this.lastLoad.opts.dtype,
      });
    }
  }

  private receive(msg: ModelResponse): void {
    switch (msg.type) {
      case "log":
        this.onLog?.(msg.message);
        return;
      case "progress":
        this.onProgress?.(msg.file, msg.pct);
        return;
      case "ready":
        this.pendingLoad?.resolve({ source: msg.source, loadMs: msg.loadMs });
        this.pendingLoad = null;
        return;
      case "token":
        if (this.pendingGen?.id === msg.id) {
          this.pendingGen.onToken?.(msg.text);
        }
        return;
      case "generated":
        if (this.pendingGen?.id === msg.id) {
          // A turn that finished is proof the device is alive, whatever
          // happened before it.
          this.deviceLosses = 0;
          this.pendingGen.resolve({
            text: msg.text,
            tokens: msg.tokens,
            ms: msg.ms,
            stopped: msg.stopped,
            promptTokens: msg.promptTokens,
            limitTokens: msg.limitTokens,
          });
          this.pendingGen = null;
        }
        return;
      case "error": {
        // The worker does not say which request failed, so fail whichever is
        // outstanding rather than leaving a promise pending forever.
        const err = new ModelError(msg.message, msg.code, msg.limitTokens, msg.promptTokens);
        if (msg.code === "device-lost" && ++this.deviceLosses >= DEVICE_LOSSES_BEFORE_RESPAWN) {
          this.respawn();
        }
        this.pendingGen?.reject(err);
        this.pendingLoad?.reject(err);
        this.pendingGen = null;
        this.pendingLoad = null;
      }
    }
  }

  load(local = true, opts: LoadOptions = {}): Promise<LoadResult> {
    this.lastLoad = { local, opts };
    return new Promise((resolve, reject) => {
      this.pendingLoad = { resolve, reject };
      this.worker.postMessage({ type: "load", local, modelKey: opts.modelKey, dtype: opts.dtype });
    });
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pendingGen = { id, resolve, reject, onToken: req.onToken };
      this.worker.postMessage({
        type: "generate",
        id,
        messages: req.messages,
        tools: req.tools,
        maxNewTokens: req.maxNewTokens,
        generation: req.generation,
      });
    });
  }

  cancel(): void {
    this.worker.postMessage({ type: "cancel" });
  }
}
