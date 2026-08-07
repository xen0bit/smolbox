// Main-thread entry for the dev page. Spins up the worker, exposes the session
// and the mount as window.__smolbox (the hook Playwright drives), and wires a
// minimal UI. Also owns the MountHost: the worker cannot receive postMessage
// while the VM runs, so the fsbridge handle lives here and mount/remount never
// round-trips the worker.

import { MountHost, DirectoryHandleLike } from "./fsbridge/main-host.ts";
import type { Caps, Request, Response } from "./protocol.ts";
import { OpExec } from "./protocol.ts";
import { Session } from "./session.ts";
import { getOpfsDirectoryHandle, isPickCancelled, pickDirectoryHandle } from "./mount.ts";

export interface SmolboxHandle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
  setMount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void;
  mountStatus(): boolean;
}

const worker = new Worker("/worker.js", { type: "module" });
const session = new Session(worker);
const mount = new MountHost();

const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const runButton = document.getElementById("run");
const pickButton = document.getElementById("pick");
const progressEl = document.getElementById("wasm-progress");

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
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

function appendOutput(text: string): void {
  if (outputEl) {
    outputEl.textContent += text;
  }
}

worker.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as {
    type?: string;
    message?: string;
    sab?: SharedArrayBuffer;
    loaded?: number;
    total?: number;
  };
  switch (msg.type) {
    case "log":
      if (msg.message) {
        console.log("smolbox worker:", msg.message);
        setStatus(msg.message);
        // "fetching wasm" is the message that precedes the download; anything
        // later (instantiating, booting) means the bar's job is done.
        if (msg.message !== "fetching wasm" && progressEl) {
          progressEl.hidden = true;
        }
      }
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
      if (msg.message) {
        setStatus(`error: ${msg.message}`);
      }
      if (progressEl) {
        progressEl.hidden = true;
      }
      break;
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

const handle: SmolboxHandle = {
  boot: (t?: number) => session.boot(t),
  exec: (req: Request, t?: number) => session.exec(req, t),
  close: (t?: number) => session.close(t),
  setMount: (mountHandle: DirectoryHandleLike | null, links?: Record<string, string>) => {
    mount.remount(mountHandle, links);
    setStatus(mountHandle ? "mount: folder ready" : "mount: none");
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
      setStatus(
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

let booting = false;
if (runButton) {
  runButton.addEventListener("click", async () => {
    if (booting) {
      return;
    }
    booting = true;
    try {
      if (progressEl) {
        progressEl.setAttribute("value", "0");
      }
      const caps = await session.boot();
      setStatus(`ready (agent v${caps.version})`);
      const resp = await session.exec({ op: OpExec, cmd: "echo hello" });
      appendOutput(resp.stdout + resp.stderr);
      setStatus(`done in ${resp.duration_ms}ms`);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      booting = false;
    }
  });
}
