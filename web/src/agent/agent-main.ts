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
import { getOpfsDirectoryHandle, isPickCancelled, pickDirectoryHandle } from "../mount.ts";
import { toolName } from "../tool.ts";
import { type AgentEvent, Conversation, DEFAULTS, type ToolRunner } from "./conversation.ts";
import { dialectFor } from "./dialects/index.ts";
import {
  DEFAULT_MODEL_KEY,
  type Dtype,
  type ModelEntry,
  maxPromptChars,
  modelFor,
  models,
  pickDtype,
} from "./models.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import type { ModelClient } from "./model-client.ts";
import { WorkerModelClient } from "./model-client.ts";
import type { ParsedCall } from "./parse.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { TemplateTool } from "./user-tools.ts";

let currentModelKey = DEFAULT_MODEL_KEY;

const probeFor = (repo: string) => `/models/${repo}/config.json`;

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

const TOOLS_KEY = "smolbox.tools";
const registry = new ToolRegistry();
try {
  const saved = localStorage.getItem(TOOLS_KEY);
  if (saved) {
    registry.load(JSON.parse(saved));
  }
} catch (err) {
  console.warn("[smolagent] ignoring saved tools:", err);
}

function persistTools(): void {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(registry.snapshot()));
  } catch {
    // Private-mode storage failures must not take the page down.
  }
  convo.configure({ tools: registry.definitions() });
  renderToolList();
}

const runner: ToolRunner = {
  run: async (call: ParsedCall, opts) => {
    const out = await registry.run(session, call, { maxOutput: opts.maxOutput });
    return { text: out.text, exitCode: out.response.exit_code, request: out.request };
  },
};

let events: AgentEvent[] = [];
let streaming: Element | null = null;

const convo = new Conversation(
  {
    systemPrompt: SYSTEM_PROMPT,
    tools: registry.definitions(),
    dialect: dialectFor(modelFor(DEFAULT_MODEL_KEY).dialect),
    ...DEFAULTS,
  },
  {
    load: (local, opts) => modelClient.load(local, opts),
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
        cmd.textContent = `$ ${ev.request?.cmd ?? String(ev.call.args.cmd ?? "")}`;
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

async function haveLocalWeights(repo: string): Promise<boolean> {
  try {
    return (await fetch(probeFor(repo), { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

// The dtype is a runtime question, not a constant: f16 variants need shader-f16
// on the adapter, which headless Chromium lacks and a desktop browser usually
// has (PLAN §2.11.24).
async function adapterFeatures(): Promise<ReadonlySet<string>> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = (await gpu?.requestAdapter()) as { features?: Iterable<string> } | undefined;
  return new Set(adapter?.features ? [...adapter.features] : []);
}

// The loop passes maxNewTokens and promptBudgetChars on every generate, so they
// win over whatever the registry entry declares — which is right for knobs the
// user can turn, and wrong as defaults. A reasoning model that thinks before it
// answers needs more than 512 new tokens or it stops mid-thought every turn; and
// the prompt ceiling is a property of the checkpoint's vocabulary, not a
// preference, because exceeding it kills the WebGPU device rather than the turn
// (models.ts PREFILL_LOGITS_BUDGET_BYTES). Selecting a model moves both knobs to
// that checkpoint's numbers; changing them afterwards still wins.
function applyModelBudgets(entry: ModelEntry): void {
  const tokens = entry.generation?.max_new_tokens;
  if (tokens) {
    convo.configure({ maxNewTokens: tokens });
    setInput("opt-tokens", tokens);
  }
  const budget = maxPromptChars(entry);
  convo.configure({ promptBudgetChars: budget });
  setInput("opt-history", budget);
}

function setInput(id: string, value: number): void {
  const input = el(id);
  if (input) {
    input.value = String(value);
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
  setModel(key: string): void;
  loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
  bootVm(timeoutMs?: number): Promise<Caps>;
  setMount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void;
  send(text: string): Promise<AgentEvent[]>;
  cancel(): void;
  configure(patch: Record<string, number>): void;
  tools(): { name: string; source: string; enabled: boolean }[];
  addTool(tool: TemplateTool): void;
  enableTool(name: string, on: boolean): void;
  setToolDefaults(d: { timeout_ms?: number; max_output?: number; cwd?: string }): void;
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
    const entry = modelFor(currentModelKey);
    const dialect = dialectFor(entry.dialect);
    convo.configure({ dialect });

    const dtype = pickDtype(entry, await adapterFeatures());
    if (!dtype) {
      throw new Error(
        `${entry.label}: none of its quantizations (${entry.dtypes.join(", ")}) run on this adapter`,
      );
    }
    if (!dialect.verified) {
      bubble("note", "unverified dialect")!.textContent =
        `${dialect.label}: ${dialect.note ?? "never run against the real model"}`;
    }

    const useLocal = local ?? (await haveLocalWeights(entry.repo));
    setStatus(`loading ${entry.label} (${dtype}, ${useLocal ? "local" : "hub"})…`);
    const ready = await modelClient.load(useLocal, { modelKey: entry.key, dtype });
    setStatus(`${entry.label} ready (${ready.source}, ${dtype}, ${ready.loadMs}ms)`);
    return ready;
  },
  setModel: (key: string) => {
    const entry = modelFor(key);
    currentModelKey = entry.key;
    convo.configure({ dialect: dialectFor(entry.dialect) });
    applyModelBudgets(entry);
    setStatus(`model: ${entry.label} (not loaded yet)`);
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
  tools: () => registry.list().map((t) => ({ name: t.name, source: t.source, enabled: t.enabled })),
  addTool: (tool: TemplateTool) => {
    registry.addUserTool(tool);
    persistTools();
  },
  enableTool: (name: string, on: boolean) => {
    registry.setEnabled(name, on);
    persistTools();
  },
  setToolDefaults: (d) => {
    registry.setDefaults(d);
    persistTools();
  },
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
  "opt-history": "promptBudgetChars",
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

// The dropdown starts on the default entry without ever firing `change`, so its
// budgets have to be applied here too — otherwise the first model anyone loads
// runs on the loop's generic defaults instead of its own ceiling.
applyModelBudgets(modelFor(DEFAULT_MODEL_KEY));

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
    // The loop turns model and tool failures into `error` events, so reaching
    // here means something outside it broke. Put it in the log anyway: a status
    // line above the fold is not where anyone looks for why a message they just
    // sent produced nothing.
    const message = err instanceof Error ? err.message : String(err);
    const body = bubble("error", "error");
    if (body) {
      body.textContent = message;
    }
    setStatus(`error: ${message}`);
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
    setStatus(
      isPickCancelled(err)
        ? "mount unchanged (no folder chosen)"
        : `pick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

setBusy(false);

// ------------------------------------------------------------------ tools UI

const toolListEl = el("tool-list");
const toolJsonEl = el("tool-json");
const toolMsgEl = el("tool-msg");

function toolMessage(text: string): void {
  if (toolMsgEl) {
    toolMsgEl.textContent = text;
  }
}

function renderToolList(): void {
  if (!toolListEl) {
    return;
  }
  const rows: Element[] = [];
  for (const t of registry.list()) {
    const row = document.createElement("div");
    row.className = "tool-row";

    const box = document.createElement("input");
    box.setAttribute("type", "checkbox");
    if (t.enabled) {
      box.setAttribute("checked", "checked");
    }
    box.addEventListener("change", () => {
      registry.setEnabled(t.name, !t.enabled);
      persistTools();
    });

    const label = document.createElement("span");
    label.textContent = t.name;

    const src = document.createElement("span");
    src.className = "src";
    src.textContent = t.source === "exec" ? "built in · the exec surface" : t.source;

    row.appendChild(box);
    row.appendChild(label);
    row.appendChild(src);

    if (t.source === "user") {
      const del = document.createElement("button");
      del.textContent = "remove";
      del.addEventListener("click", () => {
        registry.removeUserTool(t.name);
        persistTools();
      });
      row.appendChild(del);
    }
    rows.push(row);
  }
  toolListEl.replaceChildren(...rows);
}

el("tool-add")?.addEventListener("click", () => {
  try {
    const parsed = JSON.parse(toolJsonEl?.value ?? "") as TemplateTool;
    registry.addUserTool(parsed);
    persistTools();
    toolMessage(`added ${parsed.name}`);
  } catch (err) {
    toolMessage(err instanceof Error ? err.message : String(err));
  }
});

el("tool-export")?.addEventListener("click", () => {
  if (toolJsonEl) {
    toolJsonEl.value = JSON.stringify(registry.snapshot(), null, 2);
  }
  toolMessage("exported the whole tool state into the box");
});

el("tool-import")?.addEventListener("click", () => {
  try {
    registry.load(JSON.parse(toolJsonEl?.value ?? ""));
    persistTools();
    toolMessage("imported");
  } catch (err) {
    toolMessage(err instanceof Error ? err.message : String(err));
  }
});

renderToolList();

// Populate the model dropdown from the registry, marking unverified dialects
// so an odd answer reads as "we never checked this family" rather than a bug.
const modelSelect = el("model");
if (modelSelect) {
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.key;
    const verified = dialectFor(m.dialect).verified ? "" : " · dialect unverified";
    opt.textContent = `${m.label} (${(m.approxBytes / 1e9).toFixed(2)} GB${verified})`;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = currentModelKey;
  modelSelect.addEventListener("change", () => handle.setModel(modelSelect.value));
}

setBusy(false);
