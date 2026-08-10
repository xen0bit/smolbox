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
  dtypeBlockers,
  modelFor,
  models,
  pickDtype,
} from "./models.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import { requestPersistence } from "./model-cache.ts";
import { Settings } from "./settings.ts";
import type { ModelClient } from "./model-client.ts";
import { WorkerModelClient } from "./model-client.ts";
import type { ParsedCall, StreamPreview } from "./parse.ts";
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
  const msg = ev.data as {
    type?: string;
    message?: string;
    sab?: SharedArrayBuffer;
    loaded?: number;
    total?: number;
  };
  switch (msg.type) {
    case "fschannel":
      if (msg.sab) {
        mount.attach(msg.sab);
      }
      break;
    case "fsreq":
      mount.serve();
      break;
    case "progress":
      // smolbox.wasm is ~110 MiB; the VM boots inside session.boot().
      if (typeof msg.loaded === "number" && msg.total) {
        setStatus(`loading smolbox.wasm… ${Math.min(100, Math.round((msg.loaded / msg.total) * 100))}%`);
      }
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

/**
 * The status line, and what state it is in.
 *
 * The text was always there; what was missing is that "loading Qwen3 1.7B" and
 * "FAIL: cross-origin isolation required" looked identical at a glance. The
 * state is inferred from the message rather than passed by every caller — there
 * are ~20 call sites and threading a second argument through all of them would
 * be a lot of edits for a colour.
 */
function setStatus(text: string): void {
  console.log("[smolagent]", text);
  if (!statusEl) {
    return;
  }
  statusEl.textContent = text;
  const lower = text.toLowerCase();
  const state = /^(fail|error)|\berror\b|failed/.test(lower)
    ? "error"
    : /loading|booting|generating|…/.test(lower)
      ? "loading"
      : /ready/.test(lower)
        ? "ready"
        : "idle";
  statusEl.setAttribute("data-state", state);
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

const settings = new Settings({
  configure: (patch) => convo.configure(patch),
  model: () => modelFor(currentModelKey),
  defaultSystemPrompt: SYSTEM_PROMPT,
});

// The raw completion for the turn in flight. The preview is recomputed from the
// whole buffer rather than appended to, because whether a chunk is prose depends
// on markers that may only close several chunks later.
let turnRaw = "";
// The tool bubble opened at tool-start and completed at tool-end. A command can
// take seconds inside the VM, and an empty log for those seconds reads as a hang.
let pendingTool: { body: Element; out: Element } | null = null;

function onEvent(ev: AgentEvent): void {
  events.push(ev);
  switch (ev.kind) {
    case "user":
      bubble("user", "you")!.textContent = ev.text;
      endStream();
      break;
    case "token": {
      turnRaw += ev.text;
      renderStream(convo.options().dialect.preview(turnRaw));
      break;
    }
    case "assistant":
      // The parsed turn supersedes the preview: same content, but split by a
      // parser that has seen the whole completion rather than a prefix of it.
      finishStream(ev.text, ev.reasoning ?? "", ev.toolCalls);
      break;
    case "tool-start": {
      endStream();
      const body = bubble("tool", "tool · running…");
      if (body) {
        const cmd = document.createElement("span");
        cmd.className = "cmd";
        cmd.textContent = `$ ${String(ev.call.args.cmd ?? ev.call.name)}`;
        const out = document.createElement("span");
        out.className = "pending";
        out.textContent = "waiting for the guest…";
        body.appendChild(cmd);
        body.appendChild(out);
        pendingTool = { body, out };
      }
      break;
    }
    case "tool-end": {
      const cmdText = `$ ${ev.request?.cmd ?? String(ev.call.args.cmd ?? "")}`;
      const label = `tool · exit ${ev.exitCode}`;
      if (pendingTool) {
        setLabel(pendingTool.body, label, ev.exitCode === 0 ? "tool" : "tool bad");
        (pendingTool.body.firstChild as Element).textContent = cmdText;
        pendingTool.out.className = "";
        pendingTool.out.textContent = ev.rendered;
        pendingTool = null;
        break;
      }
      const body = bubble(ev.exitCode === 0 ? "tool" : "tool bad", label);
      if (body) {
        const cmd = document.createElement("span");
        cmd.className = "cmd";
        cmd.textContent = cmdText;
        const out = document.createElement("span");
        out.textContent = ev.rendered;
        body.appendChild(cmd);
        body.appendChild(out);
      }
      break;
    }
    case "elided":
      bubble("note", "context")!.textContent =
        `trimmed ${ev.messages} older message(s) to stay inside this model's prompt budget (now ~${ev.chars} chars)`;
      break;
    case "budget":
      endStream();
      if (ev.reason === "device-lost") {
        // The retry is about to sit through a full reload, so say what is
        // happening — otherwise it reads as a hang partway through an answer.
        setStatus("rebuilding the model session after a GPU error…");
        bubble("note", "gpu")!.textContent =
          `the GPU ran out of memory prefilling ~${ev.was} chars of prompt, which takes the inference ` +
          `session with it. Rebuilding it and retrying this turn with a ${ev.chars}-char budget; ` +
          `this model will start there on this machine from now on.`;
        // A device loss is the only hard evidence anyone has about what this
        // GPU can really prefill — the registry's ceiling is arithmetic from a
        // different machine. Keep it.
        settings.recordDeviceCeiling(ev.chars);
      } else {
        bubble("note", "context")!.textContent =
          `~${ev.was} chars was more prompt than this model would take; retrying the turn with a ` +
          `${ev.chars}-char budget.`;
      }
      break;
    case "stopped":
      endStream();
      bubble("note", "stopped")!.textContent =
        ev.reason === "iteration-cap"
          ? "stopped: hit the tool-call limit for this turn"
          : "stopped by you";
      break;
    case "error":
      endStream();
      bubble("error", "error")!.textContent = ev.message;
      break;
  }
}

/**
 * The live view of the turn in flight.
 *
 * Three things can be true at once and each gets its own place: prose is the
 * answer and streams as text, reasoning is collapsed behind a summary so a
 * model that thinks for a page does not bury the reply, and a tool call that
 * has opened but not closed is a status line rather than half of its own
 * syntax. That last one is what made the parsing look broken from the outside:
 * the markers streamed into the chat as prose until the block completed.
 */
function renderStream(p: StreamPreview): void {
  if (!streaming) {
    streaming = bubble("assistant", "model");
  }
  if (!streaming) {
    return;
  }
  const think = p.reasoning ? thinkingBlock(streaming) : null;
  if (think) {
    think.body.textContent = p.reasoning;
    think.summary.textContent = `thinking… (${p.reasoning.length} chars)`;
  }
  proseNode(streaming).textContent = p.text;
  statusNode(streaming).textContent = p.pendingCall ? "preparing a tool call…" : "";
  scrollLog();
}

/**
 * Replaces the live view with the parsed one and closes the bubble.
 *
 * `toolCalls` only affects what the reasoning summary says. A reasoning model
 * calling a tool produces a turn with no prose in it at all, which is a working
 * turn and used to be labelled "stopped without answering" — describing the
 * normal shape of an agentic turn as a failure, once per tool call.
 */
function finishStream(text: string, reasoning: string, toolCalls = 0): void {
  if (!streaming && !text && !reasoning) {
    return;
  }
  if (!streaming) {
    streaming = bubble("assistant", "model");
  }
  if (!streaming) {
    return;
  }
  statusNode(streaming).textContent = "";
  proseNode(streaming).textContent = text;
  if (reasoning) {
    const think = thinkingBlock(streaming);
    think.body.textContent = reasoning;
    think.summary.textContent = text
      ? `thought first (${reasoning.length} chars)`
      : toolCalls > 0
        ? `thought for ${reasoning.length} chars, then called ${toolCalls === 1 ? "a tool" : `${toolCalls} tools`}`
        : `thought for ${reasoning.length} chars, then stopped without answering`;
  }
  endStream();
}

function endStream(): void {
  // A turn that was only a tool call leaves an empty bubble behind — a "MODEL"
  // label with nothing under it, which is the kind of artefact that makes a
  // working page look unfinished.
  if (streaming && !streaming.textContent?.trim()) {
    streaming.parentElement?.remove();
  }
  streaming = null;
  turnRaw = "";
}

// The assistant bubble's body holds up to three children, created on demand and
// always in this order: reasoning, prose, status.
function thinkingBlock(body: Element): { summary: Element; body: Element } {
  const existing = body.querySelector(".think");
  if (existing) {
    return {
      summary: existing.querySelector("summary")!,
      body: existing.querySelector(".think-body")!,
    };
  }
  const details = document.createElement("details");
  details.className = "think";
  const summary = document.createElement("summary");
  const inner = document.createElement("div");
  inner.className = "think-body";
  details.appendChild(summary);
  details.appendChild(inner);
  body.insertBefore(details, body.firstChild);
  return { summary, body: inner };
}

function childNode(body: Element, cls: string): Element {
  const existing = body.querySelector(`.${cls}`);
  if (existing) {
    return existing;
  }
  const node = document.createElement("div");
  node.className = cls;
  body.appendChild(node);
  return node;
}

const proseNode = (body: Element) => childNode(body, "prose");
const statusNode = (body: Element) => childNode(body, "pending");

function setLabel(body: Element, text: string, cls: string): void {
  const wrap = body.parentElement;
  if (!wrap) {
    return;
  }
  wrap.className = `msg ${cls}`;
  const who = wrap.querySelector(".who");
  if (who) {
    who.textContent = text;
  }
}

function scrollLog(): void {
  if (logEl) {
    logEl.scrollTop = logEl.scrollHeight;
  }
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
// on the adapter, which varies by GPU and platform far more than by browser —
// no browser on this machine has it, Windows and macOS do (PLAN §2.11.24, §10.14).
async function adapterFeatures(): Promise<ReadonlySet<string>> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = (await gpu?.requestAdapter()) as { features?: Iterable<string> } | undefined;
  return new Set(adapter?.features ? [...adapter.features] : []);
}

/**
 * Says out loud when the selected entry is not a chat model.
 *
 * Antares is trained for one job, with a fixed termination protocol, and the
 * registry has always known that (`task: "localize"`). The chat dropdown listed
 * it anyway with nothing to distinguish it from LFM2 — which is precisely the
 * "confident nonsense" the registry comment warns about, offered as though it
 * were a supported choice. The scan page is where it belongs and is one link
 * away, so say so before the weights are fetched rather than after.
 */
function noteModelChoice(entry: ModelEntry): void {
  if (entry.task !== "localize") {
    return;
  }
  const body = bubble("note", "not a chat model");
  if (body) {
    body.textContent =
      `${entry.label} is trained for vulnerability localization, not conversation — it expects one ` +
      `task and a fixed way of finishing it. The scan page at /scan/ is built around that protocol. ` +
      `Loading it here will produce fluent answers that mean very little.`;
  }
}

let busy = false;
// Two separate readiness facts, because they fail for different reasons and the
// composer should say which one is missing rather than accepting a message and
// answering it with "generate before ready".
let vmReady = false;
let modelReady = false;

function setBusy(on: boolean): void {
  busy = on;
  refreshControls();
}

function refreshControls(): void {
  const ready = vmReady && modelReady;
  if (sendEl) {
    sendEl.disabled = busy || !ready;
  }
  if (stopEl) {
    stopEl.disabled = !busy;
  }
  if (startEl) {
    startEl.disabled = busy;
    startEl.textContent = ready ? "reload model" : "start";
  }
  if (promptEl) {
    promptEl.setAttribute(
      "placeholder",
      busy
        ? "working…"
        : ready
          ? "ask about the mounted folder…"
          : vmReady
            ? "press start to load the model"
            : "press start to boot the VM and load a model",
    );
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
  /** Loose on purpose: the settings panel sends strings and objects too. */
  configure(patch: Record<string, unknown>): void;
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

    const features = await adapterFeatures();
    // Checked before anything is fetched. The kernel backend would otherwise
    // stream 2.5 GB onto the GPU and fail on the first forward pass with "No
    // supported WebGPU variant", which reads as a bug rather than as an
    // unsupported adapter.
    const missing = (entry.requiresFeatures ?? []).filter((f) => !features.has(f));
    if (missing.length > 0) {
      // Naming a working alternative matters more than naming the cause:
      // shader-f16 is missing on every browser on some perfectly good GPUs
      // (PLAN §10.14), and "try a desktop browser" is advice that does not work
      // there. The ONNX build of the same model has no such requirement.
      const alternative = models.find(
        (m) => m.key !== entry.key && m.dialect === entry.dialect && (m.requiresFeatures ?? []).length === 0,
      );
      throw new Error(
        `${entry.label} needs the WebGPU feature${missing.length > 1 ? "s" : ""} ` +
          `${missing.join(", ")}, which this adapter does not expose. ` +
          (alternative ? `Try "${alternative.label}", which runs on any WebGPU adapter.` : ""),
      );
    }
    const dtype = pickDtype(entry, features);
    if (!dtype) {
      // Each dtype says why it was skipped rather than the set saying "no".
      // The two causes need opposite responses — a missing adapter feature
      // means try another machine, an oversized inline file means the build
      // needs re-exporting and no machine will help (PLAN §10.18) — and a
      // reader cannot tell them apart from "none of these run here".
      const why = entry.dtypes.flatMap((d) => dtypeBlockers(entry, d, features));
      throw new Error(`${entry.label} cannot run here: ${why.join("; ")}`);
    }
    if (!dialect.verified) {
      bubble("note", "unverified dialect")!.textContent =
        `${dialect.label}: ${dialect.note ?? "never run against the real model"}`;
    }

    const useLocal = local ?? (await haveLocalWeights(entry.repo));
    // Asked for here rather than on page load: this is the moment someone has
    // committed to putting gigabytes on their disk, and Firefox prompts.
    requestPersistence();
    setStatus(`loading ${entry.label} (${dtype}, ${useLocal ? "local" : "hub"})…`);
    const ready = await modelClient.load(useLocal, { modelKey: entry.key, dtype });
    modelReady = true;
    refreshControls();
    setStatus(`${entry.label} ready (${ready.source}, ${dtype}, ${ready.loadMs}ms)`);
    return ready;
  },
  setModel: (key: string) => {
    const entry = modelFor(key);
    currentModelKey = entry.key;
    convo.configure({ dialect: dialectFor(entry.dialect) });
    // Re-derives every knob the user has not taken over — the new checkpoint's
    // token ceiling, prompt budget and sampling. See settings.ts.
    settings.apply();
    // The weights in the worker are still the previous model's, and answering
    // with them under a new dialect would be the worst of both.
    modelReady = false;
    refreshControls();
    noteModelChoice(entry);
    setStatus(`model: ${entry.label} — press start to load it`);
  },
  bootVm: async (timeoutMs?: number) => {
    setStatus("booting the VM…");
    const caps = await session.boot(timeoutMs);
    vmReady = true;
    refreshControls();
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

// The dropdown starts on the default entry without ever firing `change`, so the
// settings have to be applied here too — otherwise the first model anyone loads
// runs on the loop's generic defaults instead of its own ceiling.
settings.apply();

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
    // Loading a 2 GB checkpoint fails for reasons the user can act on — no
    // adapter, no weights, a quantization this GPU cannot run — so the reason
    // goes in the log next to the question it will not be answering.
    const message = err instanceof Error ? err.message : String(err);
    const body = bubble("error", "error");
    if (body) {
      body.textContent = message;
    }
    setStatus(`error: ${message}`);
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

// Populate the model dropdown from the registry, marking unverified dialects so
// an odd answer reads as "we never checked this family" rather than a bug, and
// keeping the task-specific checkpoints in a group of their own so they are not
// presented as chat models that happen to be further down the list.
const modelSelect = el("model");
if (modelSelect) {
  const option = (m: ModelEntry) => {
    const opt = document.createElement("option");
    opt.value = m.key;
    const verified = dialectFor(m.dialect).verified ? "" : " · dialect unverified";
    opt.textContent = `${m.label} (${(m.approxBytes / 1e9).toFixed(2)} GB${verified})`;
    return opt;
  };

  for (const m of models.filter((e) => e.task !== "localize")) {
    modelSelect.appendChild(option(m));
  }
  const special = models.filter((e) => e.task === "localize");
  if (special.length > 0) {
    const group = document.createElement("optgroup");
    group.setAttribute("label", "not chat models — see /scan/");
    for (const m of special) {
      group.appendChild(option(m));
    }
    modelSelect.appendChild(group);
  }

  modelSelect.value = currentModelKey;
  modelSelect.addEventListener("change", () => handle.setModel(modelSelect.value));
}

setBusy(false);
