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
}

/** Drives the real transformers.js worker. */
export class WorkerModelClient implements ModelClient {
  private seq = 0;
  private pendingLoad: { resolve(r: LoadResult): void; reject(e: Error): void } | null = null;
  private pendingGen:
    | { id: number; resolve(r: GenerateResult): void; reject(e: Error): void; onToken?(t: string): void }
    | null = null;

  constructor(
    private readonly worker: WorkerLike,
    private readonly onLog?: (line: string) => void,
    private readonly onProgress?: (file: string, pct: number) => void,
  ) {
    worker.addEventListener("message", (ev) => this.receive(ev.data));
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
          this.pendingGen.resolve({ text: msg.text, tokens: msg.tokens, ms: msg.ms, stopped: msg.stopped });
          this.pendingGen = null;
        }
        return;
      case "error": {
        // The worker does not say which request failed, so fail whichever is
        // outstanding rather than leaving a promise pending forever.
        const err = new ModelError(msg.message, msg.code, msg.limitTokens, msg.promptTokens);
        this.pendingGen?.reject(err);
        this.pendingLoad?.reject(err);
        this.pendingGen = null;
        this.pendingLoad = null;
      }
    }
  }

  load(local = true, opts: LoadOptions = {}): Promise<LoadResult> {
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
