## 9. Component 2: the WebGPU agent

§1–§8 built and closed out component 1 in full; PLAN.md's original scope statement (§1) explicitly
left component 2, the on-device model, undesigned. This section opens it, in the same
research-before-code spirit as §2: verify what the named model and library actually do before writing
anything against them. **Status: design only — M8 below is scoped but not implemented.** No code in
this repo changes as part of this section.

### 9.1 Research notes (verified 2026-08-05; items 1-4 re-verified against a running model at M8)

1. **Model: `onnx-community/LFM2-1.2B-Tool-ONNX`.** Liquid AI publishes a checkpoint,
   `LiquidAI/LFM2-1.2B-Tool`, fine-tuned specifically for tool use, and `onnx-community` mirrors it
   pre-converted for `transformers.js`. This is a better fit than the plain `LFM2-1.2B-ONNX` the
   README names, since tool-calling accuracy is the entire point of component 2.
   **Corrected at M8** (the variant list above was wrong; these are the actual files, and the
   weights live in external `.onnx_data` blobs rather than in the `.onnx` graph): `model.onnx`
   (fp32, ~4.7 GB over three data files), `model_fp16.onnx` (~2.36 GB), `model_q4.onnx`
   (**1.22 GB — what smolbox uses**), `model_q4f16.onnx` (868 MB, needs `shader-f16`, which no
   browser on this machine exposes, §2.11.24 and §10.14), and `model_quantized.onnx` (q8, 1.2 GB). There is no
   `model_q4f32`.
   (<https://huggingface.co/onnx-community/LFM2-1.2B-Tool-ONNX> ·
   <https://huggingface.co/LiquidAI/LFM2-1.2B-Tool>)
2. **Runtime library: `@huggingface/transformers` (transformers.js v3+; **4.2.0 at M8**).**
   Installable with `bun add @huggingface/transformers`, which works under bun like the rest of
   `web/`; its `onnxruntime-node` and `sharp` dependencies are node-only and bun blocks their
   postinstalls, so the browser bundle is unaffected. WebGPU is enabled
   by passing `device: 'webgpu'` (and here, `dtype: 'q4'`) to `pipeline(...)` or a raw
   `AutoModelForCausalLM.from_pretrained(...)` call — a collaboration with ONNX Runtime Web. The actual
   `LiquidAI/LFM2-WebGPU` Space named in README.md is itself built on transformers.js, so the library
   choice the README implied is confirmed, not assumed.
   (<https://huggingface.co/docs/transformers.js/guides/webgpu> ·
   <https://github.com/huggingface/transformers.js> ·
   <https://huggingface.co/spaces/LiquidAI/LFM2-WebGPU>)
3. **The tool-call wire format is model-native, not OpenAI/Anthropic JSON.** LFM2 wraps tool
   definitions in `<|tool_list_start|>...<|tool_list_end|>` and, by default, emits **Pythonic** calls
   (`[fn_name(arg="value")]`) between `<|tool_call_start|>...<|tool_call_end|>`. The docs say adding
   "Output function calls as JSON" to the system prompt switches it to JSON call syntax.
   **Measured at M8: it does not, for this checkpoint.** Five wordings of that instruction all
   produced Pythonic calls — with correct arguments — so smolbox parses both syntaxes
   (`web/src/agent/parse.ts`) rather than relying on a prompt switch this conversion does not
   honour. Treat the documented switch as unverified for any future checkpoint. Tool results are fed back as a `"tool"`-role message
   containing the JSON-serialized result, wrapped `<|tool_response_start|>...<|tool_response_end|>`.
   (<https://docs.liquid.ai/lfm/key-concepts/tool-use>)
4. **The chat template renders the tool wrapping for us — confirmed at M8.**
   transformers.js applies the model's own Jinja chat template (via `@huggingface/jinja`), and other
   transformers.js tool-calling examples pass a `tools` array straight into
   `apply_chat_template(...)` rather than hand-formatting special tokens. Because
   `LFM2-1.2B-Tool`'s chat template already encodes the `<|tool_list_start|>` wrapping, M8 tried
   passing the existing generated tool schema through `tools` first — and that is all it took. The
   template `tojson`s each tool object verbatim and wraps the `tool` role in
   `<|tool_response_start|>`, so both directions of the round trip are the template's job, not ours.
   No hand-rolled prompt was needed.
5. **Model weights are not part of the wasm artifact.** Unlike `smolbox.wasm` (built and embedded),
   the ONNX checkpoint is fetched from the HF CDN at runtime and cached by transformers.js in the
   browser's Cache Storage API. **Revised at M8:** `make model` pulls the pinned revision into
   `dist/models` (gitignored) and the page prefers it, because a fresh browser profile has an empty
   cache — and Cache Storage cannot hold a 1.2 GB entry anyway (§2.11.26). First load needs network access from the *page* — the sandbox's offline non-goal
   is about the guest VM and is unaffected, but this is a real UX fact to record as a risk (§9.5), not
   a blocker.
6. **Browser support is broader than the mount's, but unverified for this project.** WebGPU has wider
   cross-browser reach than the File System Access API the mount depends on (Chromium-only today), but
   this repo hasn't measured it. M8 targets Chromium first, matching the existing COOP/COEP + picker
   gating, and leaves cross-browser WebGPU support as an open question (§9.4) rather than a blocker.

### 9.2 Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Model | `onnx-community/LFM2-1.2B-Tool-ONNX`, `dtype: 'q4'` | Purpose-built for tool use; q4 is the documented WebGPU-appropriate quantization |
| Library | `@huggingface/transformers` (transformers.js v3+), `device: 'webgpu'` | Matches upstream's own `LiquidAI/LFM2-WebGPU` Space; npm-installable under bun |
| Where inference runs | A **new dedicated Worker**, separate from the VM worker | The VM worker's `wasi.start()` blocks it for the VM's lifetime and cannot receive postMessage mid-run (§2.11.12); model inference must not share it. transformers.js calls are Promise-based, so this worker talks to the main thread over plain `postMessage` — no SAB/Atomics needed here, unlike the VM/fsbridge channels |
| Tool schema → prompt | Pass the existing `web/src/tool.ts` `Definition`'s JSON schema through `apply_chat_template(..., { tools })` | Reuses the generated, anti-drift-guarded schema instead of hand-building prompt text. **Confirmed at M8**: the template renders the `<|tool_list_start|>` wrapping and serialises the tool objects verbatim, so no manual formatting was needed |
| Tool-call syntax | **Parse Pythonic *and* JSON** (`web/src/agent/parse.ts`) | **Revised at M8.** The original plan was JSON-only, via "Output function calls as JSON" in the system prompt (§9.1.3). Measured: five wordings, and the model emitted correct *Pythonic* calls every time. It speaks its documented default; parsing it is cheaper and more honest than fighting the prompt |
| Tool execution | Existing `Session` / `tool.ts` `Call`/`renderResult` path, unchanged | Component 2 is a consumer of the proven M7 surface, not a reason to touch it. **Held at M8: no tool-surface file changed** |
| Weight delivery | `make model` → `dist/models` (gitignored), served locally; HF CDN as fallback | **Added at M8.** A Playwright profile starts with an empty Cache Storage, so a CDN-only path would re-download 1.22 GB every run. Local load is ~4.2 s |
| M8 scope | One hardcoded prompt, one real tool call, transcript logged to console/page — **no chat UI** | Matches the M4 spike pattern: prove the mechanism before building UI or a multi-turn loop around it |

### 9.3 Milestone M8

| # | Deliverable | Done when |
|---|---|---|
| M8 | WebGPU tool-call spike: load `LFM2-1.2B-Tool-ONNX` via transformers.js in a dedicated worker, send one hardcoded prompt, get back one real `run_terminal_command` call, execute it against a live `Session`, log the full transcript | A single scripted run in Chromium shows: model loads on WebGPU, emits a tool call parsed without error, the call reaches a real VM session and returns real output, and the model's follow-up text (after the tool result is fed back) is logged — no chat UI required — **done** (§1, measured at M8) |

### 9.4 Open questions for M9+ (**now designed in §10**; the ones still open are carried there)

- Multi-turn loop and conversation-history management.
- Chat UI shape — what a person actually sees and how they intervene.
- How the existing `setMount` picker flow hands off to the agent (does picking a folder start a
  session automatically, or stay a manual step?).
- Model-swap/versioning story — the checkpoint revision **is** now pinned (`web/fetch-model.ts`
  holds the sha), but nothing handles an update or a second model.
- Whether the dedicated-worker split (§9.2) holds up once inference needs to interleave with streamed
  VM output, rather than the one-shot request/response shape M8 tests.
- **Does the model refuse or mangle the calls a real task needs?** M8 proves one `ls` round-trip. It
  says nothing about multi-step work, about the model recovering from a non-zero exit, or about how
  often a 1.2B model picks a *useful* command rather than a merely well-formed one.
- **Nothing verifies the model's arguments beyond the schema.** `decodeArgs` rejects malformed and
  unknown fields, and `op` can never be set — but a well-formed `cmd` is still arbitrary shell.
  That is the design (the sandbox is the boundary, not the schema), and it is worth stating out loud
  before a chat UI puts a user's folder behind it.

### 9.4b Verified at M8, worth not re-deriving

- The tool surface needed **no changes** to serve a real model — the M7 bet paid off.
- `apply_chat_template({ tools })` is the whole prompt-construction story; there is no reason to
  hand-format special tokens.
- The GPU-free half of the agent (the parser) is where the bugs were, and it is unit-testable in CI.
  Keep new agent logic on that side of the line wherever possible: everything that needs a GPU is
  untestable on a runner.

### 9.5 Risks (component 2)

10. **Model weights require a live network fetch on first load.** Component 1 is fully offline once
    `dist/smolbox.wasm` is built; component 2 is not — the ONNX checkpoint comes from the HF CDN at
    runtime (§9.1.5). **Mitigated at M8:** `make model` pulls the pinned revision into `dist/models`
    once and the page prefers it, so repeat runs and the e2e suite are offline and fast (~4.2 s to
    load). The CDN path remains for anyone who has not run it, and the page says which one it used.
    Note that Cache Storage is *not* a working fallback for a file this size (§2.11.26).
11. **The agent has no CI, by construction.** Headless Chromium offers no software WebGPU fallback
    (§2.11.24), so `make test-e2e-agent` cannot run on a GPU-less runner and is opt-in behind
    `SMOLBOX_WEBGPU=1`. The mitigation is to keep as much agent logic as possible GPU-free: the
    tool-call parser carries 28 unit tests that run in CI on every push, and it is where the real
    bugs were. Anything that can only be tested behind a GPU should stay thin.
12. **The model's call syntax is a moving target.** M8 pinned a checkpoint revision precisely because
    the Pythonic-vs-JSON behaviour (§9.2) is a property of *this* checkpoint, established by
    measurement rather than documentation — Liquid's docs describe a prompt switch that did not take.
    A model bump must re-run `make test-e2e-agent`; the parser accepts both syntaxes so a change in
    either direction is survivable, but a third syntax would not be.
