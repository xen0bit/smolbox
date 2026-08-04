// Module['pty'] implementation for the c2w emscripten (--to-js) build.
//
// The emscripten runtime serves the guest console through Module['pty'] with
// the xterm-pty contract (read/write/readable/onReadable/ioctl). In this build
// every one of those calls is PROXIED from the emscripten pthread to the page's
// main thread (see the proxiedFunctionTable in dist/js/out.js), so this object
// is pure main-thread code:
//
//   host -> guest: REQ frames land in the shared-memory StdinChannel; the
//                  runtime's fd_read reads them via read()/readable, and the
//                  page fires notifyInput() after each write to wake any
//                  pending poll/read wait.
//   guest -> host: the runtime's fd_write calls write(); bytes go straight to
//                  hooks.onOutput and StdioRouter decodes the READY/RES frames.
//
// Termios: the guest kernel owns the real tty (ttyS0) and the agent clears
// ICANON/ECHO there, exactly as under wazero; this shim is a byte pipe and
// only answers the tcgetattr/tcsetattr probes QEMU's stdio chardev makes about
// its own stdin. onReadable fires immediately when data is already buffered,
// closing the lost-wakeup window between the pthread's EAGAIN probe and its
// registration of the wait that this page's write must wake.

import type { StdinChannel } from "../stdio.ts";

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyTermios {
  iflag: number;
  oflag: number;
  cflag: number;
  lflag: number;
  cc: number[];
}

export interface ProtocolPtyHooks {
  // Guest console output. Called on the main thread; the page hands the bytes
  // to the frame decoder.
  onOutput(bytes: Uint8Array): void;
}

const ECHO = 0x0008;
const ICANON = 0x0002;
const ISIG = 0x0001;
const OPOST = 0x0001;
const ONLCR = 0x0004;
const ICRNL = 0x0100;
const IXON = 0x0400;

const defaultTermios: PtyTermios = {
  iflag: ICRNL | IXON,
  oflag: OPOST | ONLCR,
  cflag: 0,
  lflag: ISIG | ICANON | ECHO,
  cc: [
    0, 3, 28, 127, 21, 4, 1, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
};

export class ProtocolPty {
  private readCbs: Array<() => void> = [];
  private signalCbs: Array<(signal: string) => void> = [];
  private termios: PtyTermios = structuredClone(defaultTermios);
  // Counters for the page's boot watchdog; a stalled boot looks very different
  // depending on whether the guest is silent (writes 0) or talking.
  readonly stats = { reads: 0, writes: 0, bytesOut: 0, waits: 0 };

  constructor(
    private stdin: StdinChannel,
    private hooks: ProtocolPtyHooks,
  ) {}

  get readable(): boolean {
    return this.stdin.available();
  }

  get writable(): boolean {
    return true;
  }

  read(length: number): Uint8Array {
    this.stats.reads++;
    return this.stdin.read(length) ?? new Uint8Array(0);
  }

  write(data: number[]): void {
    this.stats.writes++;
    this.stats.bytesOut += data.length;
    this.hooks.onOutput(Uint8Array.from(data));
  }

  onReadable(cb: () => void): PtyDisposable {
    this.stats.waits++;
    if (this.stdin.available()) {
      // The runtime registered its wait after the data arrived; do not leave it
      // parked on Atomics.wait forever.
      queueMicrotask(cb);
      return { dispose: () => {} };
    }
    this.readCbs.push(cb);
    return {
      dispose: () => {
        const i = this.readCbs.indexOf(cb);
        if (i >= 0) {
          this.readCbs.splice(i, 1);
        }
      },
    };
  }

  onSignal(cb: (signal: string) => void): PtyDisposable {
    this.signalCbs.push(cb);
    return {
      dispose: () => {
        const i = this.signalCbs.indexOf(cb);
        if (i >= 0) {
          this.signalCbs.splice(i, 1);
        }
      },
    };
  }

  // Main-thread side: fire after a REQ frame is published, waking any poll or
  // fd_read wait the runtime registered. Safe to call when nothing is waiting.
  notifyInput(): void {
    for (const cb of this.readCbs) {
      cb();
    }
  }

  signal(name: string): void {
    for (const cb of this.signalCbs) {
      cb(name);
    }
  }

  ioctl(req: "TCGETS" | "TCSETS" | "TIOCGWINSZ", arg?: unknown): unknown {
    switch (req) {
      case "TCGETS":
        return { ...this.termios, cc: [...this.termios.cc] };
      case "TCSETS": {
        const t = arg as Partial<PtyTermios>;
        if (t && typeof t === "object") {
          this.termios = {
            iflag: t.iflag ?? 0,
            oflag: t.oflag ?? 0,
            cflag: t.cflag ?? 0,
            lflag: t.lflag ?? 0,
            cc: Array.isArray(t.cc) ? [...t.cc] : new Array(32).fill(0),
          };
        }
        return;
      }
      case "TIOCGWINSZ":
        return [80, 24];
    }
  }
}
