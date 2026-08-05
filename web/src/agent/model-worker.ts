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

import type { ModelRequest, ModelResponse } from "./messages.ts";
import { DEFAULT_MODEL_KEY, type Dtype, type ModelEntry, modelFor } from "./models.ts";

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

// One generation at a time, so one criteria object is enough. It is reset
// before each run rather than recreated, because generate() holds the reference.
const stopper = new InterruptableStoppingCriteria();

function post(msg: ModelResponse): void {
  scope.postMessage(msg);
}

async function load(local: boolean, modelKey: string, dtype: Dtype): Promise<void> {
  const entry = modelFor(modelKey);
  loaded = entry;
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
    env.localModelPath = "/models/";
    // Cache Storage cannot take a 1.2 GB entry (it fails the put with an opaque
    // "Unexpected internal error"), and caching a file already served from local
    // disk buys nothing anyway.
    env.useBrowserCache = false;
  }

  const started = performance.now();
  tokenizer = await AutoTokenizer.from_pretrained(entry.repo);
  model = await AutoModelForCausalLM.from_pretrained(entry.repo, {
    device: "webgpu",
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

async function generate(req: Extract<ModelRequest, { type: "generate" }>): Promise<void> {
  if (!tokenizer || !model) {
    throw new Error("generate before ready");
  }
  stopper.reset();

  const prompt = tokenizer.apply_chat_template(req.messages, {
    tools: req.tools,
    tokenize: false,
    add_generation_prompt: true,
  }) as string;

  const inputs = tokenizer(prompt, { add_special_tokens: false });
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
  const out = await model.generate({
    ...inputs,
    ...sampling,
    max_new_tokens: req.maxNewTokens ?? sampling.max_new_tokens ?? 256,
    streamer,
    stopping_criteria: stopper,
  });

  // The generated ids include the prompt; slice it off so the caller parses only
  // this turn. Special tokens are KEPT — the tool-call markers are what we parse.
  const promptLen = (inputs.input_ids as { dims: number[] }).dims.at(-1) ?? 0;
  const sequence = (out as { tolist(): number[][] }).tolist()[0] ?? [];
  const completion = sequence.slice(promptLen);
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
      post({ type: "error", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  })();
});

post({ type: "log", message: "model worker up" });
