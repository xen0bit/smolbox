// M4 worker: forks upstream examples/wasi-browser/htdocs/worker.js, swapping
// xterm-pty for the framed stdio router and the certificates dir for the sync
// FS bridge preopen at /mnt/host (M5). All session I/O flows through a
// shared-memory stdin channel, and all mount I/O through a second
// shared-memory bridge channel: this thread runs the module synchronously (so
// it cannot receive postMessage during the session), while the main thread
// writes REQ frames straight into the SABs and services fsbridge requests.

import { ConsoleStdout, Fd, WASI, wasi } from "@bjorn3/browser_wasi_shim";
import { BridgeChannel, createBridgeSab } from "./fsbridge/protocol.ts";
import { createBridgeFd } from "./fsbridge/worker-fd.ts";
import type { Caps, Response } from "./protocol.ts";
import { StdinChannel, StdioRouter } from "./stdio.ts";

const WASM_URL = "smolbox.wasm";

// Stateful on purpose: fd_write hands over whatever the guest happened to flush,
// so a character can straddle two calls. See the onOutput hook below.
const consoleText = new TextDecoder();

function postLog(msg: string): void {
  postMessage({ type: "log", message: msg });
}

const stdin = StdinChannel.create();
postMessage({ type: "channel", sab: stdin.sab });

const fsChannel = createBridgeSab();
postMessage({ type: "fschannel", sab: fsChannel });

// Boot watchdog. wasi.start() blocks this worker for the VM's lifetime, so a
// timer cannot fire here — the diagnostic has to ride the poll loop, which is
// the one thing still running. Silence in these reports is itself the signal:
// it means poll_oneoff stopped returning, i.e. the worker is parked in a wait.
const bootStart = performance.now();
let ready = false;
let polls = 0;
let lastWaitMs = -1;
let unclockedPolls = 0;
let consoleBytes = 0;
let nextReportMs = 20_000;

function reportBootStall(): void {
  const elapsed = performance.now() - bootStart;
  if (ready || elapsed < nextReportMs) {
    return;
  }
  nextReportMs = elapsed + 5_000;
  postMessage({
    type: "log",
    message:
      `boot stalled: ${Math.round(elapsed)}ms, polls=${polls}, lastWaitMs=${Math.round(lastWaitMs)}, ` +
      `unclockedPolls=${unclockedPolls}, consoleBytes=${consoleBytes}, stdinReadable=${stdin.available()}`,
  });
}

const router = new StdioRouter(stdin, {
  onReady: (caps: Caps) => {
    ready = true;
    postMessage({ type: "ready", caps });
  },
  onResponse: (resp: Response) => postMessage({ type: "response", resp }),
  onError: (err: Error) => postMessage({ type: "error", message: String(err) }),
  // The kernel's boot log shares this stream with the protocol frames and never
  // becomes a frame itself, so it is invisible to everything downstream of the
  // decoder. Forward it raw and let the page decide whether to show it — the
  // terminal on / does, and it is the only live output that page has.
  onOutput: (_stream, data) => postMessage({ type: "console", text: consoleText.decode(data, { stream: true }) }),
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
  // A poll carrying only fd-read subscriptions has no deadline to bound the
  // wait. Sleeping until stdin arrives is wrong during boot: nothing is going to
  // arrive, because the host does not write until the ready banner says the
  // guest is up — so the VM sleeps forever and boot "just hangs". Cap every wait
  // instead, turning that case into a slow re-poll. Costs nothing on the normal
  // path, where a clock subscription already bounds waitMs well below this.
  // (This is the un-clocked cousin of the 24.8-day wait in PLAN 2.11.11.)
  const MAX_POLL_MS = 250;

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

    polls++;
    lastWaitMs = waitMs;
    if (clockSubs.length === 0) {
      unclockedPolls++;
    }
    reportBootStall();

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

// smolbox.wasm is ~110 MiB, so on a slow link the download dwarfs the boot.
// Stream it and report progress to the main thread, which shows a loading bar;
// the worker can still receive postMessage here because wasi.start() has not
// run yet. One message per percentage point keeps a fast localhost fetch to
// ~100 messages, and a missing Content-Length (chunked encoding) falls back to
// one message per MiB so the bar still moves.
async function fetchWasm(): Promise<ArrayBuffer> {
  const resp = await fetch(WASM_URL);
  if (!resp.ok) {
    throw new Error(`fetch ${WASM_URL}: ${resp.status} ${resp.statusText}`);
  }
  // The bytes this reader yields are decoded, so on a compressed response
  // Content-Length (the encoded size) would put the bar past 100% and pin it
  // there. serve.ts sends the identity size in X-Uncompressed-Length; prefer
  // it, and treat an encoded response without it as unknown-length rather than
  // trusting a number that measures the wrong thing.
  const encoded = resp.headers.get("content-encoding");
  const total =
    Number(resp.headers.get("x-uncompressed-length")) ||
    (encoded ? 0 : Number(resp.headers.get("content-length"))) ||
    0;
  if (!resp.body) {
    const bytes = await resp.arrayBuffer();
    if (total) {
      postMessage({ type: "progress", loaded: total, total });
    }
    return bytes;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPct = -1;
  let lastMiB = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    if (pct !== lastPct || (total === 0 && loaded - lastMiB >= 1 << 20)) {
      lastPct = pct;
      lastMiB = loaded;
      postMessage({ type: "progress", loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, off);
    off += chunk.byteLength;
  }
  postMessage({ type: "progress", loaded, total });
  return bytes.buffer;
}

async function run(): Promise<void> {
  postLog("fetching wasm");
  const bytes = await fetchWasm();
  const fds: Array<Fd | undefined> = [
    new StdinFd(stdin),
    new ConsoleStdout((b) => {
      consoleBytes += b.length;
      router.push("stdout", b);
    }),
    new ConsoleStdout((b) => {
      consoleBytes += b.length;
      router.push("stderr", b);
    }),
    createBridgeFd(new BridgeChannel(fsChannel), "/mnt/host"),
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
