// The /scan/ page: run Antares over a mounted folder and read what it found.
//
// Deliberately not the chat page with a different prompt. A localization run has
// a shape chat does not: one task, a hard call budget, a termination protocol,
// and an answer that is a ranked list rather than a message. The trajectory is
// the product here — at 0.135 File F1 the commands are how a person decides
// whether a finding is worth opening (PLAN §11.5), so they are the main column,
// not a collapsible detail.

import { MountHost } from "../fsbridge/main-host.ts";
import { getOpfsDirectoryHandle, pickDirectoryHandle } from "../mount.ts";
import { Session } from "../session.ts";
import type { ToolSession } from "../tool.ts";
import { OpExec } from "../protocol.ts";
import { buildSystemPrompt, buildTaskMessage, resolveTerminalBudget } from "./antares-prompt.ts";
import { dialectFor } from "./dialects/index.ts";
import { FakeModelClient, type FakeScript } from "./fake-model.ts";
import { antaresHostTools, hostToolDefinition } from "./host-tools.ts";
import { LOCALIZE_DEFAULTS, LocalizeRun, type LocalizeEvent, type LocalizeResult } from "./localize.ts";
import { WorkerModelClient, type ModelClient } from "./model-client.ts";
import { modelFor, pickDtype } from "./models.ts";
import type { ParsedCall } from "./parse.ts";
import { ANTARES_TERMINAL, profiledDefinition } from "./tool-profile.ts";
import { ToolRegistry } from "./tool-registry.ts";

// The CLI's default focus set. A curated list, not a CWE database: porting
// `antares plan`'s repository profiling is a second system and explicitly out of
// scope for this milestone (PLAN §11.5).
const CWES: { id: string; name: string }[] = [
  { id: "CWE-89", name: "SQL Injection" },
  { id: "CWE-78", name: "OS Command Injection" },
  { id: "CWE-79", name: "Cross-site Scripting" },
  { id: "CWE-22", name: "Path Traversal" },
  { id: "CWE-798", name: "Hardcoded Credentials" },
  { id: "CWE-502", name: "Deserialization of Untrusted Data" },
  { id: "CWE-306", name: "Missing Authentication" },
  { id: "CWE-20", name: "Improper Input Validation" },
  { id: "CWE-400", name: "Uncontrolled Resource Consumption" },
];

const MODEL_KEY = "antares-1b";

const el = (id: string) => document.getElementById(id);
const need = (id: string) => {
  const node = el(id);
  if (!node) {
    throw new Error(`scan: #${id} missing from the page`);
  }
  return node;
};

const vmWorker = new Worker("/worker.js", { type: "module" });
const session = new Session(vmWorker);
const mount = new MountHost();

vmWorker.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; sab?: SharedArrayBuffer; loaded?: number; total?: number };
  if (msg.type === "fschannel" && msg.sab) {
    mount.attach(msg.sab);
  } else if (msg.type === "fsreq") {
    mount.serve();
  } else if (msg.type === "progress" && typeof msg.loaded === "number" && msg.total) {
    status(`loading smolbox.wasm… ${Math.min(100, Math.round((msg.loaded / msg.total) * 100))}%`);
  }
});

let model: ModelClient | null = null;
let run: LocalizeRun | null = null;
let booted = false;
let running = false;

function status(text: string): void {
  need("status").textContent = text;
}

// ------------------------------------------------------------------ rendering

const trajectory = () => need("trajectory");

/**
 * Appends one entry, built as DOM nodes.
 *
 * Everything rendered here is model output or command output, and every value
 * goes in through `textContent`. That is not a style preference: hand-rolled
 * HTML escaping around untrusted strings is a bug waiting to happen, and there
 * is no reason to take the risk when building nodes is the same amount of code.
 * `body` is a `<pre>` when the content is command output, so its whitespace
 * survives.
 */
function add(cls: string, label: string, body: string, pre = false): void {
  const box = trajectory();
  // The empty-state copy explains what this pane is for; it goes the moment
  // there is something real to show.
  const placeholder = el("traj-empty");
  if (placeholder) {
    box.replaceChildren();
  }

  const node = document.createElement("div");
  node.className = `entry ${cls}`;

  const head = document.createElement("span");
  head.className = "label";
  head.textContent = label;
  node.appendChild(head);

  const text = document.createElement(pre ? "pre" : "div");
  text.textContent = body;
  node.appendChild(text);

  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
}

function renderEvent(ev: LocalizeEvent): void {
  captured.push(ev);
  switch (ev.kind) {
    case "task":
      add("task", "task", ev.text);
      break;
    case "thinking":
      if (ev.text.trim()) {
        add("thinking", "reasoning", ev.text);
      }
      break;
    case "tool-start": {
      add("cmd", `command · ${ev.remaining} left`, String(ev.call.args.command ?? ev.call.args.cmd ?? ""), true);
      const used = Number(need("calls-max").textContent) - ev.remaining;
      need("calls").textContent = String(used);
      need("phase").textContent = "running a command…";
      break;
    }
    case "tool-end":
      add("out", ev.exitCode === 0 ? "output" : `output · exit ${ev.exitCode}`, ev.rendered, true);
      need("phase").textContent = "thinking…";
      break;
    case "nudge":
      add("nudge", `nudge (${ev.reason})`, ev.text);
      break;
    case "elided":
      add("meta", "context", `elided ${ev.messages} older message(s)`);
      break;
    case "error":
      add("error", "error", ev.message);
      break;
    case "stopped":
      add("meta", "stopped", ev.reason);
      break;
    case "submitted":
      break; // rendered by renderFindings, which has the whole result
    case "token":
      break; // streamed prose is summarised by "thinking"; raw tokens would flood
  }
}

type ScanResult = LocalizeResult;

function para(cls: string, text: string): Element {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

/**
 * A finding, with the commands that named it.
 *
 * PLAN §11.5 asked for this and the first cut shipped without it: a bare ranked
 * path from a 0.135-F1 model is not something a person can act on. The evidence
 * is a reconstruction, not the model's stated reasoning — it never gives one —
 * so it is presented as "these commands mentioned this file", which the reader
 * can check against the trace on the left.
 */
function findingItem(f: ScanResult["findings"][number]): Element {
  const li = document.createElement("li");
  const code = document.createElement("code");
  code.textContent = f.path;
  li.appendChild(code);

  if (f.evidence.length === 0) {
    const none = document.createElement("ul");
    none.className = "evidence";
    const item = document.createElement("li");
    item.textContent = "no command in this run mentioned this file";
    none.appendChild(item);
    li.appendChild(none);
    return li;
  }

  const list = document.createElement("ul");
  list.className = "evidence";
  for (const e of f.evidence) {
    const item = document.createElement("li");
    const cmd = document.createElement("code");
    cmd.textContent = `$ ${e.command}`;
    item.appendChild(cmd);
    if (e.line) {
      const line = document.createElement("span");
      line.className = "out";
      line.textContent = e.line;
      item.appendChild(line);
    }
    list.appendChild(item);
  }
  li.appendChild(list);
  return li;
}

function renderFindings(result: ScanResult): void {
  const box = need("findings");
  const children: Element[] = [];

  if (!result.submitted) {
    children.push(para("none", `No submission. The run ended because: ${result.stoppedBecause}.`));
  } else if (result.findings.length === 0) {
    children.push(para("none", "The model reported no vulnerable files for this CWE."));
  } else {
    const list = document.createElement("ol");
    list.className = "ranked";
    for (const f of result.findings) {
      list.appendChild(findingItem(f));
    }
    children.push(list);
  }

  if (result.rejected.length > 0) {
    // Shown, not hidden: a model at this accuracy hallucinates paths routinely,
    // and "it named files that do not exist" is a signal about the whole run,
    // not an embarrassment to tidy away.
    children.push(
      para(
        "rejected",
        `${result.rejected.length} submitted path(s) did not exist in the folder and were dropped: ` +
          result.rejected.join(", "),
      ),
    );
  }
  children.push(
    para(
      "meta",
      `${result.terminalCallsUsed} command(s), ${(result.elapsedMs / 1000).toFixed(1)}s.`,
    ),
  );

  box.replaceChildren(...children);
  need("export").removeAttribute("disabled");
  lastResult = result;
}

let lastResult: ScanResult | null = null;
/** Events from the current run, for the Playwright handle below. */
let captured: LocalizeEvent[] = [];

// ------------------------------------------------------------------- the run

/** Adapts the tool registry to the ToolRunner the loop expects. */
function toolRunner(registry: ToolRegistry, s: ToolSession) {
  return {
    async run(call: ParsedCall, opts: { maxOutput: number }) {
      const { text, response, request } = await registry.run(s, call, { maxOutput: opts.maxOutput });
      return { text, exitCode: response.exit_code ?? 0, request };
    },
  };
}

/**
 * Resolves a submitted path against the real mounted tree.
 *
 * Uses the guest rather than the host handle, so it checks what the model
 * actually had access to — the same mount, through the same bridge.
 */
function pathChecker(s: ToolSession) {
  return async (path: string): Promise<boolean> => {
    const res = await s.exec({
      op: OpExec,
      // JSON.stringify is the quoting here: a submitted path is model output,
      // and `sh -c` would otherwise read `; rm -rf /` in a "file name" as
      // instructions. The sandbox makes that survivable, not acceptable.
      cmd: `test -f ${JSON.stringify(`/mnt/host/${path}`)}`,
      timeout_ms: 5000,
    });
    return (res.exit_code ?? 1) === 0;
  };
}

// ------------------------------------------------------- readiness & progress

type StepState = "todo" | "active" | "done" | "failed";

function setStep(id: "vm" | "folder" | "model", state: StepState): void {
  const node = need(`step-${id}`);
  node.setAttribute("data-state", state);
  const mark = node.children[0];
  if (mark) {
    mark.textContent = { todo: "\u25cb", active: "\u25cc", done: "\u25cf", failed: "\u2715" }[state];
  }
}

function showProgress(on: boolean, pct = 0, text = ""): void {
  need("progress-wrap").setAttribute("data-on", on ? "1" : "0");
  need("progress").value = String(pct);
  need("progress-text").textContent = text;
}

function human(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Everything the scan needs, done in order, skipping what is already there.
 *
 * The page used to present this as four numbered buttons the user had to
 * sequence themselves. It is one button now: the steps strip shows what is
 * still missing, and Scan does it. The model stays the last step because it is
 * 3.7 GB and nobody should pay for it by opening a page.
 */
async function ensureReady(): Promise<boolean> {
  if (!booted) {
    setStep("vm", "active");
    status("booting the VM\u2026");
    try {
      await session.boot();
      booted = true;
      setStep("vm", "done");
    } catch (err) {
      setStep("vm", "failed");
      status(`VM failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  if (!mount.mounted()) {
    setStep("folder", "active");
    status("choose the folder to scan\u2026");
    if (!(await chooseFolder())) {
      setStep("folder", "failed");
      return false;
    }
  }

  if (!model) {
    setStep("model", "active");
    if (!(await loadModel())) {
      setStep("model", "failed");
      return false;
    }
  }
  return true;
}

let ticker: ReturnType<typeof setInterval> | null = null;

function startRunBar(budget: number): void {
  need("runbar").setAttribute("data-on", "1");
  need("calls-max").textContent = String(budget);
  need("calls").textContent = "0";
  need("phase").textContent = "thinking\u2026";
  const started = Date.now();
  ticker = setInterval(() => {
    need("elapsed").textContent = `${Math.round((Date.now() - started) / 1000)}s`;
  }, 500);
}

function stopRunBar(phase: string): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  need("phase").textContent = phase;
}

async function startScan(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  need("run").setAttribute("disabled", "true");
  try {
    if (!(await ensureReady())) {
      return;
    }

    const cwe = need("cwe").value;
    const budget = Number(need("budget").value);

    need("findings").replaceChildren();
    trajectory().replaceChildren();
    need("export").setAttribute("disabled", "true");
    need("stop").removeAttribute("disabled");
    startRunBar(budget);
    status(`scanning for ${cwe}\u2026`);

    const registry = new ToolRegistry();
    const entry = modelFor(MODEL_KEY);

    run = new LocalizeRun(
      {
        systemPrompt: buildSystemPrompt({ terminalBudget: budget }),
        taskMessage: buildTaskMessage([cwe]),
        tools: [profiledDefinition(ANTARES_TERMINAL), ...antaresHostTools.map(hostToolDefinition)],
        dialect: dialectFor(entry.dialect),
        profile: ANTARES_TERMINAL,
        hostTools: antaresHostTools,
        terminalBudget: budget,
        maxIterations: LOCALIZE_DEFAULTS.maxIterations,
        perCallMaxOutput: LOCALIZE_DEFAULTS.perCallMaxOutput,
        maxNewTokens: LOCALIZE_DEFAULTS.maxNewTokens,
        historyBudgetChars: LOCALIZE_DEFAULTS.historyBudgetChars,
        checkPath: pathChecker(session as unknown as ToolSession),
      },
      model!,
      toolRunner(registry, session as unknown as ToolSession),
      renderEvent,
    );

    try {
      const result = await run.run();
      renderFindings(result);
      stopRunBar(result.submitted ? "submitted" : "ended without a submission");
      status(result.submitted ? "done" : "done \u2014 no submission");
    } catch (err) {
      add("error", "error", err instanceof Error ? err.message : String(err));
      stopRunBar("failed");
      status("failed");
    }
  } finally {
    running = false;
    need("run").removeAttribute("disabled");
    need("stop").setAttribute("disabled", "true");
  }
}

// ------------------------------------------------------------------- wiring

function populateCwes(): void {
  const select = need("cwe");
  for (const { id, name } of CWES) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${id} \u2014 ${name}`;
    select.appendChild(opt);
  }
}

async function chooseFolder(): Promise<boolean> {
  try {
    // OPFS is the fallback so a headless run (no picker, no user gesture) can
    // still mount a tree — that is what makes the CI suite possible.
    const handle = await pickDirectoryHandle().catch(() => getOpfsDirectoryHandle());
    mount.remount(handle);
    setStep("folder", "done");
    need("change-folder").textContent = "Change folder…";
    status("folder mounted read-only at /mnt/host");
    return true;
  } catch (err) {
    status(`could not open that folder: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function loadModel(): Promise<boolean> {
  // A scripted model is selectable so the page is drivable in CI with no GPU,
  // which is the only reason any of this has automated coverage (PLAN §10.2).
  // location.search rather than URL: the DOM shim exposes only that.
  const scripted = new URLSearchParams(location.search).get("fake");
  if (scripted) {
    model = new FakeModelClient(JSON.parse(decodeURIComponent(scripted)) as FakeScript[]);
    await model.load();
    setStep("model", "done");
    status("scripted model ready");
    return true;
  }

  const entry = modelFor(MODEL_KEY);
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    status("this browser has no WebGPU adapter \u2014 Antares cannot run here");
    return false;
  }
  const dtype = pickDtype(entry, new Set<string>([...adapter.features]));
  if (!dtype) {
    status("no supported precision for this GPU");
    return false;
  }

  // A 3.7 GB load is the longest wait in the app by a wide margin. A single
  // status line that a filename overwrites is not feedback; a bar with bytes on
  // it is the difference between "working" and "hung".
  showProgress(true, 0, `0 / ${human(entry.approxBytes)}`);
  status(`loading ${entry.label} \u2014 first run only, then it is cached on disk`);
  const seen = new Map<string, number>();
  const worker = new Worker("/agent/model-worker.js", { type: "module" });
  model = new WorkerModelClient(
    worker,
    (line) => console.log(line),
    (file, pct) => {
      seen.set(file, pct);
      const overall = Math.round([...seen.values()].reduce((a, b) => a + b, 0) / seen.size);
      showProgress(true, overall, `${overall}% of ${human(entry.approxBytes)}`);
    },
  );

  try {
    const ready = await model.load(true, { modelKey: entry.key, dtype });
    showProgress(false);
    setStep("model", "done");
    need("model-note").textContent =
      ` Loaded ${entry.label} at ${dtype} from ${ready.source} in ${(ready.loadMs / 1000).toFixed(1)}s.`;
    status("model ready");
    return true;
  } catch (err) {
    showProgress(false);
    model = null;
    const message = err instanceof Error ? err.message : String(err);
    status(message.includes("make antares-onnx") ? message : `model failed to load: ${message}`);
    return false;
  }
}

function exportJson(): void {
  const json = JSON.stringify(lastResult, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", "smolbox-scan.json");
  a.click();
  URL.revokeObjectURL(url);
}

// The handle Playwright drives, mirroring agent-main's `__smolagent`. It is how
// the whole localization protocol gets CI coverage on a GPU-less runner: the
// page, the loop, the dialect and a real VM all run, and only the matrix
// multiplication is replaced (PLAN §2.11.24).
interface ScanTestHandle {
  useFake(scripts: FakeScript[]): void;
  bootVm(timeoutMs?: number): Promise<{ version: string }>;
  setMount(handle: unknown, links?: Record<string, string>): void;
  scan(cwe: string, budget?: number): Promise<ScanResult>;
  events(): LocalizeEvent[];
  cancel(): void;
  close(timeoutMs?: number): Promise<void>;
}

(globalThis as unknown as { __smolscan: ScanTestHandle }).__smolscan = {
  useFake: (scripts) => {
    model = new FakeModelClient(scripts);
    setStep("model", "done");
  },
  bootVm: async (timeoutMs?: number) => {
    const caps = await session.boot(timeoutMs);
    booted = true;
    setStep("vm", "done");
    return caps;
  },
  setMount: (handle, links) => {
    // The symlink table travels with the handle: the bridge presents symlinks
    // through a virtual table rather than the OPFS tree, which has none.
    mount.remount(handle as never, links);
    setStep("folder", "done");
    need("change-folder").textContent = "Change folder…";
  },
  scan: async (cwe, budget) => {
    need("cwe").value = cwe;
    if (budget !== undefined) {
      need("budget").value = String(budget);
    }
    captured = [];
    await startScan();
    return (
      lastResult ?? {
        submitted: false,
        findings: [],
        rejected: [],
        terminalCallsUsed: 0,
        stoppedBecause: "no result",
        elapsedMs: 0,
      }
    );
  },
  events: () => captured,
  cancel: () => run?.cancel(),
  close: (timeoutMs?: number) => session.close(timeoutMs),
};

populateCwes();
need("run").addEventListener("click", () => void startScan());
need("stop").addEventListener("click", () => {
  run?.cancel();
  status("stopping\u2026");
});
need("change-folder").addEventListener("click", () => void chooseFolder());
need("export").addEventListener("click", exportJson);

status("ready \u2014 choose a CWE and press Scan");
