// stdio router: the browser twin of internal/vm.Session.scan. Bytes written by
// the guest to fd 1/2 feed a FrameDecoder; REQ frames are pushed to the guest
// through a shared-memory stdin channel.

import {
  Caps,
  Frame,
  FrameDecoder,
  Request,
  Response,
  decodeReady,
  decodeResponse,
  encodeRequest,
} from "./protocol.ts";

export type OutputStream = "stdout" | "stderr";

export interface StdioCallbacks {
  onReady(caps: Caps): void;
  onResponse(resp: Response): void;
  onOutput?(stream: OutputStream, data: Uint8Array): void;
  onError?(err: Error): void;
}

// Layout of the stdin SharedArrayBuffer: [counter][batchLen][consumed][pad]
// then a byte payload. The main thread writes whole REQ frames; the worker
// reads them inside the emulator's fd_read. Atomics.wait on the counter lets
// the worker sleep instead of busy-looping on an empty queue.
const STDIN_INTS = 4;
const STDIN_PAD = STDIN_INTS * 4;
export const STDIN_PAYLOAD_SIZE = 8 * 1024 * 1024;

const I_BATCH = 1;
const I_CONSUMED = 2;

export class StdinChannel {
  readonly sab: SharedArrayBuffer;
  private ints: Int32Array;
  private payload: Uint8Array;

  static create(): StdinChannel {
    return new StdinChannel(new SharedArrayBuffer(STDIN_PAD + STDIN_PAYLOAD_SIZE));
  }

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.ints = new Int32Array(sab, 0, STDIN_INTS);
    this.payload = new Uint8Array(sab, STDIN_PAD, STDIN_PAYLOAD_SIZE);
  }

  available(): boolean {
    return Atomics.load(this.ints, I_BATCH) > Atomics.load(this.ints, I_CONSUMED);
  }

  // Worker side: serve up to size bytes of the current batch, or null when
  // empty (the emulator treats that as EAGAIN and the guest kernel re-polls).
  read(size: number): Uint8Array | null {
    const len = Atomics.load(this.ints, I_BATCH);
    let consumed = Atomics.load(this.ints, I_CONSUMED);
    if (consumed >= len) {
      return null;
    }
    const n = Math.min(size, len - consumed);
    const out = this.payload.slice(consumed, consumed + n);
    Atomics.store(this.ints, I_CONSUMED, consumed + n);
    return out;
  }

  // Worker side: block until data is available or the timeout elapses.
  poll(timeoutMs: number): { readable: boolean; sleptMs: number } {
    if (this.available()) {
      return { readable: true, sleptMs: 0 };
    }
    const start = performance.now();
    const cur = Atomics.load(this.ints, 0);
    Atomics.wait(this.ints, 0, cur, Math.max(0, timeoutMs));
    return { readable: this.available(), sleptMs: performance.now() - start };
  }

  // Main-thread side: publish a whole REQ frame. The previous batch must be
  // fully consumed first, which the protocol guarantees: the guest only sends
  // a response after draining the entire request.
  write(bytes: Uint8Array): void {
    this.payload.set(bytes, 0);
    Atomics.store(this.ints, I_CONSUMED, 0);
    Atomics.store(this.ints, I_BATCH, bytes.length);
    Atomics.add(this.ints, 0, 1);
    Atomics.notify(this.ints, 0, 1);
  }
}

export class StdioRouter {
  private decoder = new FrameDecoder();

  constructor(private stdin: StdinChannel, private cb: StdioCallbacks) {}

  // Called synchronously from the worker's fd_write patch for both fd 1 and
  // fd 2; the console stream is a single frame stream, like wazero's
  // WithStdout/WithStderr sharing one pipe.
  push(stream: OutputStream, data: Uint8Array): void {
    this.cb.onOutput?.(stream, data);
    let frames: Frame[];
    try {
      frames = this.decoder.feed(data);
    } catch (err) {
      this.cb.onError?.(err as Error);
      return;
    }
    for (const frame of frames) {
      this.dispatch(frame);
    }
  }

  sendRequest(seq: number, req: Request): void {
    this.stdin.write(encodeRequest(seq, req));
  }

  private dispatch(frame: Frame): void {
    try {
      switch (frame.kind) {
        case "ready":
          this.cb.onReady(decodeReady(frame));
          break;
        case "response":
          this.cb.onResponse(decodeResponse(frame));
          break;
        case "request":
          break;
      }
    } catch (err) {
      this.cb.onError?.(err as Error);
    }
  }
}
