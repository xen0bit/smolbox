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

// The bundle targets a worker, but web/tsconfig.json deliberately ships no DOM
// lib (see web-globals.d.ts), so the worker scope is reached the same way
// worker.ts reaches it: through globalThis.
const scope = globalThis as unknown as {
  postMessage(msg: ModelResponse): void;
  addEventListener(type: "message", fn: (ev: { data: ModelRequest }) => void): void;
};

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
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

async function load(local: boolean, modelKey: string, dtype: Dtype): Promise<void> {
  const entry = modelFor(modelKey);
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
    // Cache Storage cannot take a 1.2 GB entry (it fails the put with an opaque
    // "Unexpected internal error"), and caching a file already served from local
    // disk buys nothing anyway.
    env.useBrowserCache = false;
  }

  const started = performance.now();
  // The revision is passed so the hub path honours the pin the registry exists
  // to hold; it is ignored for a local load, where the path carries no revision.
  tokenizer = await AutoTokenizer.from_pretrained(entry.repo, { revision: entry.revision });
  chatTemplate = await loadChatTemplate(entry, local);
  model = await AutoModelForCausalLM.from_pretrained(entry.repo, {
    device: "webgpu",
    revision: entry.revision,
    // The dtype is chosen by the page against the adapter's feature list, not
    // hardcoded: f16 variants need shader-f16, which headless Chromium does not
    // expose but a desktop browser usually does (PLAN §2.11.24).
    dtype,
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === "progress" && p.file && typeof p.progress === "number") {
        post({ type: "progress", file: p.file, pct: Math.round(p.progress) });
      }
    },
  });

  post({
    type: "ready",
    source: local ? "local" : "hub",
    loadMs: Math.round(performance.now() - started),
    modelKey: entry.key,
    dtype,
  });
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
  if (!tokenizer || !model) {
    // Either nothing was ever loaded — an error — or a device loss dropped the
    // session and this is the request that pays for rebuilding it.
    await reload();
  }
  if (!tokenizer || !model) {
    throw new Error("generate before ready");
  }
  stopper.reset();

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
  const sampling = loaded?.generation ?? { do_sample: false };
  let out: unknown;
  try {
    out = await model.generate({
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
  model = null;
  tokenizer = null;
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
          // which is what lets the page call this without tracking state.
          stopper.interrupt();
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
