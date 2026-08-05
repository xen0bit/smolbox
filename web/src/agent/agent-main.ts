// The agent page: a local model on WebGPU driving the VM through the M7 tool
// surface, with a chat interface around it.
//
// Everything below the model is component 1, reused unchanged: the VM worker,
// Session, MountHost, and callTool/renderResult from the generated tool surface.
// The loop itself lives in conversation.ts, which knows nothing about the DOM or
// about WebGPU — that is what lets CI drive it against FakeModelClient.

import { MountHost, type DirectoryHandleLike } from "../fsbridge/main-host.ts";
import type { Caps } from "../protocol.ts";
import { Session } from "../session.ts";
import { getOpfsDirectoryHandle, pickDirectoryHandle } from "../mount.ts";
import { callTool, openaiTool, toolName } from "../tool.ts";
import { type AgentEvent, Conversation, DEFAULTS, type ToolRunner } from "./conversation.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import type { ModelClient } from "./model-client.ts";
import { WorkerModelClient } from "./model-client.ts";
import type { ParsedCall } from "./parse.ts";

const MODEL_PROBE = "/models/onnx-community/LFM2-1.2B-Tool-ONNX/config.json";

const SYSTEM_PROMPT = `You are smolbox, an assistant with access to a Linux sandbox.

The user's folder is mounted read-only at /mnt/host. Use the ${toolName} tool to inspect it before answering, then answer from what the tool returned.`;

const vmWorker = new Worker("/worker.js", { type: "module" });
const session = new Session(vmWorker);
const mount = new MountHost();

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
  }
});

// ---------------------------------------------------------------- DOM helpers

const el = (id: string) => document.getElementById(id);
const logEl = el("log");
const statusEl = el("status");
const promptEl = el("prompt");
const sendEl = el("send");
const stopEl = el("stop");
const startEl = el("start");
const pickEl = el("pick");

function setStatus(text: string): void {
  console.log("[smolagent]", text);
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function bubble(cls: string, who: string): Element | null {
  if (!logEl) {
    return null;
  }
  const wrap = document.createElement("div");
  wrap.className = `msg ${cls}`;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who;
  const body = document.createElement("div");
  body.className = "body";
  wrap.appendChild(label);
  wrap.appendChild(body);
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  return body;
}

// ------------------------------------------------------------ the model side

const params = new URLSearchParams(location.search);
let modelClient: ModelClient = new WorkerModelClient(
  new Worker("./model-worker.js", { type: "module" }),
  (line) => console.log("[model]", line),
  (file, pct) => setStatus(`loading ${file}: ${pct}%`),
);

const runner: ToolRunner = {
  run: async (call: ParsedCall) => {
    const result = await callTool(session, call.args);
    return { text: result.text, exitCode: result.response.exit_code };
  },
};

let events: AgentEvent[] = [];
let streaming: Element | null = null;

const convo = new Conversation(
  { systemPrompt: SYSTEM_PROMPT, tools: [openaiTool()], ...DEFAULTS },
  {
    load: (local) => modelClient.load(local),
    generate: (r) => modelClient.generate(r),
    cancel: () => modelClient.cancel(),
  },
  runner,
  onEvent,
);

function onEvent(ev: AgentEvent): void {
  events.push(ev);
  switch (ev.kind) {
    case "user":
      bubble("user", "you")!.textContent = ev.text;
      streaming = null;
      break;
    case "token": {
      // Prose streams live; a tool-call block is held back until it closes,
      // because half a call rendered as text is noise, not progress.
      if (!streaming) {
        streaming = bubble("assistant", "model");
      }
      if (streaming) {
        const next = (streaming.textContent ?? "") + ev.text;
        streaming.textContent = visiblePart(next);
        logEl && (logEl.scrollTop = logEl.scrollHeight);
      }
      break;
    }
    case "assistant":
      if (streaming) {
        streaming.textContent = ev.text;
      } else if (ev.text) {
        bubble("assistant", "model")!.textContent = ev.text;
      }
      streaming = null;
      break;
    case "tool-start":
      streaming = null;
      break;
    case "tool-end": {
      const body = bubble("tool", `tool · exit ${ev.exitCode}`);
      if (body) {
        const cmd = document.createElement("span");
        cmd.className = "cmd";
        cmd.textContent = `$ ${String(ev.call.args.cmd ?? "")}`;
        const out = document.createElement("span");
        out.textContent = ev.rendered;
        body.appendChild(cmd);
        body.appendChild(out);
      }
      break;
    }
    case "elided":
      bubble("note", "context")!.textContent =
        `elided ${ev.messages} older message(s) to stay within the history budget (now ~${ev.chars} chars)`;
      break;
    case "stopped":
      bubble("note", "stopped")!.textContent =
        ev.reason === "iteration-cap"
          ? "stopped: hit the tool-call limit for this turn"
          : "stopped by you";
      streaming = null;
      break;
    case "error":
      bubble("error", "error")!.textContent = ev.message;
      streaming = null;
      break;
  }
}

const OPEN = "<|tool_call_start|>";

// Everything from an unclosed tool-call marker onward is withheld.
function visiblePart(raw: string): string {
  const open = raw.lastIndexOf(OPEN);
  if (open === -1) {
    return stripMarkers(raw);
  }
  return stripMarkers(raw.slice(0, open));
}

function stripMarkers(s: string): string {
  return s
    .replace(/<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/g, "")
    .replace(/<\|im_(start|end)\|>/g, "")
    .replace(/<\|(start|end)oftext\|>/g, "");
}

// -------------------------------------------------------------- page plumbing

async function haveLocalWeights(): Promise<boolean> {
  try {
    return (await fetch(MODEL_PROBE, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

let busy = false;

function setBusy(on: boolean): void {
  busy = on;
  if (sendEl) {
    sendEl.disabled = on;
  }
  if (stopEl) {
    stopEl.disabled = !on;
  }
}

export interface SmolagentHandle {
  webgpu(): Promise<{ available: boolean; adapter: boolean; info?: unknown }>;
  /** Swaps in a scripted model. Used by CI, which has no GPU. */
  useFake(scripts: FakeScript[]): void;
  loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
  bootVm(timeoutMs?: number): Promise<Caps>;
  setMount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void;
  send(text: string): Promise<AgentEvent[]>;
  cancel(): void;
  configure(patch: Record<string, number>): void;
  options(): Record<string, unknown>;
  messages(): { role: string; content: string }[];
  reset(): void;
  close(timeoutMs?: number): Promise<void>;
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
  useFake: (scripts: FakeScript[]) => {
    modelClient = new FakeModelClient(scripts);
    setStatus("model: scripted fake");
  },
  loadModel: async (local?: boolean) => {
    const useLocal = local ?? (await haveLocalWeights());
    setStatus(`loading model (${useLocal ? "local" : "hub"})…`);
    const ready = await modelClient.load(useLocal);
    setStatus(`model ready (${ready.source}, ${ready.loadMs}ms)`);
    return ready;
  },
  bootVm: async (timeoutMs?: number) => {
    setStatus("booting the VM…");
    const caps = await session.boot(timeoutMs);
    setStatus(`vm ready (agent v${caps.version})`);
    return caps;
  },
  setMount: (h: DirectoryHandleLike | null, links?: Record<string, string>) => {
    mount.remount(h, links);
    setStatus(h ? "folder mounted at /mnt/host" : "no folder mounted");
  },
  send: async (text: string) => {
    events = [];
    setBusy(true);
    try {
      await convo.send(text);
    } finally {
      setBusy(false);
    }
    return events;
  },
  cancel: () => convo.cancel(),
  configure: (patch) => convo.configure(patch as never),
  options: () => convo.options() as unknown as Record<string, unknown>,
  messages: () => convo.messages(),
  reset: () => {
    convo.reset();
    logEl?.replaceChildren();
  },
  close: (timeoutMs?: number) => session.close(timeoutMs),
};
(globalThis as unknown as Record<string, unknown>).__smolagent = handle;

if (params.get("model") === "fake") {
  handle.useFake(DEMO_SCRIPTS());
}

if (!crossOriginIsolated) {
  setStatus("FAIL: cross-origin isolation required. Serve with COOP/COEP headers.");
}

// A tiny built-in script so the page is explorable without a GPU; CI injects
// its own through useFake().
function DEMO_SCRIPTS(): FakeScript[] {
  return [
    {
      name: "demo",
      turns: [
        { text: `<|tool_call_start|>[${toolName}(cmd="ls -la /mnt/host")]<|tool_call_end|>` },
        { text: "That is what the folder contains." },
      ],
    },
  ];
}

// Reflect the loop's defaults into the settings inputs, and read them back.
const optionInputs: Record<string, string> = {
  "opt-iterations": "maxIterations",
  "opt-maxoutput": "perCallMaxOutput",
  "opt-history": "historyBudgetChars",
  "opt-tokens": "maxNewTokens",
};
for (const [id, key] of Object.entries(optionInputs)) {
  const input = el(id);
  if (!input) {
    continue;
  }
  input.value = String((convo.options() as unknown as Record<string, number>)[key]);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    if (Number.isFinite(n) && n > 0) {
      convo.configure({ [key]: n } as never);
    }
  });
}

el("composer")?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault?.();
    void submit();
  }
});
sendEl?.addEventListener("click", (ev) => {
  ev.preventDefault?.();
  void submit();
});
stopEl?.addEventListener("click", () => handle.cancel());

async function submit(): Promise<void> {
  const text = promptEl?.value?.trim();
  if (!text || busy) {
    return;
  }
  if (promptEl) {
    promptEl.value = "";
  }
  try {
    await handle.send(text);
    setStatus("ready");
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

startEl?.addEventListener("click", async () => {
  if (busy) {
    return;
  }
  setBusy(true);
  try {
    if (params.get("model") !== "fake") {
      const gpu = await handle.webgpu();
      if (!gpu.adapter) {
        setStatus("FAIL: no WebGPU adapter in this browser");
        return;
      }
    }
    if (!mount.mounted()) {
      handle.setMount(await getOpfsDirectoryHandle());
    }
    await handle.bootVm();
    await handle.loadModel();
    setStatus("ready — ask something");
  } catch (err) {
    setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setBusy(false);
  }
});

pickEl?.addEventListener("click", async () => {
  try {
    handle.setMount(await pickDirectoryHandle());
  } catch (err) {
    setStatus(`pick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

setBusy(false);
