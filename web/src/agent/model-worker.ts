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
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

import type { ModelRequest, ModelResponse } from "./messages.ts";

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

const MODEL_ID = "onnx-community/LFM2-1.2B-Tool-ONNX";

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;

function post(msg: ModelResponse): void {
  scope.postMessage(msg);
}

async function load(local: boolean): Promise<void> {
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
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
    device: "webgpu",
    // q4, not q4f16: headless Chromium's ANGLE/Vulkan adapter does not expose
    // shader-f16, and an f16 build cannot run without it.
    dtype: "q4",
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === "progress" && p.file && typeof p.progress === "number") {
        post({ type: "progress", file: p.file, pct: Math.round(p.progress) });
      }
    },
  });

  post({ type: "ready", source: local ? "local" : "hub", loadMs: Math.round(performance.now() - started) });
}

async function generate(req: Extract<ModelRequest, { type: "generate" }>): Promise<void> {
  if (!tokenizer || !model) {
    throw new Error("generate before ready");
  }

  const prompt = tokenizer.apply_chat_template(req.messages, {
    tools: req.tools,
    tokenize: false,
    add_generation_prompt: true,
  }) as string;

  const inputs = tokenizer(prompt, { add_special_tokens: false });
  const started = performance.now();
  const out = await model.generate({
    ...inputs,
    // Greedy: a spike whose output changes run to run cannot tell a prompt
    // problem from a sampling one.
    do_sample: false,
    max_new_tokens: req.maxNewTokens ?? 256,
  });

  // The generated ids include the prompt; slice it off so the caller parses only
  // this turn. Special tokens are KEPT — the tool-call markers are what we parse.
  const promptLen = (inputs.input_ids as { dims: number[] }).dims.at(-1) ?? 0;
  const sequence = (out as { tolist(): number[][] }).tolist()[0] ?? [];
  const completion = sequence.slice(promptLen);
  const text = tokenizer.decode(completion, { skip_special_tokens: false });

  post({
    type: "generated",
    text,
    prompt,
    tokens: completion.length,
    ms: Math.round(performance.now() - started),
  });
}

scope.addEventListener("message", (ev: { data: ModelRequest }) => {
  const msg = ev.data;
  void (async () => {
    try {
      switch (msg.type) {
        case "load":
          await load(msg.local);
          break;
        case "generate":
          await generate(msg);
          break;
      }
    } catch (err) {
      post({ type: "error", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  })();
});

post({ type: "log", message: "model worker up" });
