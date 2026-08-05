// The M8 spike page: a WebGPU model drives the VM through the M7 tool surface.
//
// Deliberately not a chat UI. One prompt in, one tool call executed against a
// real Session, the tool result fed back, one final answer out — the same
// prove-the-mechanism-first shape M4 used for the preopen spike. Everything
// below the model is component 1, reused unchanged: the VM worker, Session,
// MountHost, and callTool/renderResult from the generated tool surface.

import { MountHost, type DirectoryHandleLike } from "../fsbridge/main-host.ts";
import type { Caps } from "../protocol.ts";
import { Session } from "../session.ts";
import { getOpfsDirectoryHandle, pickDirectoryHandle } from "../mount.ts";
import { callTool, openaiTool, toolName } from "../tool.ts";
import type { ChatMessage, ModelRequest, ModelResponse } from "./messages.ts";
import { type ParsedCall, parseTurn } from "./parse.ts";

const MODEL_PROBE = "/models/onnx-community/LFM2-1.2B-Tool-ONNX/config.json";

// "Output function calls as JSON" is load-bearing: without it LFM2 emits
// Pythonic calls, which parse.ts reports rather than tries to interpret.
const SYSTEM_PROMPT = `You are smolbox, an assistant with access to a Linux sandbox.

The user's folder is mounted read-only at /mnt/host. Use the ${toolName} tool to inspect it before answering. Output function calls as JSON.`;

const DEFAULT_PROMPT = "What files are in /mnt/host? Use the tool to check, then tell me.";

export interface ToolStep {
  call: ParsedCall;
  rendered: string;
  exitCode: number;
}

export interface Transcript {
  prompt: string;
  rawTurn: string;
  steps: ToolStep[];
  finalText: string;
  totalMs: number;
}

export interface SmolagentHandle {
  webgpu(): Promise<{ available: boolean; adapter: boolean; info?: unknown }>;
  loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
  bootVm(timeoutMs?: number): Promise<Caps>;
  setMount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void;
  run(prompt?: string, system?: string): Promise<Transcript>;
  /** Raw generation, no tool execution — used to probe prompt wording. */
  rawGenerate(system: string, prompt: string): Promise<string>;
  close(timeoutMs?: number): Promise<void>;
}

const vmWorker = new Worker("/worker.js", { type: "module" });
const session = new Session(vmWorker);
const mount = new MountHost();
const modelWorker = new Worker("./model-worker.js", { type: "module" });

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");

function log(line: string): void {
  console.log("[smolagent]", line);
  if (logEl) {
    logEl.textContent += `${line}\n`;
  }
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

vmWorker.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; message?: string; sab?: SharedArrayBuffer };
  switch (msg.type) {
    case "fschannel":
      if (msg.sab) {
        mount.attach(msg.sab);
      }
      break;
    case "fsreq":
      mount.serve();
      break;
    case "error":
      if (msg.message) {
        log(`vm error: ${msg.message}`);
      }
      break;
  }
});

// The worker answers one request at a time and the page drives it in strict
// sequence, so a single pending waiter is enough.
let pending: { resolve(r: ModelResponse): void; reject(e: Error): void; want: ModelResponse["type"] } | null = null;

modelWorker.addEventListener("message", (ev: MessageEvent<ModelResponse>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "log":
      log(`model: ${msg.message}`);
      return;
    case "progress":
      setStatus(`loading ${msg.file}: ${msg.pct}%`);
      return;
    case "error":
      pending?.reject(new Error(msg.message));
      pending = null;
      return;
    default:
      if (pending && pending.want === msg.type) {
        pending.resolve(msg);
        pending = null;
      }
  }
});

function ask<T extends ModelResponse["type"]>(
  req: ModelRequest,
  want: T,
): Promise<Extract<ModelResponse, { type: T }>> {
  return new Promise((resolve, reject) => {
    pending = { resolve: resolve as (r: ModelResponse) => void, reject, want };
    modelWorker.postMessage(req);
  });
}

async function haveLocalWeights(): Promise<boolean> {
  try {
    return (await fetch(MODEL_PROBE, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

async function runTranscript(prompt: string, system: string = SYSTEM_PROMPT): Promise<Transcript> {
  const started = performance.now();
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const tools = [openaiTool()];

  log(`> ${prompt}`);
  const first = await ask({ type: "generate", messages, tools }, "generated");
  log(`model turn (${first.tokens} tokens, ${first.ms}ms):\n${first.text}`);

  const turn = parseTurn(first.text);
  const steps: ToolStep[] = [];

  for (const call of turn.calls) {
    if (call.name !== toolName) {
      throw new Error(`model called an unknown tool: ${call.name}`);
    }
    // callTool is the M7 path, untouched: it rejects `op`, rejects unknown
    // fields, and renders the result exactly as the mock caller asserts it.
    const result = await callTool(session, call.args);
    log(`tool ${JSON.stringify(call.args)} ->\n${result.text}`);
    steps.push({ call, rendered: result.text, exitCode: result.response.exit_code });
  }

  if (steps.length === 0) {
    return {
      prompt,
      rawTurn: first.text,
      steps,
      finalText: turn.text,
      totalMs: Math.round(performance.now() - started),
    };
  }

  messages.push({ role: "assistant", content: first.text });
  for (const step of steps) {
    messages.push({ role: "tool", content: step.rendered });
  }

  const second = await ask({ type: "generate", messages, tools }, "generated");
  const final = parseTurn(second.text);
  log(`model answer (${second.tokens} tokens, ${second.ms}ms):\n${final.text}`);

  return {
    prompt,
    rawTurn: first.text,
    steps,
    finalText: final.text,
    totalMs: Math.round(performance.now() - started),
  };
}

const handle: SmolagentHandle = {
  webgpu: async () => {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) {
      return { available: false, adapter: false };
    }
    const adapter = await gpu.requestAdapter();
    return { available: true, adapter: Boolean(adapter), info: (adapter as { info?: unknown })?.info };
  },
  loadModel: async (local?: boolean) => {
    const useLocal = local ?? (await haveLocalWeights());
    log(`loading model (${useLocal ? "local dist/models" : "hugging face hub"})…`);
    const ready = await ask({ type: "load", local: useLocal }, "ready");
    log(`model ready from ${ready.source} in ${ready.loadMs}ms`);
    setStatus(`model ready (${ready.source})`);
    return { source: ready.source, loadMs: ready.loadMs };
  },
  bootVm: async (timeoutMs?: number) => {
    const caps = await session.boot(timeoutMs);
    log(`vm ready (agent v${caps.version})`);
    return caps;
  },
  setMount: (h: DirectoryHandleLike | null, links?: Record<string, string>) => {
    mount.remount(h, links);
    log(h ? "mount: folder attached" : "mount: none");
  },
  run: (prompt?: string, system?: string) => runTranscript(prompt ?? DEFAULT_PROMPT, system),
  rawGenerate: async (system: string, prompt: string) => {
    const r = await ask(
      {
        type: "generate",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        tools: [openaiTool()],
      },
      "generated",
    );
    return r.text;
  },
  close: (timeoutMs?: number) => session.close(timeoutMs),
};
(globalThis as unknown as Record<string, unknown>).__smolagent = handle;

if (!crossOriginIsolated) {
  setStatus("FAIL: cross-origin isolation required (SharedArrayBuffer). Serve with COOP/COEP headers.");
}

const runButton = document.getElementById("run");
const pickButton = document.getElementById("pick");

if (pickButton) {
  pickButton.addEventListener("click", async () => {
    try {
      handle.setMount(await pickDirectoryHandle());
    } catch (err) {
      log(`pick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

let running = false;
if (runButton) {
  runButton.addEventListener("click", async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const gpu = await handle.webgpu();
      if (!gpu.adapter) {
        setStatus("FAIL: no WebGPU adapter available in this browser");
        return;
      }
      if (!mount.mounted()) {
        // Nothing picked yet: OPFS is the no-dialog fallback, same as the VM page.
        handle.setMount(await getOpfsDirectoryHandle());
      }
      await handle.bootVm();
      await handle.loadModel();
      setStatus("running…");
      const t = await handle.run();
      setStatus(`done in ${t.totalMs}ms (${t.steps.length} tool call(s))`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`error: ${message}`);
      log(`error: ${message}`);
    } finally {
      running = false;
    }
  });
}
