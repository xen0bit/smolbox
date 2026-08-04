// M4 worker: forks upstream examples/wasi-browser/htdocs/worker.js, swapping
// xterm-pty for the framed stdio router and the certificates dir for an
// in-memory /mnt/host preopen (the spike). All session I/O flows through a
// shared-memory stdin channel: this thread runs the module synchronously (so it
// cannot receive postMessage during the session), while the main thread writes
// REQ frames straight into the SAB.

import { ConsoleStdout, Fd, WASI, wasi } from "@bjorn3/browser_wasi_shim";
import { inMemoryMount, spikeMountTree } from "./mount.ts";
import type { Caps, Response } from "./protocol.ts";
import { StdinChannel, StdioRouter } from "./stdio.ts";

const WASM_URL = "smolbox.wasm";

function postLog(msg: string): void {
  postMessage({ type: "log", message: msg });
}

const stdin = StdinChannel.create();
postMessage({ type: "channel", sab: stdin.sab });

const router = new StdioRouter(stdin, {
  onReady: (caps: Caps) => postMessage({ type: "ready", caps }),
  onResponse: (resp: Response) => postMessage({ type: "response", resp }),
  onError: (err: Error) => postMessage({ type: "error", message: String(err) }),
});

// The emulator treats an EAGAIN from fd_read as "guest keeps waiting", the same
// nonblocking contract wazero's os.Pipe satisfies.
class StdinFd extends Fd {
  constructor(private ch: StdinChannel) {
    super();
  }

  fd_read(size: number) {
    const data = this.ch.read(size);
    if (data === null) {
      return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array(0) };
    }
    return { ret: wasi.ERRNO_SUCCESS, data };
  }

  fd_fdstat_get() {
    return {
      ret: wasi.ERRNO_SUCCESS,
      fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0),
    };
  }
}

// The base shim's poll_oneoff only handles a single clock subscription and
// busy-loops on it. The guest kernel polls fd 0 for console input, so we
// replace it with an Atomics-based wait, mirroring upstream wasiHack().
function patchPollOneoff(wasiInstance: WASI, ch: StdinChannel): void {
  const wasiImport = wasiInstance.wasiImport;
  const MAX_POLL_MS = 2 ** 31 - 1;

  wasiImport.poll_oneoff = (inPtr: number, outPtr: number, nSubscriptions: number, neventsPtr: number) => {
    if (nSubscriptions === 0) {
      return wasi.ERRNO_INVAL;
    }
    const buffer = new DataView(wasiInstance.inst.exports.memory.buffer);
    const readSubs: wasi.Subscription[] = [];
    const clockSubs: Array<{ sub: wasi.Subscription; deadlinePerfMs: number }> = [];
    for (let i = 0; i < nSubscriptions; i++) {
      const sub = wasi.Subscription.read_bytes(buffer, inPtr + 48 * i);
      if (sub.eventtype === wasi.EVENTTYPE_FD_READ) {
        if (sub.clockid !== 0) {
          return wasi.ERRNO_INVAL;
        }
        readSubs.push(sub);
      } else if (sub.eventtype === wasi.EVENTTYPE_CLOCK) {
        const monotonic = sub.clockid === wasi.CLOCKID_MONOTONIC;
        const realtime = sub.clockid === wasi.CLOCKID_REALTIME;
        if (!monotonic && !realtime) {
          return wasi.ERRNO_INVAL;
        }
        // Convert every deadline into performance.now() ms space so the wait
        // duration and the "has it passed?" check share one timeline. The
        // shim's clocks: MONOTONIC = performance.now()*1e6, REALTIME =
        // Date.now()*1e6.
        const abs = (sub.flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0;
        const tMs = Number(sub.timeout) / 1e6;
        const deadlinePerfMs = abs
          ? monotonic
            ? tMs
            : tMs - Date.now() + performance.now()
          : performance.now() + tMs;
        clockSubs.push({ sub, deadlinePerfMs });
      } else {
        return wasi.ERRNO_INVAL;
      }
    }

    let waitMs = MAX_POLL_MS;
    const nowMs = performance.now();
    for (const c of clockSubs) {
      waitMs = Math.min(waitMs, Math.max(0, c.deadlinePerfMs - nowMs));
    }

    let out = outPtr;
    const { readable } = ch.poll(waitMs);
    if (readable) {
      for (const sub of readSubs) {
        const event = new wasi.Event(sub.userdata, wasi.ERRNO_SUCCESS, wasi.EVENTTYPE_FD_READ);
        event.write_bytes(buffer, out);
        out += 32;
      }
    }
    for (const c of clockSubs) {
      if (performance.now() >= c.deadlinePerfMs) {
        const event = new wasi.Event(c.sub.userdata, wasi.ERRNO_SUCCESS, wasi.EVENTTYPE_CLOCK);
        event.write_bytes(buffer, out);
        out += 32;
      }
    }
    buffer.setUint32(neventsPtr, (out - outPtr) / 32, true);
    return wasi.ERRNO_SUCCESS;
  };
}

async function run(): Promise<void> {
  postLog("fetching wasm");
  const resp = await fetch(WASM_URL);
  const bytes = await resp.arrayBuffer();
  const fds: Array<Fd | undefined> = [
    new StdinFd(stdin),
    new ConsoleStdout((b) => router.push("stdout", b)),
    new ConsoleStdout((b) => router.push("stderr", b)),
    inMemoryMount("/mnt/host", spikeMountTree),
    undefined,
    undefined,
  ];
  const wasiInstance = new WASI(["smolbox.wasm"], [], fds as Fd[]);
  patchPollOneoff(wasiInstance, stdin);
  postLog("instantiating wasm");
  const result = await WebAssembly.instantiate(bytes, {
    wasi_snapshot_preview1: wasiInstance.wasiImport,
  });
  postLog("booting the VM");
  const instance = result.instance as unknown as {
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  };
  const code = wasiInstance.start(instance);
  postMessage({ type: "exit", code });
  (globalThis as unknown as { close(): void }).close();
}

run().catch((err: unknown) => postMessage({ type: "error", message: String(err) }));
