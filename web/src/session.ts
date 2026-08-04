// TS twin of internal/vm.Session: the main-thread client that drives the
// worker over the shared-memory stdin channel and the worker->page message
// channel. Requests are serialized (a new batch may only overwrite the SAB slot
// after the guest drained the previous one, which the protocol guarantees by
// answering a request only once its frame is fully read).

import type { Caps, Request, Response } from "./protocol.ts";
import { OpShutdown, encodeRequest } from "./protocol.ts";
import { StdinChannel } from "./stdio.ts";

export interface MessageSink {
  onmessage: ((ev: MessageEvent) => void) | null;
}

interface ReadyMessage {
  type: "ready";
  caps: Caps;
}

interface ResponseMessage {
  type: "response";
  resp: Response;
}

interface ChannelMessage {
  type: "channel";
  sab: SharedArrayBuffer;
}

interface ExitMessage {
  type: "exit";
  code: number;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = ReadyMessage | ResponseMessage | ChannelMessage | ExitMessage | ErrorMessage;

export const DefaultBootTimeout = 180_000;
export const DefaultExecTimeout = 120_000;

export class Session {
  private worker: MessageSink;
  private caps: Caps | null = null;
  private channel: StdinChannel | null = null;
  private closed = false;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { resolve(r: Response): void; reject(e: Error): void }>();
  private bootWaiter: { resolve(c: Caps): void; reject(e: Error): void } | null = null;
  private closeWaiter: { resolve(): void; reject(e: Error): void } | null = null;
  private exitCode: number | null = null;

  constructor(worker: MessageSink) {
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as WorkerMessage);
  }

  Caps(): Caps | null {
    return this.caps;
  }

  // Boot resolves when the guest agent's ready banner arrives. The worker
  // starts booting on its own; exec must not be called before this resolves.
  boot(timeoutMs = DefaultBootTimeout): Promise<Caps> {
    if (this.caps) {
      return Promise.resolve(this.caps);
    }
    if (this.exitCode !== null) {
      return Promise.reject(new Error(`vm: session exited before ready (code ${this.exitCode})`));
    }
    return new Promise<Caps>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bootWaiter = null;
        reject(new Error(`vm: no ready banner within ${timeoutMs}ms`));
      }, timeoutMs);
      this.bootWaiter = {
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  // Exec runs a single request, serialized like the Go session's mutex.
  exec(req: Request, timeoutMs = DefaultExecTimeout): Promise<Response> {
    const run = this.queue.then(() => this.execNow(req, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Close sends the shutdown op and waits for the module to exit.
  close(timeoutMs = 15_000): Promise<void> {
    const run = this.queue.then(() => this.closeNow(timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private execNow(req: Request, timeoutMs: number): Promise<Response> {
    if (this.closed) {
      return Promise.reject(new Error("vm: session closed"));
    }
    if (!this.channel) {
      return Promise.reject(new Error("vm: session not booted"));
    }
    const seq = ++this.seq;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`vm: exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.channel!.write(encodeRequest(seq, req));
    });
  }

  private closeNow(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    if (!this.channel) {
      return Promise.resolve();
    }
    this.channel.write(encodeRequest(++this.seq, { op: OpShutdown }));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closeWaiter = null;
        reject(new Error(`vm: module did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      this.closeWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private onMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case "channel":
        if (!this.channel) {
          this.channel = new StdinChannel(msg.sab);
        }
        break;
      case "ready":
        this.caps = msg.caps;
        this.bootWaiter?.resolve(msg.caps);
        this.bootWaiter = null;
        break;
      case "response": {
        const waiter = this.pending.get(msg.resp.seq);
        if (waiter) {
          this.pending.delete(msg.resp.seq);
          waiter.resolve(msg.resp);
        }
        break;
      }
      case "exit":
        this.exitCode = msg.code;
        if (this.bootWaiter) {
          this.bootWaiter.reject(new Error(`vm: session exited before ready (code ${msg.code})`));
          this.bootWaiter = null;
        }
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error(`vm: session ended before response (code ${msg.code})`));
        }
        this.pending.clear();
        if (this.closeWaiter) {
          this.closeWaiter.resolve();
          this.closeWaiter = null;
        }
        break;
      case "error":
        if (this.bootWaiter) {
          this.bootWaiter.reject(new Error(`vm: ${msg.message}`));
          this.bootWaiter = null;
        }
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error(`vm: ${msg.message}`));
        }
        this.pending.clear();
        if (this.closeWaiter) {
          this.closeWaiter.reject(new Error(`vm: ${msg.message}`));
          this.closeWaiter = null;
        }
        break;
    }
  }
}
