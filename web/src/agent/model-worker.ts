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
import { DEFAULT_MODEL_KEY, type Dtype, modelFor } from "./models.ts";

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

// One generation at a time, so one criteria object is enough. It is reset
// before each run rather than recreated, because generate() holds the reference.
const stopper = new InterruptableStoppingCriteria();

function post(msg: ModelResponse): void {
  scope.postMessage(msg);
}

async function load(local: boolean, modelKey: string, dtype: Dtype): Promise<void> {
  const entry = modelFor(modelKey);
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

  const out = await model.generate({
    ...inputs,
    // Greedy: a spike whose output changes run to run cannot tell a prompt
    // problem from a sampling one.
    do_sample: false,
    max_new_tokens: req.maxNewTokens ?? 256,
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
