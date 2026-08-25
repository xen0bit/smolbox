// Main-thread entry for the dev page. Spins up the worker, exposes the session
// and the mount as window.__smolbox (the hook Playwright drives), and wires a
// minimal UI. Also owns the MountHost: the worker cannot receive postMessage
// while the VM runs, so the fsbridge handle lives here and mount/remount never
// round-trips the worker.

import { asset } from "./base.ts";
import { MountHost, DirectoryHandleLike } from "./fsbridge/main-host.ts";
import type { Caps, Request, Response } from "./protocol.ts";
import { Session } from "./session.ts";
import { Terminal } from "./terminal.ts";
import { getOpfsDirectoryHandle, isPickCancelled, pickDirectoryHandle } from "./mount.ts";
import { isDownloading, isWorkerPhase, vmStatusLine } from "./vm-status.ts";

export interface SmolboxHandle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
  setMount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void;
  mountStatus(): boolean;
}

const worker = new Worker(asset("worker.js"), { type: "module" });
const session = new Session(worker);
const mount = new MountHost();

const statusEl = document.getElementById("status");
const termEl = document.getElementById("terminal");
const pickButton = document.getElementById("pick");
const progressEl = document.getElementById("wasm-progress");

// The terminal owns the session; window.__smolbox below still reaches it
// directly, because that is the hook the e2e suites drive and it must keep
// working whether or not anyone has typed a command.
const terminal = termEl
  ? new Terminal({
      root: termEl,
      session,
      historyKey: "smolbox.history",
      examples: ["uname -a", "ls /", "python3 -V", "ls -la /mnt/host", ":help"],
    })
  : null;

// The header is one span and there are two independent facts to put in it —
// what the VM is doing, and whether a folder is mounted — so they are held
// apart and joined rather than overwriting each other. Picking a folder used to
// wipe out whatever the VM had last said about itself. (The agent page reached
// the same conclusion about the same problem and came out with three chips; see
// agent/status.ts.)
let vmLine = "starting…";
let mountLine = "";

function render(): void {
  if (statusEl) {
    statusEl.textContent = mountLine ? `${vmLine} · ${mountLine}` : vmLine;
  }
}

function setStatus(text: string): void {
  vmLine = text;
  render();
}

function setMountStatus(text: string): void {
  mountLine = text;
  render();
}

function formatBytes(n: number): string {
  if (n >= 1 << 30) {
    return `${(n / (1 << 30)).toFixed(1)} GiB`;
  }
  if (n >= 1 << 20) {
    return `${(n / (1 << 20)).toFixed(1)} MiB`;
  }
  if (n >= 1 << 10) {
    return `${(n / (1 << 10)).toFixed(0)} KiB`;
  }
  return `${n} B`;
}

worker.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as {
    type?: string;
    message?: string;
    phase?: string;
    caps?: Caps;
    code?: number;
    sab?: SharedArrayBuffer;
    loaded?: number;
    total?: number;
    text?: string;
  };
  switch (msg.type) {
    case "console":
      if (msg.text) {
        terminal?.system(msg.text);
      }
      break;
    case "log":
      if (msg.message) {
        console.log("smolbox worker:", msg.message);
      }
      if (isWorkerPhase(msg.phase)) {
        setStatus(vmStatusLine(msg.phase));
        // "fetching" is the phase the download runs in; reaching any later one
        // means the bar's job is done.
        if (!isDownloading(msg.phase) && progressEl) {
          progressEl.hidden = true;
        }
      } else if (msg.message) {
        // A log line with no phase is the boot watchdog's stall report, which is
        // the one diagnostic this page has for a VM that never comes up. Show it
        // verbatim, and leave the bar alone — it says nothing about the download.
        setStatus(msg.message);
      }
      break;
    // The guest is up. The worker starts the VM on its own, so this arrives
    // whether or not anyone has typed a command — which is exactly why the
    // header used to sit on "booting the VM" forever on a VM that had booted.
    case "ready":
      setStatus(vmStatusLine("ready", msg.caps ? `agent v${msg.caps.version}` : undefined));
      if (progressEl) {
        progressEl.hidden = true;
      }
      break;
    case "exit":
      setStatus(vmStatusLine("exited", `code ${msg.code}`));
      break;
    case "progress":
      if (progressEl && typeof msg.loaded === "number") {
        progressEl.hidden = false;
        if (msg.total) {
          const pct = Math.min(100, Math.round((msg.loaded / msg.total) * 100));
          progressEl.setAttribute("value", String(pct));
          setStatus(
            `loading smolbox.wasm… ${pct}% (${formatBytes(msg.loaded)} of ${formatBytes(msg.total)})`,
          );
        } else {
          // No total to divide by — a chunked response, or an encoded one with
          // no identity size. A <progress> with no `value` renders as an
          // indeterminate bar, which is the honest thing to show; leaving a
          // stale value would freeze the bar mid-track for the whole download.
          progressEl.removeAttribute("value");
          setStatus(`loading smolbox.wasm… ${formatBytes(msg.loaded)}`);
        }
      }
      break;
    case "error":
      setStatus(vmStatusLine("failed", msg.message));
      if (progressEl) {
        progressEl.hidden = true;
      }
      break;
    // The fsbridge's two messages: the worker posts the SAB once at startup
    // (fschannel), then wakes this thread once per request (fsreq). All handle
    // work happens here on the main thread — the worker is blocked inside
    // wasi.start() for the VM's lifetime and cannot service these itself.
    case "fschannel":
      if (msg.sab) {
        mount.attach(msg.sab);
      }
      break;
    case "fsreq":
      mount.serve();
      break;
  }
});

// window.__smolbox is the hook Playwright's e2e suites drive. setMount/remount
// are main-thread-only by design: the worker cannot receive postMessage while
// the VM runs, so mount changes never round-trip it.
const handle: SmolboxHandle = {
  boot: (t?: number) => session.boot(t),
  exec: (req: Request, t?: number) => session.exec(req, t),
  close: (t?: number) => session.close(t),
  setMount: (mountHandle: DirectoryHandleLike | null, links?: Record<string, string>) => {
    mount.remount(mountHandle, links);
    setMountStatus(mountHandle ? "mount: folder ready" : "mount: none");
  },
  mountStatus: () => mount.mounted(),
};
(globalThis as unknown as Record<string, unknown>).__smolbox = handle;

if (!crossOriginIsolated) {
  setStatus("FAIL: cross-origin isolation required (SharedArrayBuffer). Serve with COOP/COEP headers.");
}

if (pickButton) {
  pickButton.addEventListener("click", async () => {
    try {
      const picked = await pickDirectoryHandle();
      handle.setMount(picked);
    } catch (err) {
      setMountStatus(
        isPickCancelled(err)
          ? "mount unchanged (no folder chosen)"
          : `pick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

// OPFS is the no-picker fallback and the path the e2e tests drive.
void getOpfsDirectoryHandle()
  .then(() => {
    if (pickButton) {
      pickButton.textContent = "choose a folder to mount at /mnt/host";
    }
  })
  .catch(() => undefined);

terminal?.focus();
