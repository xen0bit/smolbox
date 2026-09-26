## 10 (continued). What running it taught us (§10.10–§10.26)

The measurement log for component 2: every finding that came from putting a real model on a real GPU
in front of a real VM, in the order it was found. §10.1–§10.9 in
[10-chat-models-and-tools.md](10-chat-models-and-tools.md) are the plan; this is what survived
contact with it.

Section numbers are stable and are cited from code comments as `§10.x`, so they are append-only:
correct an entry in place, do not renumber it.

### 10.10 The prefill ceiling: why a long chat killed the GPU (2026-08-06)

Reported as "LFM2.5 throws a JavaScript error and the chat breaks after a few tool calls with larger
responses". It is not a JavaScript bug; it is an allocation the loop had no idea it was making.

**The mechanism.** Every ONNX export in the registry declares its logits output as
`[batch_size, sequence_length, vocab_size]` — the **full** sequence, not just the last position.
onnxruntime-web has to map that tensor back to the CPU to sample from it, so one prefill of N tokens
allocates `N × vocab_size × 4` bytes of host-visible memory. Because the agent loop re-prefills the
entire conversation on every iteration, and every tool result makes the conversation longer, a chat
walks into that allocation from below, one tool call at a time.

**Measured** on this machine (RTX 4070 Ti SUPER, 16 GB; LFM2.5 2.6B at q4, vocab 128 000), by
sending a single filler message of a known size and growing it:

| history | prefill logits | result |
|---|---|---|
| 16 261 chars | ~2.15 GB | fine |
| 24 261 chars | ~3.07 GB | `Failed to allocate memory for buffer mapping` (Dawn) |

The failure is **not recoverable in place**: after it, every run on that `InferenceSession` returns
`[Invalid Buffer] is invalid due to a previous error`. The device is poisoned, so the *next* message
fails too, and the one after that. That is the "chat breaks" half of the report.

**Why LFM2 1.2B never showed it.** Same loop, same budgets, **half the vocabulary** (65 536), so half
the allocation — its 24 000-char prompts landed at ~1.57 GB and survived. The bug was latent in the
flat default from M9 and only became reachable when M10 added a checkpoint with a 128 000-entry
vocabulary. Qwen3's 151 936 would have been worse.

**The fix, in four parts.** The first two prevent it and the second two mean no future adapter can
reproduce it:

1. `ModelEntry.vocabSize` and `maxPromptTokens()` / `maxPromptChars()` (`models.ts`) turn the
   allocation into arithmetic: `PREFILL_LOGITS_BUDGET_BYTES` (1.5 GiB, chosen against the
   measurement above — the 2.15 GB prefill worked and is not a target to aim at) divided by
   `vocab_size × 4`. Selecting a model sets the loop's prompt budget from its own ceiling, exactly as
   it already set `max_new_tokens`. The flat 24 000 default is gone.
2. `promptBudgetChars` (was `historyBudgetChars`) now counts the **serialised tool schema** too.
   That was never counted and is ~2.3 KB of prompt on every turn for `run_terminal_command` alone —
   a user with several template tools enabled was well over a ceiling the loop believed it was under.
3. The model worker checks the **real** token count from the real tokenizer before running, and
   refuses with `prompt-too-long` and the ceiling it measured. The loop elides to that number and
   retries the turn once. The char budget is a guardrail; this is the guarantee.
4. A run that fails anyway is treated as a device loss: the worker disposes the session and rebuilds
   it on the next request, and the loop turns *any* generate failure into a visible `error` event
   instead of a rejection out of `send()`. Previously that rejection left a user message with no
   reply and nothing on screen saying why.

**Verified** against the real model: five prompts, nine tool calls, `dmesg` and `ls -laR /etc` among
them, elision holding the prompt at ~12 000 chars — zero device errors, where the same script
previously died on the third prompt. Regression coverage is in `models.test.ts` (the arithmetic, and
that LFM2.5's ceiling is below the default that used to crash it) and `conversation.test.ts` (failure
becomes an event, the refusal-and-retry, the tool schema counting against the budget) — all GPU-free,
all in CI.

### 10.11 Every chat model through its paces (2026-08-06, this machine)

Each registry entry driven through the same four prompts on `/agent/` against a real VM and a real
GPU (RTX 4070 Ti SUPER, 16 GB), headless Chromium with the WebGPU launch flags.

| entry | dtype | load | tool calls | errors | verdict |
|---|---|---|---|---|---|
| LFM2 1.2B Tool | q4 | 4.2 s | 2/4 prompts | 0 | works; still the reference |
| LFM2.5 2.6B | q4 | 3.9 s | 3/4 prompts | 0 | works, and reasons well |
| Qwen2.5 0.5B Instruct | q4 | 4.6 s | 0/4 prompts | 3 | syntax right, model too small |
| Qwen3 1.7B | — | — | — | — | cannot load here (no `shader-f16`) |

- **`hermes` is now verified.** Qwen2.5 emitted
  `<tool_call>\n{"name": "run_terminal_command", "arguments": {"cmd": "cat /mnt/host/hello.txt",
  "timeout_ms": 500}}\n</tool_call><|im_end|>` — textbook, parsed correctly, reached the guest. The
  transcript is checked in as a `CAPTURED:` case in `dialects.test.ts`, which is what the flag
  asserts the existence of. Its `<think>` path is **not** covered: Qwen2.5 does not reason and Qwen3
  could not be run, so that half stays implemented-from-template.
- **A verified dialect is not a working agent.** At 0.5B, Qwen2.5 emits *correct syntax naming a tool
  that does not exist* — `{"name": "ls"}`, `{"name": "find"}` — then apologises for having no tools.
  The registry reports it as correctable ("no tool named ls is available (available:
  run_terminal_command)") and the model never takes the correction. Worth stating plainly in the
  note: the entry verifies the parser, not the workflow.
- **Qwen3 1.7B has exactly one browser-viable build, and it needs `shader-f16`.** Every variant is
  published as a single undivided `.onnx`: q4 (2.147 GB) dies in transformers.js before onnxruntime
  sees it (`RangeError: Array buffer allocation failed` out of `readResponse`, which reads a weight
  file into one `Uint8Array`); q8 (1.742 GB, `model_quantized.onnx`) reads fine and then cannot build
  a session inside the wasm heap (`ERROR_CODE: 6, std::bad_alloc`). Only q4f16 (1.43 GB) works. The
  entry now lists q4f16 alone, so `pickDtype` returns undefined on an adapter without the feature and
  the page says so in 1.5 s instead of downloading 2.1 GB and failing nine frames deep. No Chromium
  here exposes `shader-f16` even on a real NVIDIA adapter (confirmed: vendor `nvidia`, architecture
  `lovelace`, `shader-f16: false` at every `powerPreference`), so this entry is unverifiable on this
  machine by construction — PLAN §2.11.24 again. It reads as a headless limitation and is not:
  §10.14 measured real Chrome too.
- **`weightFiles()` did not name the files transformers.js asks for.** It derived
  `onnx/model_${dtype}.onnx`, which is right for exactly the three dtypes the registry happened to
  use and wrong for the two it did not: `q8` is `model_quantized.onnx` and `fp32` is a bare
  `model.onnx`. Found by trying to add a q8 fallback. Now mirrors
  `DEFAULT_DTYPE_SUFFIX_MAPPING` with a drift test, in the same spirit as every other
  two-runtimes-one-definition gate here.
- **Antares was being offered as a chat model.** Both entries are `task: "localize"` and the registry
  has always said loading one in a chat box produces confident nonsense — and the dropdown listed
  them anyway, indistinguishable from LFM2. They are now in an optgroup of their own
  ("not chat models — see /scan/") and selecting one says so before any weights are fetched.

### 10.12 Gemma 4: the ONNX path, surveyed and deferred (later taken — see §10.15)

The reference given was `webml-community/gemma-4-webgpu-kernels`, which turns out **not** to be a
path this project should follow: it is a static Space carrying a hand-written WebGPU engine (147
`.wgsl` references, its own `createComputePipeline` calls) driving
`google/gemma-4-E2B-it-qat-mobile-transformers` — safetensors, no ONNX. Adopting it would mean a
second inference backend.

**This section records the alternative, which was surveyed first and deferred** — §10.13 shipped
first. It was then built too (§10.15), once §10.14 established that the kernel build cannot run on
this machine at all; the four obstacles below are exactly what it had to get through, and the
survey's risk ordering turned out to be wrong in an instructive way. (§10.14's premise did not
survive: §10.17 got the kernel build running here, and this path is now the slower of the two. It
stays as the reference implementation — every other model in the registry takes it.)

The ONNX path is available: `onnx-community/gemma-4-E2B-it-ONNX` exists, and transformers.js 4.2.0
already knows `gemma4`/`gemma4_text`, so no custom kernels are needed for it. Four things stand in
the way, in order of risk:

1. **A genuinely new dialect.** Gemma 4's grammar is neither JSON nor Pythonic:
   `<|tool_call>call:NAME{arg:value}<tool_call|>`, with asymmetric markers, a custom quote token
   `<|"|>`, and tool declarations rendered as `<|tool>declaration:NAME{…}<tool|>`. `extractBlocks`
   handles the markers; the body parser is new work. The template also has an `enable_thinking`
   path, so `ThinkStyle` applies.
2. **The tool-result role does not line up.** The template resolves a response's function name from
   `tool_call_id` on the assistant message's structured `tool_calls`. Our history is flat
   `{role: "tool", content}` with raw assistant text, so results may render as `unknown` or be
   dropped entirely. **Measure this first** — it decides whether the rest is worth doing.
3. **The export is multi-component.** `embed_tokens` + `decoder_model_merged` (+ vision and audio
   encoders — the checkpoint is `any-to-any`), not one `model_*.onnx`. `weightFiles()` cannot express
   that shape at all, so `make model` needs to change before the page can load anything locally.
4. **`vocab_size` is 262 144** — double Qwen3, the largest here by a wide margin. Under
   `PREFILL_LOGITS_BUDGET_BYTES` that is ~1536 prompt tokens (~6 KB), of which
   `run_terminal_command`'s schema alone is ~600. Check whether this export emits full-sequence
   logits (§10.10) before assuming the ceiling binds; if it does, the agent loop may not have room to
   work with.

Already handled: the repo ships no inline `chat_template`, only the standalone `.jinja` — the trap in
§2.11.26, which the worker's `loadChatTemplate` fallback already covers.

### 10.13 Gemma 4 on the WebGPU kernel backend (2026-08-06)

Built at the maintainer's call for the *kernel* engine rather than the ONNX path
of §10.12 — "I definitely want Gemma4 to use the optimized kernel backend, it's WAY faster."
It is a second inference engine sitting behind `ModelClient`, which is the first
time this project has had one, and everything above that interface — the loop,
the dialects, the tool registry, the UI — is untouched.

**What the engine is.** `webml-community/gemma-4-webgpu-kernels` is a static Space
carrying one ~540 KB ES module with its own WGSL kernels, its own safetensors
reader and its own tokenizer. It is **downloaded, not vendored**: the Space
declares no license, so `make gemma-kernels` pulls a pinned revision
(`158f16ae`) into gitignored `dist/kernels/` and the page imports it at runtime.
`web/serve.ts` serves it at `/kernels/`, exactly as it serves weights at
`/models/`. (Corrected at §10.28: the no-license reasoning here was wrong-headed and has been
dropped; `make site` now ships the engine with the deployment.)

**Two things the engine does that smolbox cannot use**, which is why
`gemma-kernels.ts` exists rather than a three-line call to its `generate()`:

1. Its `encodePrompt` hardcodes `tools: null` when rendering the chat template.
   smolbox's entire prompt *is* the generated tool schema (§9.2), so tools could
   never reach the model.
2. Its `generate()` decodes with `skip_special_tokens: true`, which strips
   `<|tool_call>` and `<tool_call|>` — precisely what the dialect parses.

So the prompt is built and the output decoded with the transformers.js tokenizer
the worker already loads, and only the forward pass comes from the engine,
through the `_model` / `_generationState` / `_eosTokenIds` accessors it exposes.
The prefix-cache bookkeeping is reimplemented faithfully and is worth more here
than in a chat app: the agent loop re-sends the whole history on every tool round
trip, and within a turn each prompt strictly extends the last, so only the new
tokens are prefilled.

**Three real bugs were found on the way, all now fixed:**

- **The dev server had no `Range` support.** The engine reads
  `model.safetensors` in 256 KB chunks so a 2.5 GB checkpoint never has to be
  held in memory. Against a server that ignores `Range` it got the *whole file*
  back for every chunk and died allocating a 2.5 GB `Uint8Array` — which reads as
  an out-of-memory bug in the engine rather than a missing feature in
  `web/serve.ts`. The HF CDN supports ranges, so the Space never saw it.
- **The prefill ceiling had to become backend-aware.** §10.10's arithmetic is
  about a logits tensor onnxruntime maps back to the CPU. This engine samples on
  the GPU with its own argmax kernels and never downloads one, so charging its
  262 144-entry vocabulary the same cost would have capped its prompt at ~1500
  tokens for something it does not pay. A new `AGENT_WORKING_TOKENS` (8192) is
  the loop's own ceiling — under every existing entry's limit, so a no-op for
  them, and the only thing bounding an engine that would otherwise be unbounded.
- **A flat tool history renders to nothing.** See §10.12 obstacle 2, now
  confirmed and handled by `Dialect.historyStyle` (commit `adbe064`).

**Status: implemented, loads, and cannot be run here.** Measured: the engine
imports, the tokenizer and standalone chat template load, 2.46 GB of weights
stream onto the GPU in **7.4 s**, and the first forward pass then fails with
`No supported WebGPU variant for com.xenova.gemma4.DenseGemv`. The reason is
exact and in the bundle's own guards: every variant is gated on `shader-f16`
(`tensorDtypes.aT != "float16" or device.features.has("shader-f16")`), because
the QAT checkpoint's tensors are f16 — so there is no f32 path to fall back to.
No Chromium here exposes `shader-f16` on any adapter behind any flag. That was
first read as a headless limitation; §10.14 measured it properly and it is not.
PLAN §2.11.24 again, and the same wall Qwen3 hit in §10.11.

> **Superseded by §10.17 (2026-08-10).** The guard is real; the reason given for
> it is not. The QAT checkpoint contains **no f16 tensors at all** (1869 F32,
> 361 BF16, 182 I8, 368 U8 — counted), the guards exclude f16 *tensors* rather
> than the op, and there IS an f32 path: every op declares
> `typeConstraints: {T: ["float32","float16"]}`. The f16 came from three
> hardcoded dtype choices inside the engine, which §10.17 rewrites. The entry no
> longer declares `requiresFeatures`, and the kernel build runs on this machine.

So the entry declares `requiresFeatures: ["shader-f16"]` and the page refuses
**before fetching anything** — 2.5 GB and 7.4 s became an instant, accurate
message. The dialect stays `verified: false` until a transcript exists, and per
§10.14 no browser on *this* machine can produce one. What *is* tested in CI is
the half this project wrote:
`gemma-kernels.test.ts` covers the prefix-cache reuse, the reset rules,
cancellation and the token budget against a fake engine, and
`gemma4.test.ts` pins the call grammar to the checkpoint's own rendered template.

### 10.14 Why `shader-f16` is missing here, and where the earlier answer was wrong (2026-08-06)

§10.11 and §10.13 both concluded "headless Chromium does not expose `shader-f16`",
which framed it as a limitation of the test harness — implying a real browser on
this machine would run Qwen3 and Gemma 4 fine. **That framing was wrong**, and the
correction matters: it is the difference between "our CI can't see it" and "this
GPU can't run it."

**What was measured.** Four Chromium builds, all against the real RTX 4070 Ti
SUPER on NVIDIA 595.84 / Vulkan 1.4.329:

| build | how it was driven | adapter | `shader-f16` |
|---|---|---|---|
| Playwright `chromium_headless_shell` | Playwright | nvidia / lovelace | **no** |
| Playwright `chromium`, new headless | Playwright | nvidia / lovelace | **no** |
| Google Chrome 151 (flatpak) | raw CDP | nvidia / lovelace | **no** |
| Google Chrome 151 (`.deb`) | raw CDP | nvidia / lovelace | **no** |

A real adapter needs `--use-angle=vulkan --enable-features=Vulkan`; without them
`requestAdapter()` returns `null` in every build. Firefox is not an escape hatch
either — with `dom.webgpu.enabled`, `gfx.webgpu.force-enabled` and
`gfx.webgpu.ignore-blocklist` it returns no adapter at all headless.

**Headed was not tested and could not be.** The machine sits at the COSMIC
greeter, so the only X display belongs to `cosmic-greeter` (no xauth for this
user); Xvfb is not installed and sudo needs a password. That is a real gap in the
evidence, but the result below makes it very unlikely to matter.

**`chrome://gpu` locates the gate exactly.** Its Dawn Info section (readable over
CDP only if you walk shadow roots — `document.body.innerText` is empty) lists four
adapters:

| adapter | WebGPU status | `shader-f16` |
|---|---|---|
| ANGLE NVIDIA (compatibility mode) | Available | no |
| SwiftShader | Blocklisted — CPU adapter | no |
| **NVIDIA RTX 4070 Ti SUPER (Vulkan)** | **Available** | **no** |
| llvmpipe (Vulkan) | Blocklisted — CPU adapter | **yes** |

Dawn enables f16 on Mesa's *software* Vulkan on this machine and not on the NVIDIA
one. That single row rules out the harness, the browser build and headless mode
together: nothing about how the browser was launched can explain a per-adapter
difference inside one process.

**The driver is not the reason, which is where the first explanation failed.**
Dawn's gate is `VK_KHR_shader_float16_int8` + `shaderFloat16` + `shaderInt16` +
`storageBuffer16BitAccess` (`src/dawn/native/vulkan/PhysicalDeviceVk.cpp`). An
earlier note in this repo claimed `storageInputOutput16` was the missing bit; it
is not part of the gate at all. Probed directly against `libvulkan.so.1` with no
browser in the loop (`ctypes` → `vkGetPhysicalDeviceFeatures2` +
`vkEnumerateDeviceExtensionProperties`):

| bit / extension | NVIDIA | llvmpipe |
|---|---|---|
| `VK_KHR_shader_float16_int8` | yes | yes |
| `shaderFloat16` | **true** | true |
| `shaderInt16` | **true** | true |
| `storageBuffer16BitAccess` | **true** | true |
| `uniformAndStorageBuffer16BitAccess` | true | true |
| `storageInputOutput16` | false | false (and f16 is still enabled) |

Every condition Dawn documents passes on the NVIDIA device, and the two devices
are identical on all of them — so **the cause is not established.** The remaining
candidate is a vendor or driver exclusion inside the Dawn build Chrome 151 ships;
that could not be confirmed, because the `chromium/7922` branch is absent from the
`google/dawn` GitHub mirror. WebGPU on Linux is still not officially shipped, so a
carve-out is plausible, but it stays a hypothesis here rather than a finding.

**Consequences.**

> **The first bullet is wrong, and §10.17 (2026-08-10) says why.** Everything
> measured above is sound and still reproduces on Chrome 151 — but all of it is
> about the *adapter*, and for Gemma 4 the constraint was in the *engine*: three
> hardcoded f16 dtype choices in its model builder, over a checkpoint with no
> f16 in it. Rewritten to f32, the kernel build runs here, 3.4× faster than the
> ONNX path. Qwen3 is unaffected — its f16 is a real file.

- Qwen3 and Gemma 4 cannot be run in a browser on this machine *by anyone* — not
  just by CI. Both entries' `requiresFeatures` refusal is the right behavior; it
  simply fires more often than §10.11 and §10.13 implied.
- Verification needs different hardware, not a different browser: D3D12
  (Windows), Metal (macOS), or a Mesa-driven AMD/Intel GPU on Linux, where RADV
  and ANV do advertise the feature.
- A newer Chrome is worth one cheap retry if this ever gets picked up again — if
  the exclusion is version-pinned, a later Dawn may lift it.

### 10.15 Gemma 4 on ONNX: the first Gemma turn anyone here has seen (2026-08-06)

§10.13 shipped a Gemma 4 that loads and cannot generate; §10.14 showed no browser on this machine
can fix that. So the path §10.12 deferred got built, and it **works** — this is the first Gemma 4
output this project has produced.

**Measured, five turns against the real model on WebGPU** (`SMOLBOX_MODEL=gemma4-e2b-onnx make
test-e2e-agent`, RTX 4070 Ti SUPER, q4):

| turn | ask | tool call it chose | result |
|---|---|---|---|
| 1 | list the files | `ls -l /mnt/host` | named all three, spotted that `link.txt` is a symlink |
| 2 | show hello.txt | `cat /mnt/host/hello.txt` | quoted the contents |
| 3 | how many lines | `wc -l /mnt/host/hello.txt` | "**1** line" |
| 4 | kernel version | `uname -a` | quoted it back |
| 5 | summarize | (none — correctly) | summarized all four turns |

Load: **3.65 GB in 7.4 s**. Turns: 15–33 s, and 96 s for the summary. History grew to 2399 chars over
19 messages with no device error — the §10.10 failure mode did not reappear, which is the point of
the ceiling below.

**The survey's risk ordering was wrong, and usefully so.** Obstacles 1 and 2 (the dialect, the
structured history) were the ones called riskiest, and they cost nothing here — both had already been
built for the kernel path, and the ONNX repo's `chat_template.jinja` is a *different, older* revision
of the template that renders the same call grammar and the same structured history. Verified by
rendering it, not assumed. What actually took the work was obstacles 3 and 4, both filed as lesser:

- **Obstacle 3, the multi-component export, was the real one.** `weightFiles()` assumed one
  `model.onnx`. This checkpoint is four graphs (`embed_tokens`, `decoder_model_merged`, plus vision
  and audio encoders a text-only load never touches), and the big ones spill across up to five
  external-data shards. Two additions: `ModelEntry.components`, and shard *probing* rather than a
  hardcoded count — the count is published in the repo config, but a number copied into the registry
  would rot silently against a pinned revision, whereas a 404 on `.onnx_data_3` is self-describing.
  Loading it through `AutoModelForCausalLM` against a config whose architecture is
  `Gemma4ForConditionalGeneration` puts transformers.js on its text-only path, so only two of the
  four graphs are ever built — which is why 3.6 GB is the cost rather than 5.5 GB.
- **Obstacle 4 dissolved on inspection, and the check was worth making.** The survey feared 262 144
  logits per token would cap the prompt at ~1500. The export takes `num_logits_to_keep`, and
  transformers.js passes 1, so a prefill materializes **one** row rather than one per token. Read out
  of the graph before assuming. `ModelEntry.prefillLogits: "last"` now says so, and replaces the
  `backend === "gemma4-kernels"` special case in `maxPromptTokens` — the question was never which
  engine, it was what a forward pass materializes, and two entries answer it differently for
  different reasons.

**Two things only a real run could have found:**

- **Greedy decoding breaks it in a way that looks like success.** Run at the worker's default
  (`do_sample: false`), Gemma 4 makes the *first* tool call perfectly and then, when the result comes
  back, emits nothing but `<eos>`. The entry now carries the checkpoint's own
  `generation_config.json` values (sample, temperature 1.0, top-k 64, top-p 0.95) — the vendor's
  numbers, not tuning. A single-turn test would have passed and shipped a model that cannot hold a
  conversation.
- **Stop tokens land in the visible text.** `eos_token_id` is `[1, 106, 50]` — `<eos>`, `<turn|>` and
  `<|tool_response>` — so the model halts the moment it starts inventing a tool response, which is
  exactly right. But the worker decodes with special tokens *visible* (the only way the call markers
  survive), so the stop token is part of the completion. The dialect's scaffolding list now strips
  the tool-response pair too.

**The dialect is now `verified: true`**, off this run, with two `CAPTURED:` cases in
`gemma4.test.ts` — the tool call and the answer turn, verbatim. The kernel entry shares the grammar
and still has not emitted a token anywhere, and its note says so rather than borrowing this
verification.

Also fixed here, found by the run: `fetch-model.ts` had no retries, and a 3.65 GB pull died on a
single transient 504 from the hub on an *optional* file. It now retries 5xx and network failures with
backoff, while 404 and 403 return immediately — an absent optional file must not cost four attempts.

### 10.16 Where §10.10's ceiling was still wrong (2026-08-09)

Two reports against LFM2.5 2.6B at q4, both after several tool calls, both from inside the budget
§10.10 installed. They are the same mistake seen from opposite sides: **a character budget is not a
token budget, and a token budget is not a memory budget.**

**Firefox — the device died at a prompt the arithmetic allowed.** Elision had just trimmed to
~12 318 characters, comfortably under LFM2.5's 12 580-character ceiling, and the prefill still took
the device out: `WebGPU device error(3): Out of memory`, then `Failed to download data from buffer:
Mapping WebGPU buffer failed: Invalid buffer` out of `OrtRun`. `PREFILL_LOGITS_BUDGET_BYTES` (1.5 GiB)
was measured in **headless Chromium**, and it bounds exactly one allocation — the logits tensor —
while the device is also holding ~1.85 GB of weights and a KV cache that grows with the conversation.
Firefox is stricter about the total. The constant is not wrong so much as **not knowable in advance**:
it is a property of the browser, the adapter and what else is resident, and no arithmetic over
`vocab_size` can produce it.

**Chrome — the retry re-sent the prompt it had just been refused.** The worker measured 3198 tokens
against its 3145-token ceiling and refused, correctly and harmlessly. The loop then converted 3145
tokens to characters at `CHARS_PER_TOKEN_ESTIMATE` (4) → 12 580, compared it against a prompt of
~12 300, concluded it was already inside budget, elided **nothing**, and sent the identical prompt
again. The estimate was the bug: that conversation — paths, `find` output, exit codes — ran at
**3.85 chars/token**, and the error is in the direction that makes a refused prompt look acceptable.
`attempt === 0` then ended the turn on the second refusal.

**The fix, in three parts.**

1. **The refusal now carries both numbers.** `ModelResponse.error` gained `promptTokens` beside
   `limitTokens`, so the loop can divide the characters it sent by the tokens they became and get the
   real ratio for *this* conversation instead of the registry's estimate. The retry aims 5% under the
   ceiling at that ratio (`PROMPT_RETRY_MARGIN`).
2. **A new budget is always below the prompt that failed.** `shrinkBudget()` clamps to `sent - 1`
   whatever the arithmetic says, where `sent` is what the attempt actually contained rather than the
   ceiling it was allowed. This is the invariant the Chrome failure violated, and it holds for both
   codes.
3. **`device-lost` is retried, once, like `prompt-too-long`.** The worker already dropped the session
   and rebuilds it on the next request (§10.10 part 4) — but nothing ever *made* a next request, so
   the rebuild was paid for by the user's following message, which failed at the same size. The loop
   now halves the budget to below what died and retries the turn itself: one slow turn (a reload from
   the IndexedDB cache) instead of a dead one. Each code gets exactly one retry per generation.

**And the ceiling is now learned rather than only computed.** A device loss is the only hard evidence
anyone has about what a given GPU can really prefill, so the budget it recovered at is stored per
model key under `smolbox.prefill-ceilings` and `Settings.defaultOf` takes the **lower** of it and the
registry's arithmetic. The second session on a machine starts where the first one finished learning.
It is kept apart from `smolbox.config` deliberately: that key holds choices the user made, this one
holds a measurement the page took by hitting a wall.

**Not fixed, and worth knowing.** The rebuild happens inside the model worker, on the same
onnxruntime wasm module and therefore the same WebGPU device. That is the right bet for an
out-of-memory error — the allocation failed, the device did not go away, and disposing the sessions
returns the memory — but if a browser ever genuinely *loses* the device, the reload will succeed and
the retry will fail again, and only tearing down the whole worker would help. The loop reports it
after one retry rather than looping.

Coverage, all GPU-free and in CI (`conversation.test.ts`): a refusal shrinking the prompt even when
the char estimate says it fits (the Chrome case, with its real numbers), a device loss retried at
half the size and completing the turn, a second device loss ending the turn instead of rebuilding
forever, and the floor (`MIN_PROMPT_BUDGET_CHARS`) holding.

Separately, from the same transcript: a reasoning model's tool-call turn has no prose in it, and the
page labelled every one of them *"thought for 548 chars, then stopped without answering"* — a working
turn described as a failure, once per tool call. The `assistant` event now carries `toolCalls` and
the summary says what actually happened.


### 10.17 The kernel build runs here after all: §10.14 was right, its conclusion was not (2026-08-10)

§10.14 established, carefully and correctly, that this machine's NVIDIA adapter does not expose
`shader-f16` in any browser. Re-measured today against Chrome 151.0.7922.75 / driver 595.84 and it
still holds, including under `--disable-gpu-driver-bug-workarounds`, `--ignore-gpu-blocklist`,
`--enable-unsafe-webgpu` and `--enable-dawn-features=allow_unsafe_apis` — no flag lifts it, so it is
not Chrome's driver-bug-workaround layer either. Nothing below revises that finding.

What was wrong was the sentence after it: *"Gemma 4 cannot be run in a browser on this machine by
anyone"*. The kernel build has been running all day.

**Where the inference went wrong.** §10.13 observed that every variant of
`com.xenova.gemma4.DenseGemv` is guarded on `shader-f16`, and explained it as *"the checkpoint's
tensors are f16"*. The observation is true and the explanation is false. Reading the engine's own op
manifests:

- every op declares `typeConstraints: {T: ["float32", "float16"]}` — f32 is a first-class type
  throughout, not a fallback;
- every `shader-f16` guard has the shape
  `(tensorDtypes.aT != "float16" and ...) or device.features.has("shader-f16")` — it excludes f16
  **tensors**, not the op;
- the WGSL is generated from Jinja templates that emit `enable f16;` only under
  `{% if usesF16 %}`, where `usesF16` is itself a function of the tensor dtypes.

And the checkpoint has no f16 in it. `model.safetensors` for
`google/gemma-4-E2B-it-qat-mobile-transformers` is 2780 tensors: 1869 F32, 361 BF16, 182 I8, 368 U8.
Not one F16. The 2.1 GB that dominates the file is U8 — the 4-bit QAT weights — and it was never
going to be f16 whatever the adapter said.

**Where the f16 actually came from: three hardcoded lines in the engine.** Not the model, not the
kernels, not the manifests. The engine's model builder makes three dtype choices by hand while
everything around them takes the `"float32"` default:

| site | what it is |
|---|---|
| `per_layer_model_projection.weight` | converted BF16 → `float16` on upload (~31 MB) |
| `g4d-ffnormed` | activation buffer allocated `float16` |
| `g4d-gelu` | activation buffer allocated `float16` |

Flip those three to `float32` and no tensor in the graph is f16, so no shader sets `usesF16`, so no
shader emits `enable f16;`, so every `when` guard passes without the feature. Three tokens.

**The fix.** `web/src/agent/kernel-f32.ts` rewrites those three sites in the bundle text, and
`gemma-kernels.ts` imports the result from a blob URL. It applies **only** when the adapter lacks
`shader-f16`; where the feature exists the pinned artifact is imported byte-for-byte as published,
because f16 is genuinely faster and smaller there. The engine is a downloaded, unlicensed artifact
(§10.13, `fetch-kernels.ts`) and exposes no dtype option on `Gemma4Mobile.load()`, so rewriting the
fetched text is the only seam that does not involve forking it — and it leaves the file on disk
identical to what the Space published.

Each of the three rewrites must match **exactly once** or the load throws `KernelRewriteError`
naming the site. That is deliberate: a partial rewrite would leave one f16 buffer, stream 2.5 GB onto
the GPU and die on the first forward pass with "No supported WebGPU variant" — the exact failure this
removes, but with a worse explanation. `kernel-f32.test.ts` runs the rewrites against the real
540 KB artifact, so bumping `REVISION` in `fetch-kernels.ts` fails a unit test rather than a GPU run.

**Measured, same spec (`tests/e2e/agent.spec.ts`), same machine, same prompts:**

| | load | full spec | weights |
|---|---|---|---|
| `gemma4-e2b` (kernels, f32-rewritten) | **7.4 s** | **13.2 s** | **2.3 GB** |
| `gemma4-e2b-onnx` (onnxruntime) | 12.4 s | 44.3 s | 3.6 GB |

Both chose `ls`/`ls -l` on `/mnt/host` unprompted, read the real mount and answered from it; the ONNX
run additionally noticed `link.txt` is a symlink. The engine reports
`nvidia lovelace (subgroups)` — no f16, no subgroup-matrix — while the adapter probe in the same page
confirms `shader-f16: false`. **The kernel build is 3.4× faster end to end on the adapter that was
supposed to be unable to run it at all.**

`requiresFeatures` is now unset on every entry. The field stays, because the failure mode it prevents
is real; §10.13's mistake was diagnosing an engine's own dtype choice as an adapter limit. Qwen3 is
untouched by this — its constraint is that the only ONNX export small enough for the wasm heap is a
genuine f16 *file*, which is a question of which build exists rather than of which dtype an engine
picked.

**The lesson, since §10.14 did the hard measuring and still landed wrong.** Every measurement in
§10.14 was sound and every one of them was about the adapter. None of them was about the engine, and
the engine was where the constraint lived. "The device cannot do X" and "this code asked for X" look
identical from the outside — both end in the same refusal — and the second is usually the one you can
fix. Read what the code requests before concluding the hardware is the limit.


### 10.18 The other models: it was never f16, it was the inline-weight ceiling (2026-08-10)

§10.17 fixed the Gemma kernel build by rewriting three dtype choices. The obvious next question is
whether the same move helps the rest of the registry. **It does not, and finding out why turned up a
different constraint that was blocking more models than f16 ever was.**

**Does onnxruntime actually need `shader-f16`, or is skipping f16 builds our own policy?** The same
question §10.17 turned on, asked of the ONNX path. Measured by relaxing `pickDtype` and loading
anyway:

| build | what happened |
|---|---|
| Qwen2.5 0.5B **q4f16** (483 MB) | **loads**, then the first forward pass dies: `Program Gather requires f16 but the device does not support it` (`shader_helper.cc:401`) |
| Antares 350M **fp16** | refused before loading, by transformers.js `session.js:71` → `isWebGpuFp16Supported()`, which is `adapter.features.has('shader-f16')` |

So the answer is **yes, genuinely required** — unlike the Gemma kernels, where f16 was a choice made
over a checkpoint that contained none. `F16_DTYPES` is correct and fires at the right moment.

One nuance worth keeping: transformers.js guards only **pure `fp16`**, not `q4f16`. Without our own
gate a q4f16 entry would download, load, and die mid-conversation. Our policy is stricter than the
library's and needs to stay that way.

**The finding that mattered.** Two entries never reached the f16 question at all:

| build | result |
|---|---|
| Qwen3 1.7B q4f16 — 1.43 GB, one file | `Can't create a session`, `std::bad_alloc` |
| Antares 350M fp32 — 1.82 GB, one file | `std::bad_alloc` |

Both die on **allocation**, before any shader runs. transformers.js reads a weight file into one
`Uint8Array` before onnxruntime sees it, and onnxruntime then builds the session inside the wasm
heap. Neither wall scales with GPU memory, which is why a 16 GB card does not move them. Measured
inline sizes, all single-file:

| file | result |
|---|---|
| 786 MB — Qwen2.5 0.5B q4 | loads and runs |
| 1.43 GB — Qwen3 1.7B q4f16 | `std::bad_alloc` |
| 1.74 GB — Qwen3 1.7B q8 | `std::bad_alloc` |
| 1.82 GB — Antares 350M fp32 | `std::bad_alloc` |
| 2.15 GB — Qwen3 1.7B q4 | `RangeError` out of `readResponse` |

**And the fix is a sidecar, not a smaller model.** The same 1.82 GB Antares graph, re-saved with its
weights in `model.onnx_data`, **loads in 8.0 s and generates** — verified end to end: load 8.0 s, VM
boot, 17 tokens of coherent text. Checkpoints with external data have no such ceiling; Gemma 4's
ONNX build streams 3.6 GB here without complaint.

That makes **Antares 350M the first Antares to run on this machine**, at fp32, needing no adapter
feature at all.

**What changed.**

- `tools/quantize_onnx.py` shards on `BROWSER_INLINE_CEILING` (1 GB) rather than on protobuf's 2 GiB
  limit. (That file was removed with Antares later the same day — see §11's note. The rule survives
  in `INLINE_WEIGHT_CEILING_BYTES`, and the measurement is the reason it does.) The old rule was not wrong about protobuf — it was answering the wrong question. `optimum`
  emits whatever protobuf allows, which for 350M is one 1.82 GB file no browser can load, so
  `_reshard_inline` now rewrites it in place. Only ever reached in the safe range: below the ceiling
  there is nothing to do, and above 2 GiB the exporter already wrote a sidecar because it had no
  choice, so the in-memory round trip that would be reckless on a >2 GiB graph never happens.
- `ModelEntry.inlineBytes` + `INLINE_WEIGHT_CEILING_BYTES` let `pickDtype` skip a build the browser
  cannot load, exactly as it skips f16 without the feature. Same question, same place, answered
  before the download rather than 1.4 GB into it.
- `dtypeBlockers()` returns **every** reason, not the first. Qwen3's q4f16 is both oversized and
  f16-gated, and an earlier cut of this reported only `shader-f16` — which sends the reader after a
  GPU that would not fix it. Size leads, because it is the reason no hardware change answers.
- Antares 350M is `dtypes: ["fp32", "fp16"]`, the only entry that prefers fp32. Not a quality
  judgement: it is the build that runs everywhere.

**Corrected: the Qwen3 entry was wrong.** It said q4 and q8 fail on allocation but *"q4f16 (1.43 GB)
does [work], so it is the entry"*, held back only by `shader-f16`. That was never measured. q4f16
fails identically, so **no published build of Qwen3 1.7B loads in a browser** and a GPU exposing the
feature would not change it. AGENTS.md §Dialects said the same thing about why `hermes`'s `<think>`
path is uncaptured; both now say the real reason. Unblocking Qwen3 needs a re-export with external
data — the Antares move, applied to someone else's repo.

**Still open: Antares 1B.** The good one — the one that follows the protocol. Its fp16 (3.67 GB) is
correctly sharded and needs `shader-f16`, which this adapter lacks. Its fp32 (7.35 GB) is also
correctly sharded and *would* load, but did not finish doing so in ten minutes here against 8.0 s for
350M's 1.82 GB, so it is deliberately **not** offered — a dtype that technically works and
practically hangs is worse than no dtype. It is now the only entry in the registry that requires
`shader-f16`. Two ways out, both unmeasured: an **int8** build (int4 is known to destroy this model —
0.816 logit correlation, and it loses the tool-call protocol — but int8 was never tried), or a
machine whose adapter exposes the feature.

**The pattern, for the third time in three sections.** §10.14 measured the adapter and concluded the
model could not run. §10.17 found the constraint was the engine's dtype choice. §10.18 found that for
two more models it was neither — it was how the file was laid out on disk. Each time the error was
attributing a failure to the layer that reported it. `std::bad_alloc` from onnxruntime is not
onnxruntime's limit any more than a `shader-f16` refusal was the GPU's; it is the shape of what it
was handed. Ask what was requested before concluding what is impossible.

### 10.19 Qwen3 1.7B removed, and what the hub has to replace it (2026-08-10)

§10.18 established that **no** published build of `onnx-community/Qwen3-1.7B-ONNX` loads in a
browser. An entry whose every dtype makes `pickDtype` return undefined is a menu item nobody can
order: the page renders it, the reader picks it, and the only thing that happens is a refusal. It is
now removed. The rules it motivated are not — `inlineBytes`, `INLINE_WEIGHT_CEILING_BYTES` and the
two-reason shape of `dtypeBlockers()` are all still there, exercised by a synthetic fixture in
`models.test.ts` rather than by a shipped entry, which is where a rule about *any* build belongs.
`oversizedF16Entry()` keeps Qwen3's measured 1.43 GB so the assertions read in real numbers.

Registry: 6 entries → **5**. Unit tests 410 → 410 (the qwen3 cases were rewritten, not dropped).

**Kept deliberately: Qwen2.5 0.5B Instruct.** It loads — 786 MB, measured, and the only entry the
IndexedDB cache e2e runs against — it just is not a good agent (§10.11). "Does not load" and "loads
and is bad" are different removals and only the first one happened here.

#### The survey: what is on the hub now, against these constraints

Four constraints decide this, and only the first is about the model being good:

1. a dtype that is not f16, since no adapter here exposes `shader-f16` (§10.14, §10.17);
2. either a `.onnx_data` sidecar **or** a single `.onnx` under ~1 GB (§10.18);
3. a tool-call grammar one of the five dialects already parses, or the honest cost of a sixth;
4. a vocabulary small enough that the prefill ceiling leaves a usable prompt (§10.10, §10.16).

**Two of those are ours to fix, and knowing which changes the search.** If we are willing to run the
exporter, 1 and 2 stop being constraints at all: we choose the dtype and we always write a sidecar.
That is the whole reason a checkpoint should not be dismissed for shipping only q4f16, or only one
undivided file — those are properties of somebody's export, not of the model.

What we cannot export our way out of is the **runtime**. transformers.js has to know the
`model_type` to map a config onto a model class and drive generation; an ONNX graph for an
architecture it has never heard of is a file it cannot instantiate. So the real gate moved from *does
a prebuilt ONNX exist* to *is the architecture in the library's mapping* — and that is a question
this repo can answer in one grep against the version it has pinned, before downloading anything:

```
$ grep -o '\["qwen3_5_text","[A-Za-z0-9_]*"\]' \
    node_modules/@huggingface/transformers/dist/transformers.node.min.mjs
["qwen3_5_text","Qwen3_5ForCausalLM"]
```

Run against `@huggingface/transformers` **4.2.0**, the version in `package.json`, every candidate
below was filtered this way first. Supported: `llama`, `qwen3`, `qwen3_5`, `qwen3_5_text`,
`qwen3_5_moe_text`, `lfm2`, `gemma3_text`, `granitemoehybrid`, `apertus`. Not supported, and
therefore not a conversion job but an upstream one: `nanbeige`, `fuse3`, `bailing_hybrid`, `Motif`.
The hub having an ONNX export of `nanbeige` does not change this — somebody built it for a runtime
that is not ours.

The other thing worth pricing before choosing: **the conversion pipeline was deleted three commits
ago.** `ffa40f1` removed `tools/convert_antares.py`, `quantize_onnx.py`, `verify_onnx.py`,
`tools/pyproject.toml` and `uv.lock`. Exporting anything ourselves means standing a Python toolchain
back up. None of the recommendations below need it — a usable export already exists for each — but
"we can build our own" currently costs a reinstated `tools/` tree, not an afternoon.

Constraint 4 is the one that is easy to forget and hardest to work around, so here it is as a table —
`1.5 GiB / (vocab × 4)`, the prompt tokens a full-sequence-logits export can take:

| `vocab_size` | prompt tokens |
|---|---|
| 65 536 | 6144 |
| 100 352 | 4012 |
| 131 072 | 3072 |
| 151 936 | 2650 |
| 262 144 | 1536 |

**Recommended, in order.**

- **`onnx-community/Qwen3.5-0.8B-Text-ONNX`** (`1e45daba…`) — the best fit found, and it exists
  because Qwen3.5 shipped small in Feb 2026 (0.8B, 2B, 4B, 9B; Qwen3.6 in April went 27B and up, so
  there is no smaller successor to wait for). Three things had to be true and all three are:
  - **The architecture is first-class in the pinned runtime.** `Qwen3_5ForCausalLM` /
    `qwen3_5_text`, mapped in 4.2.0. This was the real risk and it is worth saying why: Qwen3.5's
    `layer_types` alternates `full_attention` with **`linear_attention`**, a recurrent state that
    ordinarily neither exports cleanly nor caches like a KV. The library special-cases exactly this,
    naming `qwen3_5_text` beside `qwen3_next` and `olmo_hybrid` in its cache builder. The hybrid is
    handled, not merely tolerated.
  - **It is the text-only export.** The headline `Qwen3.5-0.8B-ONNX` is
    `Qwen3_5ForConditionalGeneration` and carries a vision encoder; this one is a single graph, so
    there is no `components` list and nothing fetched that a chat never touches. q4 is a 4 KB graph
    plus a **551 MB** sidecar — under LFM2 1.2B, for a newer model.
  - **The 248 320 vocabulary does not bite.** By constraint 4 that is 1621 prompt tokens, which
    would be disqualifying. But the graph takes **`logits_to_keep`** — verified by reading the
    protobuf, the same way Gemma 4's export was checked in §10.15 rather than assumed — so it
    materializes one row, takes `prefillLogits: "last"`, and lands on the 8192 working ceiling.

  Dialect is **`hermes`**, already verified: the template writes `<tool_call>`/`</tool_call>`,
  `<tool_response>` and `<think>`. That last one matters beyond this entry — it is the checkpoint
  that would finally capture hermes' **uncaptured `<think>` transcript**, the gap AGENTS.md has
  carried since §10.11 for want of a reasoning model that loads. Context 262 144.

- **`onnx-community/granite-4.0-h-1b-ONNX`** (`fe3928cd…`) — **and a correction: §10.19's first pass
  rejected this on the wrong evidence.** The repo carries no `transformers.js` tag and no
  `library_name`, and that was read as "unsupported". The tag is missing; the support is not.
  `granitemoehybrid` is in 4.2.0's mapping as `GraniteMoeHybridModel`, which is the check that
  counts. Absence of a hub tag is absence of metadata, and inferring a capability from it is the
  same species of error as §10.14's — reading a limit off the wrong layer. Its template emits
  `<tool_call>\n{"name": …, "arguments": …}\n</tool_call>`, which is `hermes` exactly; q4 is
  1.019 GB sharded; vocab 100 352 (4012 tokens even the pessimistic way, and it takes
  `logits_to_keep` too); context 131 072. IBM documents tool use as a first-class capability, which
  none of the sub-1B candidates can say.

- **`onnx-community/LFM2.5-350M-ONNX`** (`2c07371c…`) — `Lfm2ForCausalLM`, vocab 65 536, q4 is a
  4 KB graph plus a **294 MB** sidecar. Six times smaller than the current default for a model that
  still writes real tool calls. **Its dialect is `lfm2`, not `lfm2.5`** — the card documents Pythonic
  calls between `<|tool_call_start|>` and `<|tool_call_end|>`, which is exactly `lfm2.ts`, and its
  chat template ends the generation prompt with a bare `<|im_start|>assistant\n` where the 2.6B ends
  with `assistant\n<think>`. It does not reason, so `lfm2.5`'s prompt-opened `splitThinking` would be
  wrong on it. This is §10.2's rule paying out again: the name says 2.5, the grammar says 2. Card
  sampling: temperature 0.1, top-k 50, repetition penalty 1.05. Card says 32 768 context where
  `config.json` says 128 000 — believe the card.
- **`onnx-community/Qwen3-0.6B-Instruct-ONNX`** (`54250909…`) — `Qwen3ForCausalLM`, the verified
  `hermes` grammar (`<tool_call>`, `<tool_response>`, `<think>`), and the one candidate that would
  **close the gap AGENTS.md still records**: `hermes`'s `<think>` path is uncaptured because Qwen2.5
  does not reason and Qwen3 1.7B could not be run. This one reasons and does load. The catch is
  constraint 2 — `transformers.js_config` is null, so there is **no sidecar**, and q4 is a single
  997 MB file, 3 MB under the ceiling that `std::bad_alloc` sits behind. That margin is not a
  margin. List `q8` (754 MB, `model_quantized.onnx`) first and treat q4 as the gamble it is. Vocab
  151 936 → 2650 prompt tokens.

**Considered and rejected, with the reason** — these are the useful half, because each one looks
plausible from its name or its download count:

| candidate | why not |
|---|---|
| `onnx-community/Bonsai-1.7B-ONNX` | 8826 downloads, the most of any recent export, and it is a trap: the base is `Bonsai-1.7B-**unpacked**`, an fp16 re-inflation of a 1-bit model whose own authors say "the 1-bit format is where all the benefits come from" and discourage this repo. No documented tool calling. |
| ~~`onnx-community/granite-4.0-h-1b-ONNX`~~ | **Rejected in error; now recommended above.** The missing `transformers.js` tag is missing metadata, not missing support. |
| `Nanbeige/Nanbeige4.2-3B` | 687 likes and trending, and there are already three community ONNX exports of it — but `model_type: nanbeige` is **not in 4.2.0's mapping**. The exports are real; they are for a runtime that is not ours. Nothing we can convert our way past. |
| `openbmb/MiniCPM5-1B` | The near miss. `model_type: llama`, so the best-supported architecture there is; 1.08B; 955 k downloads. It emits **`<function name="foo">…</function>`**, which is a sixth dialect. Worth reconsidering if a dialect is ever cheap, since everything else about it fits. |
| `Akahsizrr/fuse-1-Lite` (`fuse3`), `Motif-Technologies/Motif-3` (`Motif`, 314 B params), `inclusionAI/Ling-3.0-flash` (`bailing_hybrid`, 127 B) | Architecture not in the mapping, and the last two are two orders of magnitude too large regardless. |
| `XYZAILab/XYZ-Aquila-mini` | `qwen3_5_moe_text` **is** supported — and "mini" is 35 B parameters. |
| `SupraLabs/Supra2-100M-Instruct` | `qwen3`, supported, 100 M — but `max_position_embeddings` is **2048**, shorter than a single tool result plus history. |
| `onnx-community/Apertus-v1.1-*-Instruct-ONNX` | Tools reach the template as a pre-formatted `developer_content.formatted_tools` string, not the standard `tools=` schema list, so `apply_chat_template(tools=…)` does not populate them. Context is **4096**. |
| `onnx-community/functiongemma-270m-it-ONNX` | Purpose-built for function calling like LFM2 1.2B Tool, 801 MB sharded q4 — but a **sixth dialect**: `<start_function_call>call:name{arg:<escape>v<escape>}<end_function_call>`, matching nothing here. Google's card says it is "not intended for use as a direct dialogue model" and expects fine-tuning. Vocab 262 144 → 1536 prompt tokens. Revisit only if a purpose-built caller is wanted enough to pay for the dialect. |
| `emb1ter/RhymeAI-Gemma-4-E4B-v3-ONNX-WebGPU` | Publishes **q4f16 only**. Constraint 1, decided before anything is downloaded. |
| `nicolasembleton/LFM2.5-2.6B-ToolACE-n3000-ONNX` | A ToolACE tool-calling tune of the current default, which is the interesting idea here — published **fp32 only, 11.8 GB**. |
| `onnx-community/LFM2-8B-A1B-ONNX`, `LFM2-24B-A2B-ONNX` | q4 is 5.3 GB across three shards, and up. |

**One worth a second look: `LiquidAI/LFM2.5-230M-ONNX`** (`c6f46e4e…`, vendor-published, same
provenance argument that chose Liquid's own 2.6B build). Vocab 65 536, q4 a **211 MB** sidecar. It
also ships **`q4f32`** (403 MB), and that is a name this registry cannot currently express: `Dtype`
is `q4 | q4f16 | fp16 | q8 | fp32` and `DTYPE_SUFFIX` has no `_q4f32`. §10.18's lesson about naming
the same file as transformers.js applies — adding the dtype is a two-line change, guessing it is a
404.

**Nothing here has been loaded.** This is a paper survey off model cards, `config.json`,
`transformers.js_config`, blob sizes, one grep of the pinned runtime and one read of two ONNX
graphs' inputs — which is exactly enough to *reject* on constraints 1, 2 and 4 and on architecture
support, and not enough to *add*. AGENTS.md's rule stands: a registry entry must name a build that actually
loads, and `Dialect.verified` needs a transcript, not a card. Each recommendation above is a
candidate for a `make model` pull and a real turn on `/agent/`, in that order.

### 10.20 Running the survey's picks: three bugs between a good model and a working one (2026-08-10)

§10.19 was paper. This is what happened when the three recommendations were added to the registry,
pulled with `make model` and driven through `agent.spec.ts` on the real GPU. **Qwen3.5 0.8B now
works end to end.** Getting there cost three fixes, and not one of them was the thing the survey was
worried about — the architecture support, the sizes and the prefill arithmetic were all fine exactly
as predicted. Everything that broke was in the seam between our prompt and their tokenizer.

#### 1. We were sending the model a JSON Schema `$schema` URL, and the small one copied it

LFM2.5 350M's very first turn:

```
<|tool_call_start|>[run_terminal_command($schema="https://json-schema.org/draft/2020-12/schema",
cwd="/mnt/host", env={"key": "value"}, stdin="", timeout_ms=0, max_output=0)]<|tool_call_end|>
```

`error: expected an identifier at 22`. The dialect was right, the markers were right, and the call
was garbage: the model had transcribed the *schema's keys* instead of filling them in, starting with
the first key it saw. `$schema` and `title` are JSON Schema **document** metadata that `tool.ts` puts
in `inputSchema`, and `openaiTool()` hands the whole object over as `function.parameters`. Note
`env={"key": "value"}` — there is no such example anywhere in the schema; it read
`additionalProperties: {type: string}` and invented a specimen.

`ToolRegistry.definitions()` now strips both keys. It is done there rather than at the source because
`docs/schema/*.json` are published documents where `$schema` belongs and `TestArtifactsAreCurrent`
pins them to the Go types; `definitions()` is the only path that becomes prompt text. Same turn,
after the strip:

```
<|tool_call_start|>[run_terminal_command(cmd="ls")]<|tool_call_end|>
```

**This was never a 350M problem.** Every model in the registry has been paying for that URL in every
prompt of every turn; the small one just failed loudly enough to show it.

#### 2. Qwen3.5's `<tool_call>` markers are hermes'. Its body is not.

The entry shipped as `dialect: "hermes"` on the strength of reading the chat template, which writes
`<tool_call>`, `<tool_response>` and `<think>`. What the model emits:

```
<tool_call>
<function=run_terminal_command>
<parameter=cmd>
ls /mnt/host
</parameter>
</function>
</tool_call>
```

Outer markers identical, body XML rather than JSON — `tool call body is not valid JSON: Unexpected
token '<'`. This is the `qwen3_coder` format, and the **model card names it**: it tells vLLM and
SGLang users to pass `--tool-call-parser qwen3_coder`. The information was there; the inference from
markers to grammar was wrong. That is §10.2's rule holding for the third time, and the sharpest
version of it yet — LFM2 was documentation contradicting behaviour and LFM2.5-350M was a *name*
implying a dialect, but this one had the right markers and still the wrong grammar.

New `qwen3.5` dialect, `verified: true` off the captured turn. Two details are load-bearing and both
came from the transcript rather than from thinking about it:

- **The model emitted one more `</parameter>` than it opened.** The fixture keeps the duplicate, and
  the non-greedy match tolerates it, because a real model did this on the first turn ever run.
- **The XML wire has no types, and `decodeArgs` is strict.** `cmd` must arrive a string and
  `max_output` a real integer, so values are JSON-parsed with a fall back to the raw text —
  `1024` becomes a number, `ls /mnt/host` stays a string.

#### 3. The export's stop token was the base model's, so the model wrote the user's next message

With the XML parsing, the call was right and the run still failed. The model finished its turn, and
then kept going:

```
</tool_call><|im_end|>\n<|im_start|>user\n<think>\n\n</think>\n\n<tool_call>…
<|im_start|>user\n<tool_response>\nFilesystem type: filesystem\nName: /mnt/host\nSize: 506MB…
```

It wrote the user's turn, a second call, and a **fabricated `<tool_response>`** full of invented
output. That reads like hallucination. It is two integers:

| where | says |
|---|---|
| `generation_config.json` | `eos_token_id: 248044` |
| `tokenizer.json` | `248044` is `<\|endoftext\|>` |
| `tokenizer_config.json` | `eos_token: <\|im_end\|>` |
| `tokenizer.json` | `<\|im_end\|>` is **248046** |

The export carried the **base** model's EOS into a chat checkpoint. Nothing in a conversation emits
`<|endoftext|>`, so generation ran to `max_new_tokens` every time. `GenerationDefaults` gains
`eos_token_id` (checked against the bundle first, as that interface requires) and the entry sets
248046, read out of this checkpoint's own tokenizer.

#### What each model actually did

| entry | load | tool call | verdict |
|---|---|---|---|
| **Qwen3.5 0.8B (text)** | 3.0 s | `ls -la /mnt/host` | **passes `agent.spec.ts`** — right path, real output, answered from it |
| **Granite 4.0 H 1B** | 5.2 s | `ls -R /mnt/host`, `cwd=/mnt/host` | correct call and correct answer; spec red for a reason on our side — below |
| LFM2.5 350M | 1.6 s | `ls` | parses, reaches the guest, exit 0 — then ignores the path it was given and lists `/` |

LFM2.5 350M is Qwen2.5 0.5B's finding one step further along (§10.11): the syntax is right *and* the
call now executes, but the target is wrong, and it then described the root filesystem as if it were
the user's folder. Registry note says so. It stays for the same reason Qwen2.5 does — it is 294 MB
and it exercises the loop.

#### 4. Granite found a bug in the mount, not in itself

Granite behaved best of the three: it is the only entry so far to set `cwd` as well as `cmd`, it
reached for `ls -R`, and it wrapped `arguments` as a JSON *string* rather than an object — which
`parseCallBody` already accepted, so `hermes` was the right dialect after all. It then answered
correctly, naming `hello.txt`, `link.txt` and `sub`.

`agent.spec.ts` still failed it, on `expect(step.exitCode).toBe(0)`. Run outside any model:

```
$ ls -R /mnt/host          # exit 1
/mnt/host:
hello.txt  link.txt  sub

/mnt/host/sub:
nested.txt

ls: cannot open directory '/mnt/host/hello.txt': Not a directory
ls: cannot open directory '/mnt/host/sub/nested.txt': Not a directory
```

**The listing is complete and correct; only the exit code is wrong.** This is §10.x's missing
`d_type` again, and the first guess about it here was wrong in an instructive way: `ls -R` was
assumed to fail like `find` does, silently not recursing. It does the opposite. Without `d_type` it
cannot tell a file from a directory, so it `opendir()`s *everything* — which is why it recurses
correctly — and banks one `ENOTDIR` per regular file, exiting 1. `find` trusts `d_type` and gives up;
`ls` distrusts it and brute-forces. Same missing field, opposite symptoms, and only one of them was
pinned.

Now both are: a second `KNOWN GAP` case sits beside the `find` one, asserting exit 1, a complete
listing, and `Not a directory` on stderr. Conformance 46 → **47**.

The wider point is about what a model is for here. Three entries were driven through one prompt, and
the best-behaved of them went straight at a gap in the mount that eighteen months of hand-written
conformance cases had left uncovered — because a person writing cases writes the commands they
already know work, and a model reaches for the command that is *right*.

**The pattern across all three.** Every failure was a place where we believed a file over a
transcript: the schema we send, the grammar we inferred from markers, the stop token the export
declared. §10.19 could reject candidates from metadata because the constraints it checked were
*mechanical* — a byte count, an architecture string, a graph input. Nothing about behaviour survived
contact, and nothing about behaviour was knowable without the GPU.

### 10.21 The prefill is chunked, so the chat stops walking into the device (2026-08-10)

Reported as "sometimes a model throws an OOM for the GPU mid-chat, or says some memory limit has
been hit". Both halves of that are the same allocation, and §10.10 and §10.16 had already named it.
What neither did was stop making it.

**Where the limits actually are.** Four, and only one of them is what the report is about:

| # | Limit | Symptom | What it is |
|---|---|---|---|
| 1 | Prefill logits readback, `N × vocab × 4` | mid-chat OOM; also our own `prompt-too-long` | The buffer-mapping staging allocation. **Fixed here.** |
| 2 | Total device residency — weights + KV cache + activations + (1) | Firefox dying inside a budget Chromium survived | Not queryable from WebGPU, on any browser. No arithmetic over `vocab_size` can produce it. |
| 3 | Wasm-heap weight load, ~1 GB single-file | `std::bad_alloc` / `RangeError` at load | `INLINE_WEIGHT_CEILING_BYTES` (§10.18). A different phase, already refused up front. |
| 4 | Session poisoning after a failed allocation | "the chat breaks" | Already handled (§10.10 part 4): drop the session, rebuild, retry once. |

**Why (1) grew.** Most exports here declare their logits as `[batch, sequence_length, vocab_size]`,
so onnxruntime maps `N × vocab × 4` bytes back to the CPU per prefill — and the agent loop re-sends
the *entire* conversation on every tool round trip, so N grows by a tool result each iteration. The
answer from M9 to §10.20 was to bound N: divide a 1.5 GiB budget by the vocabulary and refuse
anything longer. It worked, and it cost LFM2.5 2.6B ~3145 prompt tokens of a 128 000-token context,
and it never stopped guessing — §10.16 is the record of the guess being wrong in both directions on
the same day.

**The change: N is no longer a function of the conversation.** Two things, both ordinary
transformers.js, neither reaching into the library:

1. **Chunked prefill.** The prompt is handed to `generate()` a chunk at a time, each call asked for
   one token that is thrown away, so what a prefill materializes is `chunk × vocab × 4` whatever the
   chat does. `PREFILL_CHUNK_BUDGET_BYTES` is 256 MiB — an order of magnitude under the 2.15 GB
   §10.10 measured working, because a chunk is a batch size rather than a capability and the room
   left over is room for limit (2).
2. **The KV cache survives the turn.** So a tool round trip forwards only the tokens that are new.
   Passing `past_key_values` with the *full* prompt makes transformers.js trim it to what the cache
   does not cover (`decoder_prepare_inputs_for_generation`), and `return_dict_in_generate` is what
   keeps the cache alive past the call instead of disposing it.

The kernel backend has done (2) since M12 — `GemmaKernelEngine.stream()`, same prefix rule — so this
is the onnxruntime path catching up to it. `commonPrefix` moved to `prefix.ts` to serve both.

```
per turn before:  prefill(N=4000 tok) → 4000 × 128k × 4 = 2.0 GB   ← the report
chunked:          8 × prefill(512)    →  512 × 128k × 4 = 262 MB
chunked + reuse:  prefill(delta=300)  →  300 × 128k × 4 = 154 MB
```

**Two things that would have been silently wrong.** Neither fails loudly, which is why they are
pure functions in `prefill.ts` with tests rather than comments in the worker:

- A prompt **identical** to the cache has nothing left to forward, and transformers.js reads that
  case as "input_ids holds only unprocessed tokens" — it re-runs the whole prompt on top of a full
  cache. So an exact match starts over, exactly as the kernel path already did.
- The cache stops **one token short** of the sequence `generate()` returns: the last id it sampled
  was never fed to a forward pass. Recording the sequence itself would claim a position the cache
  does not have and the next turn would skip a token.

**What this does to the budgets.** `maxPromptTokens()` loses its `vocab_size` term and becomes
`min(contextTokens, AGENT_WORKING_TOKENS)` — a context and latency clamp, which is what it should
always have been. LFM2.5 2.6B goes from ~3145 prompt tokens to 8192. Everything downstream stays
exactly as it was: `prompt-too-long`, `device-lost`, `shrinkBudget()`, and the learned per-machine
ceilings under `smolbox.prefill-ceilings`. They are now reachable only through limit (2), which is
the one case chunking cannot answer, and a page that reaches them is telling us something we cannot
measure any other way.

**Coverage**, all GPU-free and in CI: the chunk arithmetic per entry and that one token more does not
fit (`models.test.ts`), that the prompt ceiling no longer varies with the vocabulary, and the window
decision in every shape — extend, diverge, exact match, shorter-than-cache, and the tail the
generating call is left to prefill (`prefill.test.ts`).

**Still open.** Limit (2) has no fix here, only more room. And §10.16's "not fixed" stands: the
rebuild after a device loss happens on the same onnxruntime module and therefore the same WebGPU
device, so a browser that genuinely *loses* the device will reload successfully and fail again. Only
tearing down the worker would help, and that is its own change.

### 10.22 The mount was dating every file to 1970, and a theory that did not survive (2026-08-10)

Found while looking for the cause of §10.20's two `KNOWN GAP` cases, and worth recording in that
order because the search failed and the finding is real anyway.

**What is actually wrong.** `browser_wasi_shim`'s `Filestat` constructor takes `(ino, filetype,
size)` and hardcodes everything else: `nlink = 0n`, `atim = mtim = ctim = 0n`. `toFilestat` in
`worker-fd.ts` used it as-is, and `StatResponse` had nowhere to put the missing fields anyway. So
every entry under `/mnt/host` reached the guest dated to the epoch:

```
d--------- 1 root root    0 Jan  1  1970 .
---------- 0 root root   21 Jan  1  1970 hello.txt
l--------- 0 root root    0 Jan  1  1970 link.txt -> hello.txt
d--------- 0 root root    0 Jan  1  1970 sub
```

This is **browser-only**: under wazero the mount is a real OS directory through
`WithReadOnlyDirMount`, so nlink and the timestamps are the file's own. Which is why no conformance
case caught it — the shared table ran green on the side that was broken because it was green on the
side that was not.

And it left the product. Both GPU runs recorded in §10.21 have the model telling the user their files
were "created on Jan 1, 1970", because that is what `ls -la` said. `ls -lt`, `find -newer` and
`find -mtime` had nothing to work with either.

**The fix is free.** The File System Access API hands `lastModified` over on every `File`, and
`getFile()` was already being called for the size. `StatResponse` gained `mtimeMs` and `nlink`;
`toFilestat` sets `mtim`, and sets `atim`/`ctim` to the same value rather than leaving them at zero,
because this filesystem knows one timestamp and answering "epoch" for the other two is confidently
wrong where repeating what we know is merely imprecise. Directories have no `File` and therefore no
date: absent, not invented — a fabricated mtime sorts wrongly where a missing one sorts last.

`nlink` is now 1 everywhere, which is a claim rather than a count: there are no hard links here to
count, and 1 is the conventional way to tell fts not to derive a subdirectory count from it. **0 is
in nobody's contract**, which is the whole reason it was worth changing.

**The theory that did not survive.** The reason nlink was looked at at all: fts sizes a directory's
remaining subdirectories as `st_nlink - 2`, and `0 - 2` is exactly the shape of a `find` that does
not recurse — §10.20's first `KNOWN GAP`. It was a good theory and it is wrong. With nlink reported
as 1 and real mtimes flowing, **all 22 conformance cases still pass in both drivers, including both
`KNOWN GAP` cases**: `find` still does not recurse and `ls -R` still exits 1. §10.20's diagnosis
stands — it is `d_type`, and the WASI dirents this bridge emits already carry the right one
(`fd_readdir_single` passes `e.type` straight through), so the loss is inside container2wasm's guest
driver rather than anywhere in this repo. Not fixable here without patching and rebuilding the VM.

Also not fixable: the `---------` mode column. WASI `filestat` has no mode field at all, so there is
nothing to send; c2w synthesises it.

**Pinned** by a new conformance case — `find /mnt/host/hello.txt -newermt 2001-01-01` and an
`ls -l --time-style=+%Y` that must not say 1970 — which passes in both drivers now and was checked to
**fail** in the browser with the fix reverted, because a new test that would have passed anyway pins
nothing. Conformance 47 → 48. Unit 452 → 455.

**Three things checked and deliberately left alone**, recorded so the next person does not re-derive
them:

- *The duplicate weight-fetch hack* (`model-worker.ts`) is not dead code now that IndexedDB serves
  weights. On a warm load the pre-pass issues no network GET at all; on a cold load it is still the
  only reason each weight file is fetched once. `model-cache.spec.ts` already asserts both halves.
- *The kernel path's quadratic decode* was re-measured against `max_new_tokens: 2048` rather than the
  256 its "irrelevant at these lengths" comment was written for. ~2.1M token-positions per turn, a
  couple of seconds of CPU against a generation whose GPU work runs into minutes. Still the wrong
  thing to optimise, now for a stated reason.
- *`MountHost`'s caches never expire*, so a file edited on disk mid-session stays stale inside the
  guest until the folder is picked again. That is the price of not re-stat'ing on every syscall, and
  `cat` of a large file is hundreds of syscalls. Documented on the class rather than changed.

### 10.23 Six follow-ups to the chunked prefill (2026-08-10)

Follow-ups to chunked prefill, in the order they stopped being guesses.

**Elision was fighting the cache it now shares a page with.** `elide()` trimmed to *exactly*
`promptBudgetChars`, so the next tool result put the prompt straight back over the line — and every
elision rewrites an older message, which is precisely what invalidates a prefix. A long conversation
therefore elided on every turn and re-prefilled itself on every turn, which is the cost §10.21
existed to remove. `ELIDE_TARGET_FRACTION` (0.7) trims well under instead, so one rebuild buys
several turns. The `elided` event carries how many times it has fired, because 0.7 is a choice and
that count is what will say whether it was the right one.

**The character budget stops guessing.** §10.16 lost a turn to `CHARS_PER_TOKEN_ESTIMATE` being 4
where the conversation ran at 3.85, and the error is in the direction that makes an oversized prompt
look acceptable — so a *refusal* was the only way to learn the real ratio. Every successful turn
measures it for free: the worker counts tokens with the real tokenizer, the loop already counted the
characters it sent. `generated` now carries `promptTokens` and `limitTokens`, and `calibrate()`
lowers the budget to what this conversation actually costs. Strictly downwards, like `shrinkBudget`:
a ratio measured from a short prompt is not evidence about a longer one.

**The registry no longer gets the last word on `prefillLogits`.** It is declared by hand from a graph
someone read once, and an entry claiming `"last"` against an export that does not take
`num_logits_to_keep` is §10.10's device death reintroduced by a registry line rather than by any
code. The graph is right there at load, so it wins, and the disagreement is logged.

It found one on its first live run: `lfm2.5-350m` declared nothing and its graph *does* take the
input, so it was being chunked for an allocation it never makes. All eight local graphs were then
checked by hand for the input name and for §10.20's `logits_to_keep` misspelling — one wrong, seven
right:

| entry | graph takes `num_logits_to_keep` | registry said | now |
|---|---|---|---|
| lfm2.5-350m | yes | (sequence, by omission) | **corrected to `last`** |
| qwen3.5-0.8b, granite-4.0-h-1b, gemma4-e2b-onnx | yes | last | unchanged |
| lfm2-1.2b-tool, lfm2.5-2.6b, qwen2.5-0.5b | no | (sequence) | unchanged |

**§10.16's "not fixed" is fixed.** The worker's own reload runs on the same onnxruntime module and
therefore the same WebGPU device, so a device that was genuinely *lost* survives it.
`WorkerModelClient` counts consecutive `device-lost` errors and, on the second, terminates the
worker, spawns a replacement and re-issues the load. Not on the first: an allocation failure does not
take the device away and disposing the sessions gives the memory back, which is the cheap fix and
usually works.

**The adapter's limits are logged once at load** — `maxBufferSize`,
`maxStorageBufferBindingSize`, vendor and architecture. Every out-of-memory report here so far is an
argument about numbers nobody had, and two of them were free. What is still not knowable: total
device memory, and what else on the machine is using it. No WebGPU API exposes either, which is why
§10.16's ceiling had to be learned by hitting it.

**And the GPU path got a lane that runs in 6.8 s.** `make test-e2e-agent-smoke` drives the same page,
loop and adapter against the smallest entry. It runs `agent-smoke.spec.ts` rather than
`agent.spec.ts`, and the difference is the point: the thorough spec asserts the model listed the
folder it was asked about, which is a claim about the *model*. LFM2.5 350M emits a perfect call and
then runs `ls` on `/` (§10.20), and Qwen3.5 0.8B did the same thing on one sampled run while this was
being written — at temperature 1.0 it is not deterministic, which is worth knowing about §10.20's
green. The smoke spec asserts only what this project's code controls: a parseable call, exit 0 from a
real guest, a non-empty result, prose after it, and no error events. That makes a bad small model a
perfectly good smoke model.

Unit 424 → 452. The default entry still passes `agent.spec.ts`.

### 10.24 python3 in the guest, a way out for files, and what both cost (2026-08-11)

Three changes that touch each other only at the edges: the guest got an interpreter, the pages got a
way to pull a file out of the VM, and the agent page got a status strip and a console. The numbers
are here because two of the three are paid for by every visitor.

**python3 costs 34.9 MB of wasm, which is more than the package.** `apk add python3` on Alpine 3.21
is Python 3.12.13 and reports 22 MiB installed; trimming `ensurepip`, `lib2to3`, `pydoc_data`,
`idlelib`, `turtledemo` and the stdlib's test trees takes `/usr/lib/python3.12` from 30.1 MB to
26 MB. The artifact moved further than that:

| | before | after |
|---|---|---|
| `smolbox/vm:dev` (docker disk usage) | 24.5 MB | 76.6 MB |
| `dist/smolbox.wasm` | 117,650,243 B | 152,559,919 B |
| the same, brotli (what is downloaded) | 35,222,075 B | 45,162,081 B |

So the wasm grew 29.7% for a package that installs 22 MiB, and the download a visitor actually pays
for grew 28.2% — c2w's rootfs image is not a tarball and does not shrink to fit. Anyone weighing
another `apk add` here should budget from the compressed artifact, not from `apk info -s`.

`__pycache__` (5.3 MB) was deliberately **kept**. Deleting it is the biggest single saving on offer
and it is the wrong trade: the alternative is recompiling stdlib modules on every invocation, inside
an emulated x86 where that is the expensive kind of work. Alpine ships it as its own package
(`python3-pyc`), so this is a decision, not an accident.

**What an interpreter costs per call.** Timed inside the guest with `date +%s%N`, on one session, so
boot is excluded:

| | |
|---|---|
| `echo` (a shell round trip) | 218 ms |
| `python3 -c pass`, first run | 2950 ms |
| `python3 -c pass`, again | 1530 ms |
| `python3 -c 'import json,re,argparse'` | 4162 ms |

A tool call that starts Python costs a second and a half at best and four seconds with a few imports
— against 218 ms for a shell pipeline. That ratio is why the agent's system prompt says to prefer a
pipeline for listing, searching and reading, and to reach for `python3 -c` when the work is real
computation or parsing. It is a fair trade there and a bad one for `ls`.

**Export is `dd` and `base64`, and it is fast enough.** Getting bytes out needed no protocol change:
`dd` seeks, base64 survives the response frame, and `web/src/export.ts` loops range reads. Measured
in the guest:

| | |
|---|---|
| `dd bs=512K count=1 \| base64` | 809 ms |
| `sha256sum` over 512 KiB | 700 ms |

So roughly 1.5–2 s per MiB, and `MAX_EXPORT_BYTES` (64 MiB) is about two minutes at that rate —
which is the honest reason for the ceiling, rather than any protocol limit. The chunk size is 512 KiB
because that base64s to 699,052 bytes, under the 1 MiB cap the request asks for and well under the
guest's own 1,162,808-byte frame ceiling; a `truncated` response is therefore impossible and is
treated as a hard error rather than a short read. One detail that would have been a silent corruption:
`base64` **wraps** its output (708,251 bytes came back for a 524,288-byte chunk), and busybox and
coreutils disagree about `-w0`, so the whitespace is stripped on this side instead.

**Unexplained: three compound scripts stalled past their own timeout.** While measuring the above, a
single exec running a multi-command script hung for minutes on three occasions — past a
`timeout_ms` that should have killed it and returned a `timed_out` response, which is the part worth
recording. Every command in those scripts ran fine on its own immediately afterwards, including the
exact ones that had been in the hung script, and the same script that hung once completed in 13.9 s
later. Nothing was reproducible, so nothing here is a diagnosis. The one lead worth writing down for
whoever meets it again: `reapOrphans()` in `guest/smolagentd/agent.go` drains with `Wait4(WNOHANG)`
in a loop that only breaks on an error, so a child that has not exited yet is a busy-spin — cheap on
real silicon, and a spin that starves the very child it is waiting for when PID 1 and that child
share one emulated CPU. That is a hypothesis, not a finding; it has not been instrumented.

### 10.25 Which checkpoints a browser can load unaided, and a flag that says so (2026-08-13)

The page had been deciding where to read weights from by probing: `haveLocalWeights()` HEADs
`/models/<repo>/config.json` and, on a 404, falls back to the hub. That was written as a
convenience for a workstation and had quietly become the deployment's configuration too — which
means what a visitor gets depends on which `make model` pulls happened to finish on the machine that
built it. A half-finished `make models` serves some entries locally, some from the hub, and says
nothing about either.

The prior question is which entries a browser can fetch for itself at all. **Answer: all eight** —
measured, not assumed, by an anonymous HEAD (with an `Origin` header, so CORS is included) on every
required file of each entry's preferred dtype, at the pinned revision:

| entry | preferred dtype | weights | `access-control-allow-origin` |
|---|---|---|---|
| lfm2-1.2b-tool | q4 | 1.22 GB, `.onnx_data` sidecar | present |
| lfm2.5-2.6b | q4 | 1.85 GB, sidecar | present |
| qwen2.5-0.5b-instruct | q4 | 786 MB, **inline, no sidecar** | present |
| qwen3.5-0.8b | q4 | 551 MB, sidecar | present |
| granite-4.0-h-1b | q4 | 1.02 GB, sidecar | present |
| lfm2.5-350m | q4 | 294 MB, sidecar | present |
| gemma4-e2b | (baked) | 2.46 GB `model.safetensors` | present |
| gemma4-e2b-onnx | q4f16 | 2 graphs, ~3.6 GB | present |

Two things worth knowing from that sweep. **`google/gemma-4-E2B-it-qat-mobile-transformers` is not
gated** — the usual Gemma license gate does not apply to this checkpoint, and an unauthenticated GET
returns the weights. And qwen2.5-0.5b is the only entry with no external-data sidecar, so it is the
only one whose single file has to stay under `INLINE_WEIGHT_CEILING_BYTES` (§10.18); it is at 786 MB
against a 1 GB line.

**A comment that was wrong in both halves.** The LFM2.5 2.6B entry claimed its q4f16 build "splits
its weights across two `.onnx_data` shards, which only the hub path handles". The shards are real —
this repo's `config.json` declares `transformers.js_config.use_external_data_format` as
`{"model_q4f16.onnx": 2}` and the hub serves `.onnx_data` and `.onnx_data_1` — but nothing about
them is hub-specific. `getModelDataFiles()` in `utils/model-loader.js` derives the chunk names from
that config and fetches each through the same `getModelFile()` that resolves a local path, so the
local branch sees identical filenames; and `weightFiles()` here probes the same names as optional
files, so `make model` pulls both shards too. What actually keeps q4 in front is `shader-f16`, which
was already the other half of the sentence. The real caveat outlived the invented one.

**So the source is a flag now: `SMOLBOX_MODEL_SOURCE`, defaulting to `hub`.** `local` is kept, does
exactly what the probe used to, and is what `make web-local` and the opt-in GPU suites build — those
must not re-pull gigabytes per run. It is a **build** flag (`bun build --define`, via the `web`
target) rather than a server one for a boring reason: `web/dist` is static and `make compress`
writes `.br`/`.gz` variants beside every file, so there is nothing left for `web/serve.ts` to rewrite
on the way out. The cost is that flipping it is a rebuild; what it buys is a page with no runtime
configuration to fetch, race on, or fail to fetch.

**One entry a hub build cannot offer, and it is not about its weights.** `gemma4-e2b`'s 2.46 GB are
on the hub and its engine reads them from there happily; the *engine* is the problem. It is a
dynamic import of `/kernels/gemma4/gemma-4-e2b.js`, which exists only after `make gemma-kernels`,
and it cannot be imported from the hub instead: the Space that publishes it declares no license
(which is why it is fetched rather than vendored, `web/fetch-kernels.ts`), and this page is
cross-origin isolated, so a cross-origin module import would need CORP headers nobody has promised.
Its registry entry therefore carries `requiresLocalBuild`, and on a hub build the dropdown shows the
option **disabled with the reason** rather than dropping it. Dropping it would make a checkpoint
that exists look like one that never did; `loadModel()` and `setModel()` refuse it as well, so the
path survives for debugging without being reachable from the page. (Superseded at §10.28: both
kernel engines now ship with the site, and neither entry carries `requiresLocalBuild`.)

### 10.26 The progress bar Pages took away, and the two displays that stopped at the download (2026-08-25)

Reported against the deployment, not seen locally: *"it seems to have lost the progress bar on
download? in the VM tab, it loads the VM, but there is a bar at the top that gets stuck on 'booting
the VM' even though it works. in the chat tab, it gets stuck on downloading, but its actually
finished the download and was waiting for me to start the model download (which has a correct
progress bar)."*

Three separate defects, all of them invisible under `make serve` and all of them in the first thirty
seconds a visitor spends on the site.

**1. GitHub Pages gzips the wasm, so the bar lost its denominator.** The bytes a `fetch()` reader
yields are decoded, so `Content-Length` on an encoded response counts the wrong thing —
`web/src/worker.ts` has always known that and refuses to divide by it, falling back to an
indeterminate bar. `web/serve.ts` supplies the identity size in `X-Uncompressed-Length` and the bar
works locally. Pages sends no such header:

```
$ curl -sSI -H 'Accept-Encoding: gzip' https://xen0bit.github.io/smolbox/smolbox.wasm
content-type: application/wasm
content-encoding: gzip
content-length: 56409697          # the identity file is 151229171
```

So for the whole ~150 MB download the deployment showed a bar with no fill and a byte counter, which
from the outside is a progress bar that has stopped working.

**Nothing in the browser can recover the number.** Script cannot remove `gzip` from
`Accept-Encoding` — it is a forbidden header name — and a Range request is no way round it either,
because Pages answers one against the *selected* representation:

```
$ curl -sS -D- -o /dev/null -H 'Accept-Encoding: gzip' -H 'Range: bytes=0-0' .../smolbox.wasm
content-range: bytes 0-0/56409697     # the compressed length, from a one-byte probe
$ curl -sS -D- -o /dev/null -H 'Range: bytes=0-0' .../smolbox.wasm
content-range: bytes 0-0/151229171    # identity, but only for a client that can refuse gzip
```

The size is only knowable where the file is, so it is measured at build time and substituted into
the bundle: `SMOLBOX_WASM_BYTES`, the third build define after `SMOLBOX_BASE` (§10.25 for the second
and the reason all three are defines rather than server config). It is consulted *last* — behind
`X-Uncompressed-Length` and behind `Content-Length` on an unencoded response — because it is the only
one of the three that can be stale, and the download drops it the moment more bytes arrive than it
allows for. The final progress message carries the true count rather than the estimate, so a bar
driven off a slightly stale flag still lands on 100%.

**2. Both pages read the VM's phase out of an English log line, and neither listened for `ready`.**
The worker posts `fetching wasm`, `instantiating wasm`, `booting the VM`, and the pages compared
that string against `"fetching wasm"` to decide whether the bar still had a job. Nothing else
consumed it, and nothing at all consumed the `ready` message, so:

- the VM page's header froze on `booting the VM` — which is posted *before* `wasi.start()`, so the
  last thing a working VM said about itself was that it was still starting. It used to say
  `ready (agent v…)` from the run button's own handler; b51968f turned that button into a terminal
  and the line went with it.
- the agent page's VM chip froze on `downloading`, because the only other thing that ever moved it
  was `bootVm()`, and the only caller of `bootVm()` is the start button. The reporter was looking at
  a chip that said "downloading" while the download had been over for minutes and the page was
  waiting on *them*.

The worker names its phase now (`{type:"log", message, phase}`) and `web/src/vm-status.ts` maps it,
so neither page parses prose and both follow the VM the whole way down. Both also listen for `ready`
and `exit`: the worker boots the VM without being asked, so a display that waits for a button before
it will admit the VM is up is describing the button.

**3. `progress { display: block }` outranked the `hidden` attribute.** The browser hides a `[hidden]`
element with `display: none` from the UA stylesheet, which *any* author `display` overrides. So the
VM page's bar was set hidden the moment the download finished and stayed on screen at 100%,
underneath a header frozen on "booting the VM" — which is exactly the "bar at the top that gets
stuck" in the report, read literally. The agent page escaped it only because `#progress-row[hidden]`
carries its own `display: none`, which is the same bug already worked around once without being
named. `progress[hidden] { display: none }` now sits beside the rule that caused it.

This one was found by the e2e assertion rather than by reading: `toBeHidden()` fails on an element
whose `hidden` attribute is set but whose CSS keeps it painted, which no amount of checking
`el.hidden` from a driver script would have caught.

**Verified against a stand-in for Pages** — `_site` under `/smolbox/`, no COOP/COEP, `smolbox.wasm`
served gzipped with the encoded `Content-Length` and no `X-Uncompressed-Length` — driven with
Chromium, before and after:

```
before   bar=[indeterminate]  status=[loading smolbox.wasm… 94.1 MiB]
         bar=[hidden*]        status=[instantiating wasm]
         bar=[hidden*]        status=[booting the VM]        ← and it stops there
after    bar=[68%]            status=[loading smolbox.wasm… 68% (98.2 MiB of 145.5 MiB)]
         bar=[hidden]         status=[instantiating smolbox.wasm…]
         bar=[hidden]         status=[booting the VM…]
         bar=[hidden]         status=[ready (agent v0.0.1)]

before   bar=[indeterminate smolbox.wasm — 93.1 MiB]  chip=[loading | VM downloading]
         bar=[hidden]                                 chip=[loading | VM downloading]   ← and it stops there
after    bar=[66% … 95.3 MiB of 145.5 MiB (66%)]      chip=[loading | VM downloading]
         bar=[hidden]                                 chip=[loading | VM instantiating]
         bar=[hidden]                                 chip=[loading | VM booting]
         bar=[hidden]                                 chip=[ready | VM agent v0.0.1]
```

(`hidden*` is the attribute being set while defect 3 kept the element painted — the driver was
reading `el.hidden`, which is why the "before" column understates how bad the VM page looked.)

### 10.27 Bullseye left LTS, and c2w's emulator stages stopped building (2026-09-25)

The `pages` workflow (run 36134877527, `workflow_dispatch` on `b23aecf`) failed in `make wasm`, in
c2w's embedded `bochs-dev-common` stage:

```
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/g/git/git_2.30.2-1%2bdeb11u5_amd64.deb  404  Not Found
```

It reproduces outside CI against a bare `rust:1.74.1-bullseye`, so it is not a flaky mirror. Debian
11's LTS has ended. `deb.debian.org/debian-security/dists/bullseye-security/Release` still serves an
index (dated 2026-09-12) listing `deb11u*` builds, but their pool files are gone, and
`archive.debian.org` has no `bullseye-security` yet. The main `bullseye` suite still resolves on
both hosts.

The stage runs `apt-get install -y make curl git gcc xz-utils`, and the image already ships all of
those tools (git is installed at `deb11u2`). apt only fetched anything because the security index
offered newer versions. With the `debian-security` line removed from `/etc/apt/sources.list`, the
same install succeeds from `bullseye` main.

The fix does not touch c2w itself. c2w builds from its **embedded** Dockerfile, and `/assets` is
only a named build context. Its `--dockerfile` flag replaces that file, though, so
`build/Dockerfile.c2w` dumps it with `c2w --show-dockerfile` to `/c2w.Dockerfile` and rewrites the
two identical install lines (one each in `tinyemu-dev-common` and `bochs-dev-common`, both
bullseye). `make wasm` passes `--dockerfile /c2w.Dockerfile`. The rewrite asserts that it matched
exactly twice, so a c2w bump that changes those lines fails `make builder-image` instead of
building the unpatched file.

This only drops security updates for build-time tools in a throwaway builder stage. Nothing from
those stages reaches the guest except the compiled emulator. When `archive.debian.org` picks up
`bullseye-security` this could be repointed instead, but there is nothing to gain from that.

### 10.28 Ternary Bonsai 2 27B on the WebGPU kernels (2026-09-25)

The model is `prism-ml/Ternary-Bonsai-2-27B-gguf` @ `b072e1d3`, an Apache-2.0 ternary quantization
of Qwen3.8-27B (hybrid attention, about 75% linear). The engine comes from
`webml-community/ternary-bonsai-2-webgpu-kernels` @ `94320c9d`. It is the same runtime family as
the Gemma 4 kernels (§10.17), and the model lands as registry entry `bonsai2-27b`. All numbers
below were measured on this machine (RTX 4070 Ti SUPER, 16 GB, headless Chromium with
`--use-angle=vulkan`). The adapter reports `shaderF16: false`, `subgroups: true` and
`subgroupMatrix: true`.

**The engine is not published as a module.** The Space is one static `index.html` (1.55 MB). Its
second `<script type="module">` is the engine, an ES module ending in
`export{…,zl as TernaryBonsai2,…};`, with the page's own app code appended after it. That app
code reads the DOM at top level, so the whole block cannot be imported in a worker.
`web/src/agent/bonsai-extract.ts` cuts at the export statement, anchored on the exported *name*
because minified identifiers change per rebuild. The cut must match exactly once. `make
bonsai-kernels` pulls it into gitignored `dist/kernels/bonsai/` at a pinned revision.

**It maps onto the Gemma seam with less adaptation, not more.** `TernaryBonsai2.load(url, {onProgress})`
returns a session whose `model`, `generationState`, `eosTokenIds`, `reset()`, `dispose()` and
`deviceInfo()` are public fields. Gemma exposes the same things behind underscores. The
prefix-cache bookkeeping moved out of `gemma-kernels.ts` into `kernel-engine.ts` and now serves
both engines. Two things carried over unchanged, and both would break tool calling: the engine
renders its own template with `tools: null`, and it decodes with `skip_special_tokens`. So the
prompt is rendered here instead.

**There is no transformers.js tokenizer to load.** The repo is GGUF files and nothing else: no
`tokenizer.json` and no `config.json`. The tokenizer and the 8 952-byte chat template live in
the GGUF metadata. The engine's tokenizer exposes the template at `tokenizer.config.chat_template`.
So this backend brings a `PromptCodec` (render, encode, decode): the template is rendered with
`@huggingface/jinja` (now a direct dependency, pinned to the 0.5.9 transformers.js already uses)
and our tool schema, and ids go through the engine's tokenizer. A `gguf` weight layout names its
one file (`ModelEntry.ggufFile`), and `make model` fetches only that file.

**It loads and it calls tools.** PTQ1_0 (5.95 GB) loads in 31–37 s from local disk and decodes at
**40–47 tok/s**. Its first turn, with smolbox's system prompt and generated schema:

```
The user is asking about the number of files in their folder and the largest file. …
</think>

<tool_call>
<function=run_terminal_command>
<parameter=cmd>
find /mnt/host -type f | wc -l; echo "---"; find /mnt/host -type f -printf '%s %p\n' | sort -rn | head -5
</parameter>
</function>
</tool_call>
```

That is qwen3.5's XML grammar (§10.20) inside a scratchpad the prompt opened: the template ends
the generation prompt with a bare `<think>\n`, so a completion starts *inside* it. That is
lfm2.5's shape, not qwen3.5's "tagged" one, so this is a new dialect, `bonsai`, that reuses
qwen3.5's call parser with `prompt-opened` thinking. It is `structured`, because the template
rebuilds calls from `tool_calls` and wraps results in `<tool_response>`. It is marked verified
off the two CAPTURED turns in `bonsai.test.ts`. (The call itself uses GNU `find -printf`, which
busybox lacks; that is the model's mistake to correct, not the parser's.)

**Prefill without `shader-f16` is the cost, and it is linear.** Every fast ternary prefill kernel
in the engine declares `requires: shader-f16 + subgroup-matrix`. Without f16, the batched prefill
graph falls back to f32 kernels that are *slower* than feeding the prompt a token at a time
through the decode path:

| path | 761 tok | 1 762 tok | 3 762 tok |
|---|---|---|---|
| prefill graph (default) | 37.7 tok/s | 37.5 | 36.9 |
| `QWEN35_NO_PREFILL_GRAPH=1` | **51.1 tok/s** | 50.4 | 48.9 |

The engine reads that flag from `globalThis.process.env`. `bonsai-kernels.ts` sets it only when
the adapter lacks `shader-f16`, on an object with `env` alone, so that neither this engine nor
transformers.js mistakes the worker for Node. Even so, the first turn's ~900-token prompt costs
~18 s. A GPU exposing f16 takes the engine's intended fast path, and nothing here has measured
that.

**The cache cannot be rewound, so the prompt must never be rewritten.** Linear attention keeps a
recurrent state: `canTruncateTo(k)` is false and `rewindableLengthAtMost` is 0. A turn reuses
the cache only if its prompt *extends* the previous prompt plus completion token for token.
Otherwise the whole conversation is prefilled again, which is ~20 s per tool round trip at the
rates above. The template renders each past assistant turn as
`<think>\n{reasoning_content}\n</think>\n\n{content}` plus the rebuilt call. With the reasoning
replayed, turn 2 shared **993 of 993** tokens with turn 1's prompt and completion. Without it the
match stopped at 892, where an empty scratchpad was rendered in place of the real one. That is
`Dialect.replayReasoning`: history carries `content: prose` and `reasoning_content`. It is the
opposite of the model card's advice for llama.cpp tool loops (drop reasoning to keep context
small), because here the choice is between a longer prompt that is already cached and a shorter
one that has to be prefilled again. `bonsai.test.ts` pins the invariant through the real
`Conversation` and the real template text, with a control that turns the flag off.

**The engine's cache bookkeeping, measured rather than assumed.** On EOS, the cache holds the
prompt plus every yielded token. EOS itself is never yielded or forwarded, so the next rendered
prompt's `<|im_end|>` is simply new input. At the cap, the cache holds the prompt plus all but
the last yielded token, which was sampled but never fed back. That is exactly the rule the
Gemma adapter already applied, which is why the logic could be shared rather than forked.

**Through the real page, end to end.** `SMOLBOX_WEBGPU=1 SMOLBOX_MODEL=bonsai2-27b` on
`tests/e2e/agent.spec.ts` passes: a 30.0 s load from disk, then three well-formed calls against
the real VM (`ls -la /mnt/host`; a combined `ls`/`head`/`cat` of the subdirectory and the link;
`cat sub/nested.txt`) and an answer built from what they returned. That includes noticing that
the fixture's sizes and mode bits are nonsense while its contents are fine. It took 1.3 min in
total. The first run of that spec failed first, and usefully: the page decides local versus hub
by HEADing `config.json`, which a GGUF repo does not have, so a local build silently streamed
5.9 GB from the hub (a 175 s load). `localProbePath()` now probes the file the loader reads.

**Limits.** The engine allocates its generation state at `min(model, 16 384)` positions, so
`contextTokens` is 16 384, not the card's 262 144. The model card lists occasional malformed calls
and `// // //` loops as a known open issue. The template raises unless exactly one system message
comes first, which the loop already guarantees.

**Both kernel engines now ship with the Pages site.** Until this change the project treated the two
Spaces' missing license declarations as a bar to publishing their engines: they were fetched into
gitignored `dist/kernels/`, the site did not include them, and both kernel entries carried
`requiresLocalBuild`, so the deployed dropdown listed them disabled ("needs a local build"). That
reasoning was overcautious, and the owner overruled it. `make site` now runs `gemma-kernels` and
`bonsai-kernels` and copies `dist/kernels` into `_site/kernels/`. Neither entry is gated any more, so
both are selectable on a hub build. The Pages smoke test HEADs both engines after every deploy, and
`settings.spec.ts` asserts the entries are enabled on the hub build that `make test-e2e` serves. The
hub path itself was exercised by accident before it was deployed: the first GPU run's probe bug
(above) streamed the 5.9 GB GGUF from huggingface.co and reached `ready (hub, …)` in 175 s, which is
what a Pages visitor does.
