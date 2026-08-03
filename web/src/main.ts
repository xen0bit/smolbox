// Main-thread entry for the dev page. Spins up the worker, exposes the session
// as window.__smolbox (the hook Playwright drives), and wires a minimal UI.

import type { Caps, Request, Response } from "./protocol.ts";
import { OpExec } from "./protocol.ts";
import { Session } from "./session.ts";

export interface SmolboxHandle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
}

const worker = new Worker("/worker.js", { type: "module" });
const session = new Session(worker);

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

worker.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; message?: string };
  if (msg.type === "log" && msg.message) {
    console.log("smolbox worker:", msg.message);
    setStatus(msg.message);
  }
  if (msg.type === "error" && msg.message) {
    setStatus(`error: ${msg.message}`);
  }
});

(globalThis as unknown as Record<string, unknown>).__smolbox = {
  boot: (t?: number) => session.boot(t),
  exec: (req: Request, t?: number) => session.exec(req, t),
  close: (t?: number) => session.close(t),
} satisfies SmolboxHandle;

if (!crossOriginIsolated) {
  setStatus("FAIL: cross-origin isolation required (SharedArrayBuffer). Serve with COOP/COEP headers.");
}

let booting = false;
if (runButton) {
  runButton.addEventListener("click", async () => {
    if (booting) {
      return;
    }
    booting = true;
    try {
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
