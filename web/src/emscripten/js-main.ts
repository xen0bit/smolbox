// Main-thread entry for the emscripten (--to-js) page at /js/. This build has
// no host-mount support (upstream scopes directory sharing to the WASI target),
// so it reuses the framed protocol + TS session code but skips the fsbridge.
//
// QEMU's main() runs on a pthread, but every PTY-touching syscall is in
// out.js's proxiedFunctionTable, so its console hooks come back to this thread
// (see protocol-pty.ts) and the whole session can live here. The page provides
// Module['pty'], writes /pack/info, replaces the blocking TTY poll, and drives
// the guest through the same window.__smolbox contract as web/src/main.ts.
// Guest output goes straight from the pty into StdioRouter, which delivers
// ready/response frames to Session exactly like the WASI worker's messages;
// REQ frames go the other way through the shared-memory StdinChannel.

import { ProtocolPty } from "./protocol-pty.ts";
import type { Caps, Request, Response } from "../protocol.ts";
import { OpExec, OpShutdown } from "../protocol.ts";
import { Session } from "../session.ts";
import { StdioRouter, StdinChannel } from "../stdio.ts";

interface EmscriptenModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: string): void;
  };
  TTY: {
    stream_ops: { poll(stream: unknown, timeout?: number): number };
  };
}

type ModuleLike = Record<string, unknown> & {
  pty?: ProtocolPty;
  preRun?: Array<(mod: EmscriptenModule) => void>;
  onExit?: (code: number) => void;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
};

export interface SmolboxHandle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
  setMount(_handle: unknown, _links?: Record<string, string>): void;
  mountStatus(): boolean;
}

const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const runButton = document.getElementById("run");

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function appendOutput(text: string): void {
  if (outputEl) {
    outputEl.textContent += text;
  }
}

// A fake MessageSink so the emscripten page can reuse the browser Session
// verbatim: Session assigns worker.onmessage, and we invoke it ourselves when
// StdioRouter produces ready/response frames.
const sink: { onmessage: ((ev: MessageEvent) => void) | null } = { onmessage: null };
const session = new Session(sink);
const emit = (msg: unknown): void => {
  sink.onmessage?.({ data: msg } as MessageEvent);
};

const realChannel = StdinChannel.create();
const pty = new ProtocolPty(realChannel, {
  onOutput: (bytes) => router.push("stdout", bytes),
});
realChannel.onWrite = () => pty.notifyInput();

const router = new StdioRouter(realChannel, {
  onReady: (caps) => emit({ type: "ready", caps }),
  onResponse: (resp) => emit({ type: "response", resp }),
  onError: (err) => emit({ type: "error", message: String(err) }),
});

// Deliver the stdin channel to Session, matching the worker's startup message.
emit({ type: "channel", sab: realChannel.sab });

// QEMU does not exit when the guest stops: c2w's init runs `poweroff -f` once
// the container command returns, but the kernel is booted with acpi=off, so
// there is no power-management path and the CPU simply halts inside a
// still-running emulator. Session.close() waits for a module exit that never
// arrives here, so shut the agent down with a plain request and treat its reply
// as the end of the session. The runtime itself dies with the page.
let closed = false;
async function close(timeoutMs = 15_000): Promise<void> {
  if (closed) {
    return;
  }
  closed = true;
  await session.exec({ op: OpShutdown }, timeoutMs);
  emit({ type: "exit", code: 0 });
}

const handle: SmolboxHandle = {
  boot: (t?: number) => session.boot(t),
  exec: (req: Request, t?: number) => session.exec(req, t),
  close,
  setMount: () => setStatus("mount: n/a (the emscripten build has no host mount)"),
  mountStatus: () => false,
};
(globalThis as unknown as Record<string, unknown>).__smolbox = handle;

if (!crossOriginIsolated) {
  setStatus("FAIL: cross-origin isolation required (SharedArrayBuffer). Serve with COOP/COEP headers.");
}

async function main(): Promise<void> {
  // c2w emits out.js (the ES6 module factory), qemu-system-x86_64.{wasm,data},
  // load.js (the FS preload for the .data package) and arg-module.js (the QEMU
  // arguments). The latter two are classic scripts loaded by js.html; both
  // populate the global Module object, which is why we read it here rather than
  // building one from scratch. Pthread workers re-import out.js, so it must be
  // reachable at a stable URL: that is what mainScriptUrlOrBlob below is for.
  const Module = ((globalThis as unknown as { Module?: ModuleLike }).Module ?? {}) as ModuleLike;

  Module.pty = pty;
  Module.preRun = Module.preRun ?? [];
  Module.preRun.push((mod) => {
    try {
      mod.FS.mkdir("/pack");
    } catch {
      // already exists
    }
    // The guest init reads /pack/info for the boot timestamp and mount lines.
    // No mount lines here: this target is deliberately no-mount.
    mod.FS.writeFile("/pack/info", `t:${Math.round(Date.now() / 1000)}\n`);

    // The shipped TTY.stream_ops.poll throws PTY_askToWaitAgain whenever the
    // pty has no input, which parks QEMU's entire main loop on Atomics.wait
    // until someone types. With a headless console nobody ever does, so the VM
    // never reaches its first serial write. Replace it with the same mask,
    // minus the block — upstream's examples override it for the same reason.
    // The blocking path stays where it belongs: TTY.stream_ops.read still
    // suspends fd_read on an empty pty, and StdinChannel.onWrite wakes it.
    mod.TTY.stream_ops.poll = () => (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
  });
  Module.mainScriptUrlOrBlob = new URL("./out.js", import.meta.url).href;
  Module.print = (line: string) => appendOutput(line + "\n");
  Module.printErr = (line: string) => appendOutput(line + "\n");
  Module.onExit = (code: number) => emit({ type: "exit", code });

  setStatus("fetching the emscripten module…");
  const outUrl = new URL("./out.js", import.meta.url).href;
  const mod = (await import(outUrl)) as {
    default: (module: ModuleLike) => Promise<unknown>;
  };
  setStatus("booting the VM (emscripten/QEMU, no host mount)…");
  await mod.default(Module);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(`error: ${message}`);
  emit({ type: "error", message });
});

if (runButton) {
  runButton.addEventListener("click", async () => {
    try {
      await session.boot();
      const resp = await session.exec({ op: OpExec, cmd: "echo hello" });
      appendOutput(resp.stdout + resp.stderr);
      setStatus(`done in ${resp.duration_ms}ms`);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
