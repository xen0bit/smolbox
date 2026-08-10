// The WebGPU model, in its own dedicated worker.
//
// This worker is deliberately NOT the VM worker. That one is blocked inside
// wasi.start() for the lifetime of the VM and cannot receive postMessage while
// the module runs (PLAN §2.11.12), so inference cannot share it. transformers.js
// is Promise-based, so this side needs no SharedArrayBuffer or Atomics at all —
// plain postMessage is enough, unlike the stdin and fsbridge channels.

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

import { GemmaKernelEngine } from "./gemma-kernels.ts";
import { ModelCache } from "./model-cache.ts";
import { type ModelErrorCode, type ModelRequest, type ModelResponse, describeError } from "./messages.ts";
import {
  CHAT_TEMPLATE_FILE,
  DEFAULT_MODEL_KEY,
  type Dtype,
  LOCAL_MODEL_PATH,
  type ModelEntry,
  chatTemplateUrl,
  maxPromptTokens,
  modelFor,
} from "./models.ts";

/** A failure the page can act on. See ModelErrorCode. */
class WorkerError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly limitTokens?: number,
  ) {
    super(message);
  }
}

// onnxruntime-web otherwise fetches its wasm from jsdelivr at runtime. Serving
// it from our own origin pins it to the installed version and keeps the page
// working offline once the weights are cached.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = "/ort/";
}

// One per worker. The page holds its own handle to the same IndexedDB database
// for the storage panel — it is origin-scoped, so nothing has to cross the
// worker boundary to read it.
const modelCache = new ModelCache();

// ------------------------------------------------- the duplicate weight fetch
//
// transformers.js downloads every weight file TWICE on a cold load, and the two
// transfers race each other.
//
// The second one is a metadata pre-pass. When `from_pretrained` is given a
// progress_callback it first calls get_file_metadata() for every expected file
// so it can size an aggregate progress bar — and for a *local* path that helper
// does a plain GET, reads Content-Length off the headers, and then drops the
// Response without cancelling it (see utils/model_registry/get_file_metadata.js;
// only the remote branch uses a `bytes=0-0` Range request). Measured against
// dist/models: model_q4.onnx came back as 630 202 bytes served for a 315 101
// byte file, generation_config.json as 292 for 146.
//
// Suppressing the pre-pass is not available to us — it is gated on
// `progress_callback instanceof DefaultProgressCallback`, and that class is not
// exported from the package's browser build — so instead the second caller for
// a URL is handed the FIRST caller's Response. That is safe precisely because
// the pre-pass never touches the body: whoever reads it first (the real load)
// gets the bytes, and only one request leaves the browser. A response somebody
// has already claimed is not shareable, so that case falls straight through to a
// fresh fetch and behaves exactly as it did before.
const SHARE_WINDOW_MS = 60_000;
const shared = new Map<string, Promise<Response>>();
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

env.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const [input, init] = args;
  const method = (init?.method ?? "GET").toUpperCase();
  // A Range request asks for a different representation than a full read, so it
  // must never be answered from — or stored in — the shared slot. This is the
  // hub path's own metadata probe, and the Gemma engine's windowed reads.
  const ranged = new Headers(init?.headers).has("range");
  if (method !== "GET" || ranged) {
    return nativeFetch(...args);
  }

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pending = shared.get(url);
  if (pending) {
    const resp = await pending.catch(() => undefined);
    if (resp && !resp.bodyUsed && !resp.body?.locked) {
      return resp;
    }
    shared.delete(url);
  }

  const started = nativeFetch(...args);
  shared.set(url, started);
  // Only ever a hint that a share is *possible*; the entry is dropped on
  // failure, on a body someone took, and on this timer, so a response nobody
  // came back for cannot pin a stalled connection open for the session.
  const forget = () => {
    if (shared.get(url) === started) {
      shared.delete(url);
    }
  };
  started.catch(forget);
  setTimeout(forget, SHARE_WINDOW_MS);
  return started;
};

// The bundle targets a worker, but web/tsconfig.json deliberately ships no DOM
// lib (see web-globals.d.ts), so the worker scope is reached the same way
// worker.ts reaches it: through globalThis.
const scope = globalThis as unknown as {
  postMessage(msg: ModelResponse): void;
  addEventListener(type: "message", fn: (ev: { data: ModelRequest }) => void): void;
};

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
// The other engine. Exactly one of `model` and `kernels` is ever set; which one
// is decided by the registry entry's backend, and nothing above this worker
// knows the difference.
let kernels: GemmaKernelEngine | null = null;
// The kernel path has no InterruptableStoppingCriteria to hand to a library —
// it is our own loop — so cancellation is a flag it polls.
let cancelRequested = false;
// Remembered from the load so generate() can apply the checkpoint's own
// sampling settings without the page having to pass them on every turn.
let loaded: ModelEntry | null = null;
// The other half of that memory: enough to rebuild the session verbatim if the
// device dies under it. See handleRunFailure.
let lastLoad: { local: boolean; dtype: Dtype } | null = null;
// Set only when the repo keeps its chat template in a standalone file that the
// tokenizer did not pick up. See loadChatTemplate.
let chatTemplate: string | null = null;

// One generation at a time, so one criteria object is enough. It is reset
// before each run rather than recreated, because generate() holds the reference.
const stopper = new InterruptableStoppingCriteria();

function post(msg: ModelResponse): void {
  scope.postMessage(msg);
}

/** The last whole percent reported for each file, so a repeat can be dropped. */
const reported = new Map<string, number>();

/**
 * One progress message per whole percent per file.
 *
 * transformers.js calls its progress_callback once per *network read*, and
 * Firefox hands those over in ~26 KB pieces: a cold local load of LFM2.5 2.6B
 * fired 28 739 of them, measured. Every one became a postMessage, a
 * console.log and a DOM write on the page, which is why the console filled with
 * hundreds of identical "…: 1%" lines and why the download appeared to crawl —
 * the page could not drain the queue as fast as the worker filled it.
 *
 * web/src/worker.ts has throttled the smolbox.wasm download this way since it
 * was written (`pct !== lastPct`); this path never did. A percent is the finest
 * granularity any of the three consumers can show, so nothing is lost: the same
 * load now sends at most 101 messages per file.
 */
function postProgress(file: string, pct: number): void {
  if (reported.get(file) === pct) {
    return;
  }
  reported.set(file, pct);
  post({ type: "progress", file, pct });
}

async function load(local: boolean, modelKey: string, dtype: Dtype): Promise<void> {
  const entry = modelFor(modelKey);
  // A second load — another checkpoint, or the rebuild after a device loss —
  // reports its own files from zero rather than being deduplicated against the
  // percentages the previous one left behind.
  reported.clear();
  loaded = entry;
  lastLoad = { local, dtype };
  // A locally-built checkpoint has no hub copy to fall back to, so failing here
  // with the build command beats a 404 from deep inside transformers.js.
  if (entry.local && !local) {
    throw new Error(
      `${entry.label} is built locally, not downloaded: run \`make antares-onnx\` ` +
        `to produce dist/models/${entry.repo}, then reload.`,
    );
  }
  // Local weights come from dist/models via the dev server; the hub is the
  // fallback so the page still works for someone who has not run `make model`.
  env.allowLocalModels = local;
  env.allowRemoteModels = !local;
  if (local) {
    env.localModelPath = LOCAL_MODEL_PATH;
  }
  // Weights are cached in IndexedDB, in chunks, on BOTH paths. Cache Storage
  // cannot take a 1.2 GB entry (the put fails with an opaque "Unexpected
  // internal error") and the HTTP cache underneath it will not hold a file this
  // size either, so before this the local path re-downloaded every checkpoint on
  // every reload — the served-from-disk argument for not caching only holds for
  // the server, not for the browser that has to pull it over again. See
  // model-cache.ts. getCache() prefers the custom cache over both others.
  env.useCustomCache = true;
  env.customCache = modelCache;
  env.useBrowserCache = false;

  const started = performance.now();
  // The revision is passed so the hub path honours the pin the registry exists
  // to hold; it is ignored for a local load, where the path carries no revision.
  //
  // The tokenizer is loaded the same way for BOTH backends. The kernel engine
  // has one of its own, but it renders the chat template with `tools: null` and
  // decodes with skip_special_tokens — neither of which this project can use, so
  // the prompt and the decode come from here regardless of what runs the
  // forward pass. See gemma-kernels.ts.
  tokenizer = await AutoTokenizer.from_pretrained(entry.repo, { revision: entry.revision });
  chatTemplate = await loadChatTemplate(entry, local);

  if (entry.backend === "gemma4-kernels") {
    kernels = await GemmaKernelEngine.load(entry.repo, entry.revision, local, LOCAL_MODEL_PATH, (p) => {
      if (typeof p.fraction === "number") {
        postProgress(p.message ?? "weights", Math.round(p.fraction * 100));
      }
    });
    post({ type: "log", message: `gemma kernels on ${kernels.info()}` });
  } else {
    try {
      model = await loadWeights(entry, dtype);
    } catch (err) {
      throw describeLoadFailure(err, entry, dtype);
    }
  }

  post({
    type: "ready",
    source: local ? "local" : "hub",
    loadMs: Math.round(performance.now() - started),
    modelKey: entry.key,
    dtype,
  });
}

function loadWeights(entry: ModelEntry, dtype: Dtype): Promise<PreTrainedModel> {
  return AutoModelForCausalLM.from_pretrained(entry.repo, {
    device: "webgpu",
    revision: entry.revision,
    // The dtype is chosen by the page against the adapter's feature list, not
    // hardcoded: f16 variants need shader-f16, which no browser on this machine
    // exposes but other GPUs and platforms do (PLAN §2.11.24, §10.14).
    dtype,
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === "progress" && p.file && typeof p.progress === "number") {
        postProgress(p.file, Math.round(p.progress));
      }
    },
  }) as Promise<PreTrainedModel>;
}

/**
 * Turns a failed weight load into something a reader can act on.
 *
 * transformers.js reads a weight file into a single Uint8Array before
 * onnxruntime sees any of it, so a checkpoint published as one large .onnx with
 * no external data blob fails in `readResponse` with a bare
 * "RangeError: Array buffer allocation failed" — nine frames deep, naming
 * neither the model nor the file nor the size. Qwen3 1.7B's q4 build (2.147 GB
 * in one file) does exactly this. The registry now prefers its q4f16 build for
 * that reason; this message is for the next checkpoint that does it.
 */
function describeLoadFailure(err: unknown, entry: ModelEntry, dtype: Dtype): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (!/allocation failed|out of memory|bad_alloc|Array buffer/i.test(message)) {
    return err instanceof Error ? err : new Error(message);
  }
  const others = entry.dtypes.filter((d) => d !== dtype);
  return new Error(
    `${entry.label} at ${dtype} could not be allocated (${message}). Its weights are read into one ` +
      `buffer before onnxruntime sees them, so a single-file checkpoint this large cannot be loaded ` +
      `in a browser at all` +
      (others.length > 0 ? `; a smaller quantization (${others.join(", ")}) may fit.` : "."),
  );
}

/**
 * Reads the standalone chat_template.jinja, for repos that have no inline one.
 *
 * transformers.js' AutoTokenizer only ever reads `chat_template` out of
 * tokenizer_config.json: the standalone file is loaded by Processor, on the
 * multimodal path, and by nothing else. A repo that keeps its template only in
 * that file therefore loads fine and then throws inside apply_chat_template on
 * the first turn — which is what the locally-built Antares did on the scan page,
 * because `make antares-onnx` copies the file across verbatim and the Python
 * side of the conversion reads it (Python transformers does load it).
 *
 * Absence is not an error: the two LFM2 repos inline their templates and never
 * reach this, and a repo with neither will fail in apply_chat_template with a
 * message that says so, which is the right place for it.
 */
async function loadChatTemplate(entry: ModelEntry, local: boolean): Promise<string | null> {
  if ((tokenizer as { chat_template?: unknown } | null)?.chat_template) {
    return null;
  }
  try {
    const res = await fetch(chatTemplateUrl(entry, local));
    if (!res.ok) {
      return null;
    }
    const text = await res.text();
    post({ type: "log", message: `chat template: ${CHAT_TEMPLATE_FILE} (${text.length} chars)` });
    return text;
  } catch {
    return null;
  }
}

async function generate(req: Extract<ModelRequest, { type: "generate" }>): Promise<void> {
  if (!tokenizer || !(model || kernels)) {
    // Either nothing was ever loaded — an error — or a device loss dropped the
    // session and this is the request that pays for rebuilding it.
    await reload();
  }
  if (!tokenizer || !(model || kernels)) {
    throw new Error("generate before ready");
  }
  stopper.reset();
  cancelRequested = false;

  const prompt = tokenizer.apply_chat_template(req.messages, {
    tools: req.tools,
    tokenize: false,
    add_generation_prompt: true,
    // Only set when the tokenizer had none of its own, so a repo that inlines
    // its template keeps using the one transformers.js already parsed.
    ...(chatTemplate ? { chat_template: chatTemplate } : {}),
  }) as string;

  const inputs = tokenizer(prompt, { add_special_tokens: false });

  // The exact check the loop can only estimate. Every export in the registry
  // emits full-sequence logits, so prefilling N tokens allocates
  // N * vocab_size * 4 bytes of mappable memory; past the adapter's reach, Dawn
  // fails the allocation and every later run on that device returns "invalid
  // due to a previous error". Refusing here costs a turn. Not refusing costs
  // the session (PLAN §10.10), so this is a guard and not a warning.
  const promptTokens = (inputs.input_ids as { dims: number[] }).dims.at(-1) ?? 0;
  const limit = loaded ? maxPromptTokens(loaded) : Infinity;
  if (promptTokens > limit) {
    throw new WorkerError(
      `prompt is ${promptTokens} tokens; ${loaded?.label ?? "this model"} can prefill at most ${limit} ` +
        `(its ${loaded?.vocabSize}-entry vocabulary makes a longer one exceed what the GPU can map). ` +
        `Shorten the conversation or lower the prompt budget.`,
      "prompt-too-long",
      limit,
    );
  }

  const started = performance.now();
  const maxNewTokens = req.maxNewTokens ?? loaded?.generation?.max_new_tokens ?? 256;

  if (kernels) {
    await generateWithKernels(req, prompt, inputs, maxNewTokens, started);
    return;
  }

  // skip_prompt so the callback sees only this turn; special tokens are KEPT
  // because the tool-call markers are exactly what the page needs to parse.
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text: string) => post({ type: "token", id: req.id, text }),
  });

  // Greedy was M8's choice so a spike's output could not change run to run, and
  // it remains the default. It is actively wrong for some checkpoints: Antares
  // at temperature 0 falls into repetition loops and never reaches a tool call,
  // in the reference safetensors model as much as in the converted one
  // (PLAN §11.10). An entry that needs sampling declares it in the registry.
  // The page layers its own overrides on top, and only for the fields someone
  // actually changed — everything else keeps tracking the selected checkpoint.
  const sampling = { ...(loaded?.generation ?? { do_sample: false }), ...(req.generation ?? {}) };
  let out: unknown;
  try {
    out = await model!.generate({
      ...inputs,
      ...sampling,
      max_new_tokens: req.maxNewTokens ?? sampling.max_new_tokens ?? 256,
      streamer,
      stopping_criteria: stopper,
    });
  } catch (err) {
    throw await handleRunFailure(err);
  }

  // The generated ids include the prompt; slice it off so the caller parses only
  // this turn. Special tokens are KEPT — the tool-call markers are what we parse.
  const sequence = (out as { tolist(): number[][] }).tolist()[0] ?? [];
  const completion = sequence.slice(promptTokens);
  const text = tokenizer.decode(completion, { skip_special_tokens: false });

  post({
    type: "generated",
    id: req.id,
    text,
    prompt,
    tokens: completion.length,
    ms: Math.round(performance.now() - started),
    stopped: stopper.interrupted,
  });
}

/**
 * The kernel backend's half of generate().
 *
 * Everything before this point — the chat template with its tool schema, the
 * tokenizer, the prefill guard — is shared, because those are properties of the
 * checkpoint rather than of the engine. Only the forward pass differs.
 *
 * Decoding is incremental and deliberately keeps special tokens: the engine's
 * own generate() drops them, and they are exactly what the dialect parses.
 * Decoding the whole completion each step and taking the new suffix is what its
 * generate() does too — it is quadratic in the token count and irrelevant at
 * these lengths.
 */
async function generateWithKernels(
  req: Extract<ModelRequest, { type: "generate" }>,
  prompt: string,
  inputs: unknown,
  maxNewTokens: number,
  started: number,
): Promise<void> {
  const tok = tokenizer!;
  const engine = kernels!;
  const promptIds = ((inputs as { input_ids: { tolist(): number[][] } }).input_ids.tolist()[0] ?? []).map(
    Number,
  );

  const produced: number[] = [];
  let emitted = "";
  try {
    for await (const id of engine.stream(promptIds, maxNewTokens, () => cancelRequested)) {
      produced.push(id);
      const text = tok.decode(produced, { skip_special_tokens: false });
      if (text.startsWith(emitted)) {
        post({ type: "token", id: req.id, text: text.slice(emitted.length) });
      }
      emitted = text;
    }
  } catch (err) {
    throw await handleRunFailure(err);
  }

  post({
    type: "generated",
    id: req.id,
    text: emitted,
    prompt,
    tokens: produced.length,
    ms: Math.round(performance.now() - started),
    stopped: cancelRequested,
  });
}

/**
 * Turns a failed OrtRun into something the session can come back from.
 *
 * onnxruntime-web does not lose the device politely: once a WebGPU allocation
 * fails, the buffers built on it are invalid and *every* later run on the same
 * InferenceSession fails with "invalid due to a previous error", so the model
 * object is scrap even though nothing about it looks broken. Dropping it here
 * is what turns a dead page into one failed turn — reload() rebuilds the
 * session, and with it the device, on the next request.
 *
 * The guard above should mean this is never reached from a prompt this worker
 * accepted. It stays because "should" is doing a lot of work in that sentence:
 * the ceiling is sized for the logits allocation, and a caller on a smaller
 * adapter, or one already sharing the GPU with something else, can still run out.
 */
async function handleRunFailure(err: unknown): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);
  if (!looksLikeDeviceLoss(message)) {
    return err instanceof Error ? err : new Error(message);
  }
  const dead = model;
  const deadKernels = kernels;
  model = null;
  kernels = null;
  tokenizer = null;
  deadKernels?.dispose();
  try {
    await dead?.dispose();
  } catch {
    // Disposing a session whose device already died can itself throw. The
    // point was to stop referencing it, and that has happened.
  }
  return new WorkerError(
    `the GPU rejected this run and the inference session did not survive it: ${message}\n` +
      `The model will be reloaded on the next message; the conversation so far is kept.`,
    "device-lost",
  );
}

function looksLikeDeviceLoss(message: string): boolean {
  return /previous error|device (is )?lost|failed to allocate|mapAsync|OrtRun/i.test(message);
}

/** Rebuilds the session the last load() described, after a device loss. */
async function reload(): Promise<void> {
  if (!loaded || !lastLoad) {
    throw new Error("generate before ready");
  }
  post({ type: "log", message: `reloading ${loaded.label} after a device error` });
  await load(lastLoad.local, loaded.key, lastLoad.dtype);
}

scope.addEventListener("message", (ev: { data: ModelRequest }) => {
  const msg = ev.data;
  void (async () => {
    try {
      switch (msg.type) {
        case "load":
          await load(msg.local, msg.modelKey ?? DEFAULT_MODEL_KEY, (msg.dtype ?? "q4") as Dtype);
          break;
        case "generate":
          await generate(msg);
          break;
        case "cancel":
          // Fire-and-forget: interrupting when nothing is running is a no-op,
          // which is what lets the page call this without tracking state. Both
          // engines are told, because only one of them is listening.
          stopper.interrupt();
          cancelRequested = true;
          break;
      }
    } catch (err) {
      post({
        type: "error",
        message: err instanceof WorkerError ? err.message : describeError(err),
        ...(err instanceof WorkerError ? { code: err.code, limitTokens: err.limitTokens } : {}),
      });
    }
  })();
});

post({ type: "log", message: "model worker up" });
