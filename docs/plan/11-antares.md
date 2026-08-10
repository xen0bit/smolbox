## 11. Component 2, continued: Antares as a supported model (M12–M14)

> **Removed from the tree on 2026-08-10.** Antares, the `/scan/` localization page and the Python
> conversion pipeline (`tools/`) are gone: `convert_antares.py`, `quantize_onnx.py`,
> `verify_onnx.py`, `scan-main.ts`, `localize.ts`, `host-tools.ts`, `tool-profile.ts`,
> `antares-prompt.ts`, the `antares` dialect and the two registry entries. §10.18 is why — the 1B is
> the only build that follows the protocol, its fp16 needs `shader-f16` this machine does not have,
> and its fp32 is 7.35 GB and did not finish loading in ten minutes. That left a page, a dialect, a
> gated download and a Python toolchain serving a model nobody here can run.
>
> This section stays as the record: the granitemoehybrid→granite remap, the muP parity check, the
> int4 measurement (0.816 logit correlation) and the fp16 converter finding are all still true, and
> all of them cost real work to establish. Read it as history, not as a description of the tree.

§9 proved a local model can drive the VM; §10 built a registry, dialects and a tool surface around
that. This section adds a model that is *not* a general chat model: Cisco Foundation AI's **Antares**,
a family trained end-to-end to localize vulnerabilities by exploring a repository from a terminal.
It is the first entry that comes with its own task, its own protocol and its own success metric, and
it is the first one whose weights this repo has to build rather than download.

**Status: design only — M12–M14 are scoped, none are implemented.** No code in this repo changes as
part of this section.

### 11.1 Research notes (verified 2026-08-05)

Sources: the Cisco blog post, the `fdtn-ai/antares-350m` model card, the technical report
(`cisco-foundation-ai.github.io/antares/technical-report.pdf`), and the full `antares-cli` source at
`~/Projects/infrastructure/ttyd/antares-cli`. Where the three disagree, that is recorded rather than
smoothed over — §9.1.3's lesson was that a vendor's documentation is a hypothesis.

1. **What Antares is.** Three decoder-only models — 350M, 1B, 3B — post-trained from IBM Granite 4.0
   checkpoints for *agentic vulnerability localization*. The task: given only a CWE category
   description and read-only terminal access to a repository, explore, gather evidence, and submit a
   **ranked list of file paths**. 350M and 1B are released open-weight (Apache 2.0); 3B is not.
   Training is SFT (cybersecurity reasoning, deep research, terminal trajectories) followed by GRPO
   against verifiable file-level localization rewards.
2. **The architecture is plain attention, despite the config's name — verified from the configs, not
   the report.** `fdtn-ai/antares-350m` declares `architectures: ["GraniteMoeHybridForCausalLM"]`,
   `model_type: "granitemoehybrid"`, which reads like a Mamba hybrid and is not one: its base,
   `ibm-granite/granite-4.0-350m`, carries `layer_types` of **28 × `"attention"`** with
   `num_local_experts: 0` and `num_experts_per_tok: 0`. The `mamba_*` keys are vestigial. The
   `granite-4.0-**h**-350m` sibling is the real hybrid (28 mamba / 4 attention) and is *not* what
   Antares is built on. `granite-4.0-1b` is likewise 40 × attention. Concretely, 350M is: 28 layers,
   hidden 1024, 16 heads / 4 KV heads (GQA), intermediate 2048, vocab 100 352, tied embeddings,
   RoPE (`rope_theta` 1e7), RMSNorm, SwiGLU, `max_position_embeddings` **32 768**, plus muP-style
   scalars (`embedding_multiplier` 12, `attention_multiplier` 0.015625, `residual_multiplier` 0.263,
   `logits_scaling` 4) that a conversion must preserve. 1B is 128K context.
3. **transformers.js already supports this architecture — checked in the installed copy, not the
   README.** `node_modules/@huggingface/transformers@4.2.0` maps `granitemoehybrid` →
   `GraniteMoeHybridForCausalLM` (`src/models/registry.js:283`) and builds its KV-cache names from
   `layer_types`, adding mamba conv/ssm state only for `"mamba"` layers
   (`src/configs.js:352`) — so an all-attention Granite gets an ordinary past-key-value cache.
   Its own doc comments even use `onnx-community/granite-4.0-350m-ONNX-web` as the example model id.
4. **That base conversion exists and is the recipe.** `onnx-community/granite-4.0-350m-ONNX-web`
   ships `model.onnx` (fp32, 1.42 GB external data), `model_fp16` (709 MB), **`model_q4` (576 MB)**
   and **`model_q4f16` (350 MB)**; `granite-4.0-1b-ONNX-web` exists too. Since Antares is a
   fine-tune of exactly these bases, the export path is proven for the architecture — what is
   unproven is only that the *fine-tuned weights* survive it, which is what M12 measures.
5. **No ONNX build of Antares exists, and the repo is gated.** The HF API lists `fdtn-ai/antares-350m`
   with `gated: "auto"` and only `model.safetensors` (705 MB, bf16); a search of `onnx-community` and
   of the hub at large for an Antares ONNX conversion returns **nothing**. So smolbox must convert.
   This is the single biggest difference from every other registry entry, where `make model` is a
   download. **Both checkpoints are now on disk** and every claim in this section marked
   "verified from the config" below was re-checked against the real files (§11.9).
6. **The tool-call syntax is Hermes-shaped — and this is verified from the checkpoint itself, not
   from documentation.** `chat_template.jinja` in the Granite 4.0 repos renders tool calls as
   `<tool_call>\n{"name": "…", "arguments": {…}}\n</tool_call>`, and the report's Appendix A.1 and
   the CLI's `_build_antares_investigation_prompt()` both instruct exactly that. smolbox's existing
   `hermes` dialect (`web/src/agent/dialects/hermes.ts`) already parses this shape. It is currently
   marked `verified: false`; Antares is the first chance to promote a variant of it from a captured
   transcript.
7. **The chat template does the prompt construction for us — the same bet as §9.1.4, and it holds
   for a second family.** Granite's template appends the tools block to the system message as
   `<system text> + "\n\n" + "You are a helpful assistant with access to the following tools…
   <tools>{one JSON object per line}</tools>… <tool_call>…"`. The CLI's system prompt is *literally*
   that concatenation, hand-built. So `apply_chat_template(messages, { tools })` with the Antares
   task prose as the system message reproduces the CLI's prompt without a line of hand-formatting —
   `web/src/agent/model-worker.ts` needs no change to build an Antares prompt.
8. **Tool results round-trip through the template too.** The template renders `role: "tool"` as
   `<|start_of_role|>user<|end_of_role|>\n<tool_response>\n…\n</tool_response><|end_of_text|>`, which
   is byte-for-byte what the CLI's `_serialize_granite_message` emits for its `tool_response` role.
   smolbox's loop already pushes `{ role: "tool" }`, so both directions are the template's job.
9. **The CLI leaves the template in one place, and the `<think>` prefill is not it — corrected against
   the real checkpoint (§11.9).** The CLI uses raw `POST /v1/completions`, not chat completions, and
   says why: "their server-side chat template changes the raw Antares tool prompt". It also prefills
   the assistant turn with `<|start_of_role|>assistant<|end_of_role|><think>\n`, which looked like a
   second deviation smolbox would have to reproduce by hand. It is not: **Antares ships a modified
   chat template**, and the only diff against the stock Granite 4.0 one is exactly that prefill —
   `add_generation_prompt: true` emits the `<think>\n` itself. The CLI hand-appends it *because* it
   bypasses the template. smolbox, which does not, gets it free.
10. **The exact tool set, from the report's Appendix A.1** — three tools, not four:
    `terminal(command: string, max_chars: int = 2000)`, `submit_vulnerable_files(ranked_files:
    string[])`, and `submit_no_vulnerability_found()` (no parameters). The CLI adds a fourth,
    `read_file(path, start_line?, end_line?)`, returning line-numbered text; the *evaluated* protocol
    that GRPO trained against did not have it. The CLI's `terminal` description also enumerates its
    allowlist, where the report's does not.
11. **The two submit tools never touch the sandbox.** They are how a run *ends*: the CLI's
    `SubmissionHandler` turns them into findings, validates every path resolves inside the repository
    with exact casing, dedupes, and ranks with a descending confidence. Nothing is executed. This is
    a tool kind smolbox does not have (§11.2).
12. **Budgets and sampling, from the CLI and the report.** Terminal-call budget defaults to **15**
    (`execution_policy.py`; range 1–50) and is interpolated into the system prompt itself, so the
    model is told its budget. Loop cap 50 iterations. Sampling: **temperature 0.3, top_p 1.0,
    frequency_penalty 0.3**, `max_tokens` 4096, context 16 384 (below the 32K the 350M supports),
    stop tokens `<|end_of_text|>` and `<|start_of_role|>`. Observation truncation is **2 000
    characters** in training and in the benchmark; the CLI raises its own ceiling to 12 000 while
    keeping the tool's `max_chars` default at 2 000.
13. **Observation formatting is the one place the report and the CLI genuinely disagree.** The
    report's Figure-2 loop and its Antares-3B trace append a per-observation footer —
    `[14 tool-calls remaining]`, and `[TRUNCATED -- 14852 total chars, showing first 2000]`. The CLI
    emits neither: it appends `\n[stderr]: …` and `\n\n[OUTPUT TRUNCATED: showing first 12,000
    characters. Use head/tail/sed with line ranges to read specific sections.]`, and mentions the
    budget only once it is spent ("Terminal call budget exhausted (15/15). Submit your answer."). The
    trained-against format is the report's. Treat this as **measurable**, not settled.
14. **The harness is worth ~5% of the score, which the authors measured.** Appendix C.3: FAPO
    prompt/config optimization moved Antares-3B from 0.223 to **0.235** File F1 with no weight
    change, mostly by raising the terminal budget 15 → **25**. Appendix C.2: adding an explicit
    explore-first / targeted-search / verify strategy to the system prompt moved it to 0.2313 and
    shifted the command mix (list/explore 10.2% → 17.3%, grep/search 52.3% → 46.2%). So harness
    details are a legitimate tuning surface, and the baseline is search-dominant.
15. **Absolute accuracy is low and that is the honest framing.** The model card gives Antares-350M
    **File F1 0.135** on VLoc Bench; 1B is ~0.19 and the unreleased 3B 0.223, against GPT-5.5 at
    0.229. The CLI's own README leads with it: "Antares reports candidate files for human review… Treat
    every result as a lead to verify, not as proof that code is vulnerable or safe." Any UI smolbox
    builds has to say the same thing.
16. **The guest is missing two of the tools the prompt advertises.** `vm/Dockerfile` is
    `alpine:3.21` + `coreutils findutils grep`. The Antares prompt names `rg` and `tree`; neither is
    installed, and the baseline policy spends **52.3%** of its calls on search. Everything else the
    prompt lists (`ls find cat head tail sed grep wc sort uniq cut file stat du pwd nl basename
    dirname realpath diff echo`) is present.
17. **The read-only assumption already holds here, for a different reason.** Antares was trained and
    evaluated in a read-only, network-less Docker sandbox, and the CLI enforces that with a ~900-line
    shell parser (`tools/shell_exec.py`) that stage-splits pipelines and allowlists commands. smolbox
    gets the same *guarantees* structurally: `/mnt/host` is `EROFS` through the bridge (proven by the
    conformance table), and the guest has no network at all. What smolbox does *not* get is the CLI's
    protection of the rest of the filesystem — a model can still `touch /tmp/x`. That is the existing
    design (§10.5: the sandbox is the boundary, not the schema), and it is unchanged here.
18. **Licensing.** Weights are Apache 2.0 but gated behind a click-through, so a conversion cannot be
    fully unattended and republishing is a decision with a licence question attached (§11.2). The CLI
    is a separate distribution with its own `LICENSE` and `THIRD_PARTY_NOTICES.md`; nothing in this
    plan copies its code — the protocol facts above are the deliverable, not its source.

### 11.2 Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Weights | **Convert locally** (`make antares-onnx` → `dist/models`), no hub publish | The gate means an unattended download cannot work anyway, and republishing a derivative of gated weights is a licence question this repo does not need to answer to run the model. The registry entry names a local-only repo path and the UI says so |
| Conversion toolchain | Python + `uv` + `optimum-onnx`, in `tools/`, invoked only by that one target | It is the only path that exists (§11.1.4). Isolating it in one Makefile target keeps the Go/bun toolchain claim true for everything else — this is the first target in the repo that needs Python, and it must stay the only one |
| Quantizations | `q4` first, `q4f16` second, mirroring the base conversion's outputs | Same shape as every other entry (§10.2) and same adapter-feature check; the base repo proves both export |
| Which sizes | **350M** at M12; 1B as a second entry once 350M round-trips | 350M is the fast loop for getting the protocol right; 1B is a strictly better model at 4× the bytes and the same protocol, so it is a registry line, not a milestone |
| Dialect | A new `antares` dialect, **derived from `hermes`**, promoted to `verified` only by a captured transcript | The syntax is the same `<tool_call>{json}</tool_call>`, so a separate file is about the *tolerances* (§11.3), not about a different grammar. §10.2's rule stands: documentation does not promote a dialect |
| Prompt construction | `apply_chat_template(messages, { tools })`, unchanged worker | §11.1.7: the Granite template reproduces the CLI's hand-built prompt exactly. Second family, same bet, no hand-formatted special tokens |
| `<think>` prefill | **Nothing to do — the checkpoint's own chat template emits it** | Revised against the real files (§11.9). The planned `promptPrefill` registry field is deleted before it is written: Antares' `chat_template.jinja` differs from stock Granite 4.0 in exactly one line, the `add_generation_prompt` branch, which appends `<think>\n`. A hand-rolled prefill would have double-emitted it |
| Tool naming | An **exec-tool naming profile**: `terminal`, `command` → `cmd`, `max_chars` → `max_output` | The model was RL-trained on these names; renaming smolbox's surface is not an option and neither is hoping the model adapts. A profile renames what the model reads while the compiled call still goes through `decodeArgs`, so `op` stays unreachable and unknown fields are still rejected |
| Submit tools | A new **`host` tool kind** that resolves in TS and can never produce a `Request` | §10.5's invariant is amended, not broken: *every tool that reaches the guest compiles to an exec `Request`; a host tool reaches nothing*. Modelling a submission as a guest command would put a lie in the transcript |
| `read_file` | Ships as an **optional** built-in template, off by default | The evaluated 3-tool protocol did not have it (§11.1.10). Shipping it off-by-default makes it the first real measurement for §10.7's open question about narrow tools |
| Guest tooling | Add **`ripgrep` and `tree`** to `vm/Dockerfile` | §11.1.16. A search-dominant policy without `rg` is the model's trained strategy failing on a missing binary. Costs a wasm rebuild and a re-measure of artifact size and boot time, both of which are recorded facts in §1 |
| Command allowlist | **Not ported** | §11.1.17. The CLI's parser exists because its sandbox is the host filesystem; smolbox's is a VM. Adding a 900-line parser would imply a boundary the VM already provides, and the one it does *not* provide (guest-writable `/tmp`) is not what the parser is for |
| Product shape | A dedicated **scan mode** (`/scan/`), plus a registry entry usable in chat with a warning | The model is a one-task model with a fixed termination protocol; free chat has nowhere to put a CWE, a call budget, or a submission. Keeping the chat entry costs a warning string and keeps §10's "the registry is the list of models" true |
| Sampling | Per-entry generation config: `temperature 0.3, top_p 1.0, do_sample: true, max_new_tokens 4096` | §11.1.12. This overrides the greedy default M8 chose for reproducibility, which was a spike decision, not a general one |
| `frequency_penalty` | **Cannot be honoured — recorded, not faked** | Verified in the installed library: transformers.js has `repetition_penalty` (multiplicative) and `no_repeat_ngram_size`, and no additive frequency penalty (`src/generation/logits_process.js`). Substituting `repetition_penalty` would be a different function under the same name. Ship without it and note it in the entry |
| Observation format | Follow the **report's** footers (`[N tool-calls remaining]`, the truncation line), behind a flag, and measure against the CLI's | §11.1.13: the report describes what GRPO trained against, so it is the better prior — but it is a disagreement between two authoritative sources, and the plan should resolve it with a transcript rather than a preference |
| Findings | Rendered from the submit call, with paths **verified to exist** in the mount before display | The CLI does this and it is not cosmetic: a 0.135-F1 model hallucinating a path is a routine event, and an unverifiable path in a findings list is worse than no path |

### 11.3 M12 — the model: conversion, registry entry, dialect

Three deliverables, all of which stop short of the protocol.

**The conversion.** `tools/convert-antares.py`, driven by `make antares-onnx`, pulls the gated
checkpoint with `HF_TOKEN`, exports ONNX through `optimum-onnx`, quantizes to `q4` and `q4f16`, and
writes the transformers.js layout (`onnx/model_q4.onnx` plus its `.onnx_data`) into
`dist/models/<repo>` next to the tokenizer files — the same layout `web/fetch-model.ts` produces, so
the loader cannot tell the difference. It fails with an actionable message when `HF_TOKEN` is absent
or the gate has not been accepted, the way `make wasm` does for a missing Docker socket. **A
conversion is not trusted until its output is compared against the safetensors model**: a short
fixed prompt run through both, logits compared, because muP scalars (§11.1.2) and tied embeddings are
exactly the sort of thing an export silently drops.

**The registry entry.** A new `antares-350m` entry carrying what §10.4's entries carry plus two new
fields the other entries do not need: `generation` (§11.2's sampling) and `local: true` (this
checkpoint is never on the hub). `local: true` is what lets the UI say "run `make antares-onnx`"
instead of offering a download that cannot work. There is no `promptPrefill` field — §11.9 removed
the need for it.

**The dialect.** `antares` shares `hermes`'s grammar and differs in tolerances, each drawn from a
real branch of the CLI's `StreamingToolCallParser`: `arguments` **or** `args`; `name` **or** `tool`;
trailing-brace-tolerant JSON; a `<tool_call>` left unterminated by the token cap recovered rather
than discarded; `<think>` stripped from prose. One deliberate refusal, carried over from the `llama`
dialect (§10.9): **a bare JSON object in prose is not a call.** The CLI accepts raw top-level objects
as tool calls, which is reasonable when the only consumer is a localizer and dangerous when the tool
compiles to a shell command — smolbox requires the `<tool_call>` wrapper, and a raw object is prose.

**Done when:** `make antares-onnx` produces weights that load on WebGPU; the converted model's logits
match the safetensors model's on a fixed prompt within tolerance; the dialect's tolerances are
unit-tested from fixtures in CI; and one manual run gets a syntactically valid `terminal` call out of
the model — the M8 bar, for a second family.

### 11.4 M13 — the Antares protocol: tool profile, host tools, the localize run

This is the milestone with the new mechanism in it.

**The naming profile.** A `ToolProfile` renames the exec tool and maps its argument names, leaving
`decodeArgs` and its guards untouched. The Antares profile is `terminal` / `command` / `max_chars`
with the report's description text verbatim. One subtlety that must be tested rather than assumed:
`max_chars` is a **character** cap in Antares and `max_output` is a **byte** cap in
`protocol.Request` — they diverge on non-ASCII, and the renaming must not pretend otherwise. The
tests that matter are the ones proving a profile is only a renaming: `op` still unreachable through
the profile, unknown arguments still rejected, and the compiled `Request` identical to the one the
unprofiled name produces.

**Host tools.** A second tool kind, defined by what it *cannot* do. A host tool has a JSON-Schema
definition like any other, is listed to the model like any other, and resolves to a value in TS
without a `ToolSession` in scope. `submit_vulnerable_files` and `submit_no_vulnerability_found` are
the only two, and they end the run. The invariant test is structural: no path from a host tool
produces a `Request`, and the exec path cannot name a host tool.

**The localize run** is a distinct loop from `Conversation`, sharing its interfaces and none of its
policy, because the differences are not parameters:

- It terminates on a **submit call**, not on a turn without tool calls, and a model that stops
  calling tools without submitting gets the CLI's escalating nudges (`format_no_tool_retry` /
  `format_duplicate_tool_retry`) rather than ending the run.
- It counts a **terminal-call budget** separately from loop iterations, interpolates it into the
  system prompt, and refuses further `terminal` calls once spent with the CLI's exact message.
- **History elision must pin the first user message.** `Conversation.elide` drops from the front of
  `history` once tool outputs are exhausted, and `history` excludes only the system prompt — so the
  CWE task statement is droppable today. For a chat that is survivable; for a run whose entire
  conditioning is that one message it is fatal. This is a bug the Antares work exposes in existing
  code, and it should be fixed for both.
- **Submitted paths are verified against the mount** before becoming findings, deduped, and ranked
  in submission order.

**`FakeModelClient` extends to Antares**, replaying a captured real transcript plus the failure modes
the sources document: a `submit_vulnerable_files` naming a file that does not exist, a run that
exhausts its budget without submitting, a repeated identical call, an unterminated `<tool_call>`, and
`args` instead of `arguments`. That is what puts the whole protocol in CI on a GPU-less runner —
`make test-e2e-antares`.

**The guest gains `ripgrep` and `tree`,** which means `make wasm` reruns and §1's artifact size
(107.6 MiB) and boot time (~2.5–2.7 s) are re-measured and re-recorded. A conformance case per new
binary keeps a future image change from silently removing them.

**Done when:** the full protocol runs against `FakeModelClient` in CI — budget enforced, submission
accepted, hallucinated path rejected, nudges fired — and one real Antares run on WebGPU localizes a
planted vulnerability in a fixture repository through a live mount.

### 11.5 M14 — the scan UI and what it is allowed to claim

A `/scan/` page: pick a mounted folder, pick a CWE, watch the exploration, read the result.

**The trajectory is the product, not a debug view.** The report's own framing is that the output is
"a ranked list of source files… along with the terminal exploration trace that led to that result",
and at 0.135 File F1 the trace is how a person decides whether a finding is worth opening. So the
commands, their observations, and the budget remaining are the main column, not a collapsible.

**CWE selection** is a short curated list (the CLI's own default focus set — CWE-89, 78, 79, 798, 22,
502, 306 — plus free text), with the description text sent as the task message. Porting the CLI's
CWE database and its automatic selection is explicitly **out of scope**: `antares plan`'s repository
profiling is a second system, and this milestone is about running the model, not about choosing for
the user.

**What the UI must say.** That results are leads for review, not proof (§11.1.15); that the model is
350M and its benchmark F1 is 0.135; that a run is one sample from a model the CLI's own README warns
"can vary between identical runs". Findings render as ranked paths with the evidence commands that
touched them, and export as JSON.

**Deliberately not in scope:** SARIF output, sweep-across-CWEs, run history, subagents, line-level
findings (the model does not produce them), and any remediation advice.

**Done when:** a Playwright run drives `/scan/` end to end against `FakeModelClient` in CI — folder,
CWE, trajectory, ranked findings, JSON export — and one manual WebGPU run over a fixture repository
produces the same shape from the real model.

### 11.6 Milestones

| # | Deliverable | Done when |
|---|---|---|
| M12 | ONNX conversion, registry entry, `antares` dialect | `make antares-onnx` yields weights that load on WebGPU and match the safetensors model's logits on a fixed prompt; dialect tolerances unit-tested in CI; one valid `terminal` call from the real model — **done except the WebGPU load itself** (§11.13) |
| M13 | Tool profile, host tools, localize loop, `rg`/`tree` in the guest | Full protocol green against `FakeModelClient` in CI (budget, submission, bad path, nudges); one real WebGPU run localizes a planted vulnerability through a live mount; §1's artifact size and boot time re-measured — **done except the WebGPU run** (§11.11, §11.13) |
| M14 | `/scan/` UI, CWE picker, trajectory view, findings + JSON export | CI Playwright drives the page end to end against `FakeModelClient`; one manual WebGPU run matches — **done except the WebGPU run** (§11.12, §11.13) |

### 11.7 Open questions

- **Does a q4 350M model still localize anything?** Every number in §11.1.15 comes from bf16 served
  by vLLM. Quantization to q4 on a 350M model is a real risk to a policy this specific, and nothing
  in the sources measures it. The logits check at M12 catches a broken *export*; it says nothing
  about whether the *behaviour* survives.
- **Report footers or CLI formatting?** (§11.1.13.) Two authoritative sources disagree about what the
  model reads after every command. This is a two-transcript experiment, not an opinion.
- **Is 15 the right budget here?** The authors' own optimization raised it to 25 (§11.1.14), on the
  3B. A smaller model in a slower runtime may want a different number, and each call costs a full VM
  round trip plus a generation.
- **Does `read_file` help?** §10.7's question, now with a model that has a documented opinion — the
  CLI ships it, the trained protocol did not have it. First real chance to measure rather than guess.
- **How long is a run?** Antares-3B averages 1.96 s of generation per task on an H100. A 350M model
  on WebGPU doing 15 tool calls, each with a VM round trip, is a wall-clock number nobody has, and it
  decides whether the scan UI needs to be resumable.
- **Should the localize loop and `Conversation` converge?** They share interfaces and differ in
  policy today. If a second task-specific model ever arrives, the answer changes.

### 11.8 Risks

18. **The conversion is the whole dependency, and nobody has done it.** No Antares ONNX exists
    (§11.1.5), so M12 is a build step with an unknown failure mode — muP scalars, tied embeddings and
    the `granitemoehybrid` config name are each a plausible place for an exporter to go wrong
    quietly. **Mitigation:** the logits comparison against the safetensors model is part of M12's
    done-when, not a follow-up; and the base model's published conversion (§11.1.4) is a working
    reference to diff against when it fails.
19. **The gate makes the model unobtainable for anyone who has not clicked through.** `gated: "auto"`
    plus `HF_TOKEN` plus Python plus `uv` is four things no other target in this repo needs, and
    acceptance is **per repository, not per organisation** — measured the hard way at §11.9, where a
    token that could read `antares-1b` got a 403 on `antares-350m` from the same account.
    **Mitigation:** one isolated Makefile target; a failure message that names the *specific* repo's
    gate URL rather than a generic auth error, since the 403 body is the only thing distinguishing
    "wrong token" from "un-accepted gate"; and a registry entry that says "not downloadable, run
    `make antares-onnx`" rather than failing at load.
20. **A 0.135-F1 model in a UI invites over-trust.** The blog post's framing and a clean ranked list
    make it look like a scanner. It is not one. **Mitigation:** §11.5's claims requirements are part
    of M14's scope, not polish — the score and the "leads, not proof" language ship with the results.
21. **Adding `rg` and `tree` changes a measured artifact.** §1's 107.6 MiB and ~2.5–2.7 s are load-
    bearing numbers cited by risk 3 and risk 1. **Mitigation:** re-measure and re-record both as part
    of M13, and add a conformance case per binary so a later image change cannot silently remove
    what the prompt promises.
22. **The naming profile is a new way for the tool surface to drift.** M7's guarantee is that the
    model-facing schema is generated from the wire types; a profile renames that schema at runtime.
    **Mitigation:** a profile may only rename — never add, remove or retype an argument — and the
    test that proves it compiles to a byte-identical `Request` is what keeps the anti-drift gates
    meaningful.
23. **The host tool kind is the first thing the model can call that is not sandboxed.** Today every
    tool call ends up behind the VM boundary; a host tool runs TS in the page. **Mitigation:** the
    kind is defined by its inability to reach a session, there are exactly two of them, they take
    structured arguments only, and the structural test that no host tool can produce a `Request` is
    the boundary — enforced the way `op`'s unreachability is.

### 11.9 Measured while preparing M12 (2026-08-05, this machine)

The weights are on disk. Nothing is converted yet, but pulling them settled several things §11.1 had
to infer, and corrected one design decision before it was written.

- **The `<think>` prefill is the checkpoint's, not the harness's.** Antares' `chat_template.jinja` is
  byte-identical to stock `ibm-granite/granite-4.0-350m`'s except for one hunk: the
  `add_generation_prompt` branch emits `<|start_of_role|>assistant<|end_of_role|><think>\n` instead of
  stopping at the role header. Both 350M and 1B carry the same modification. This deletes a planned
  registry field (§11.2) and an open question, and it is a good argument for reading a checkpoint's
  own template before designing around a client's behaviour: the CLI hand-appends the prefill because
  it bypasses the template, and copying the CLI would have double-emitted it.
- **Gate acceptance is per repository.** The same token and account read `antares-1b` fine while
  `antares-350m` returned `403 "you are not in the authorized list"` until its own terms were
  accepted separately. `gated: "auto"` means instant approval, not automatic access.
- **Both checkpoints verified intact**, by parsing the safetensors header and checking the last data
  offset against the file size rather than trusting the transfer:
  - `antares-350m`: 226 tensors, **0.352 B params**, BF16, 704 786 224 bytes, 28 attention layers,
    ctx 32 768, vocab 100 352, tied embeddings, no materialised `lm_head`.
  - `antares-1b`: 323 tensors, **1.837 B params**, BF16, 3 674 580 408 bytes, 40 attention layers,
    ctx 131 072. "1B" names the base, not the parameter count.
- **§11.1.2's architecture claims hold against the real files**: `layer_types` is all-`attention` for
  both, `num_local_experts: 0`, and the muP scalars are present and differ per size (350M: attn
  0.015625 / res 0.263 / logits 4; 1B: 0.0078125 / 0.22 / 8). A conversion that drops them is a
  conversion that silently produces garbage, which is what M12's logits check exists to catch.
- **One conversion hazard checked and ruled out.** `antares-1b` sets `tie_word_embeddings: true` *and*
  materialises `lm_head.weight` — the combination that would matter if the fine-tune had untied them,
  because honouring the config would then silently use the wrong output matrix. Compared byte for
  byte: `lm_head.weight` is **identical** to `model.embed_tokens.weight`, so tying is consistent and
  the 411 MB copy is pure redundancy. 350M omits it entirely.
- **Download is not the bottleneck anyone would guess.** Sustained 36 MB/s from the HF CDN: 350M in
  21 s, 1B in 69 s. Cold-start on the first ranged request measured 1.2 MB/s, which is a warm-up
  artefact, not the throughput — worth knowing before anyone optimises the wrong half of
  `make antares-onnx`.
- **The tokenizer is `GPT2Tokenizer`** with `bos == eos == <|end_of_text|>`, and the chat template
  ships as a standalone `.jinja` rather than inside `tokenizer_config.json` — already covered by
  `OPTIONAL_FILES` in `web/src/agent/models.ts`, so the existing local-model layout needs no change.
- **`HF_TOKEN` lives in a gitignored `.env`**, with `.env.example` checked in. `.gitignore` had no
  `.env` rule before this, which is the sort of thing that is only ever noticed once.

### 11.10 Measured at M12 (2026-08-05, this machine)

M12 set out to convert Antares to ONNX. The conversion works and is verified; the *browser-sized*
variant is not solved, and the reason turned out to be a property of the checkpoint rather than of
the tooling. Recorded in full because the negative results are the expensive ones.

**The remap works, and it is the unlock.** optimum refuses `granitemoehybrid` outright ("custom or
unsupported architecture"). But `GraniteMoeHybridForCausalLM` with all-attention `layer_types` and
zero experts differs from the natively-exportable `GraniteForCausalLM` in exactly one way: it fuses
gate and up projections into `shared_mlp.input_linear` where Granite keeps `mlp.gate_proj` and
`mlp.up_proj` separate. `GraniteMoeSharedMLP.forward` computes `activation(chunk[0]) * chunk[1]` and
`GraniteMLP.forward` computes `act_fn(gate_proj(x)) * up_proj(x)` — the same function, so splitting
the tensor on dim 0 is a rename, not an approximation. Verified against the transformers source, not
inferred from the tensor name.

- **350M remap parity: `max|diff| = 0.000e+00`.** Bit-identical, every position. 1B: relative
  `4.3e-06`, argmax agreeing everywhere — float32 accumulation noise, nothing more.
- **The fp32 ONNX export is exact too: 220/220 greedy tokens identical to torch**, and logit
  correlation 1.000000. So remap and export are both closed questions.

**350M does not follow the Antares protocol; 1B does.** Same prompt (byte-identical to the CLI's
construction), same tools, same sampling. 350M produces fluent reasoning and then degenerates into
repeating "I will inspect the …" without ever emitting a tool call, at temperature 0 *and* 0.3. 1B
emits a well-formed `<tool_call>` block on the first try. **This inverts §11.2's "350M at M12, 1B as
a second entry"**: 1B is the floor for this protocol, not an upgrade.

**Greedy decoding is not a usable default here.** At temperature 0 both sizes fall into repetition
loops. That is not a conversion artefact — the reference safetensors model does it too. It is a
concrete reason for §11.1.12's sampling settings, and it means `do_sample: false` (M8's choice for
spike reproducibility) must not carry over to this model.

**A tool-call format tolerance nobody documented.** 1B emitted:
`{"name": "terminal", "command": "cd /repo && grep -RIn …"}` — arguments **flattened to the top
level**, not nested under `"arguments"`. Both the checkpoint's own chat template and the CLI's parser
specify the nested form, and the CLI's `_is_tool_call_payload` would reject this. The `antares`
dialect must accept it: `name` plus leftover keys *is* the argument object. Measured, not guessed.

**q4 is not viable for Antares, and the cause is the weights.** Logit correlation against the fp32
reference, same prompt, single forward pass:

| build | corr | note |
|---|---|---|
| Antares-350M fp32 | 1.000000 | the reference |
| Antares-350M q8 dynamic | 0.4912 | *worse* than int4 — `quantize_dynamic` cannot spare the output projection |
| Antares-350M q4 (RTN, HQQ, k-quant) | 0.816 / 0.800 / 0.691 | three algorithms, same wall |
| Antares-350M q4 after ORT fusion | 0.811 | fusion is lossless (fp32 corr 1.000000) and buys q4 nothing |
| **onnx-community's own q4 of the base model** | **0.930** | their published build, their weights |
| **the same pipeline in this repo, on their weights** | **0.943** | *better* than the official build, at the same size (580 MB vs 576 MB) |

The last row is the one that matters: this repo's quantizer beats the reference implementation on the
reference weights, so the pipeline is not the problem. **Antares' RL-tuned weights are simply more
quantization-sensitive than the Granite instruct weights they came from** — plausibly because GRPO
sharpens the policy's weight distribution. Behaviourally, 1B at q4 loses the protocol across three
seeds: prose with no call, a raw `{"ranked_files": …}` object with hallucinated paths and no
`<tool_call>` wrapper, and an empty `<tool_call>` followed immediately by EOS. The fp32 model, same
prompt, emits a clean call. **No q4 build of Antares ships from this repo.**

**Sizes, for whoever picks up the fp16 work:** 350M fp32 1.82 GB / q4 983 MB; 1B fp32 7.35 GB /
q4 2.56 GB. Roughly 1.6 GB of the 1B q4 is the embedding and output projection, which are held at
fp32 deliberately (quantizing them is what makes q8 score 0.49).

**fp16 is the answer, and it had to come from onnxruntime rather than the obvious library.**
`onnxconverter_common.float16` cannot produce a loadable graph for this architecture at all:
disabling shape inference yields "Type parameter (T) of Optype (Add) bound to different types", and
enabling it with an op block list yields a Cast whose output type contradicts its consumer — because
Granite's RMSNorm already contains explicit fp32 Casts that the converter double-handles. optimum's
`--dtype fp16` is a silent no-op on CPU (it emitted a byte-identical 1.82 GB fp32 graph).
onnxruntime's own `OnnxModel.convert_float_to_float16` works, because it uses *symbolic* shape
inference and resolves those existing Casts correctly:

- **350M fp16: logit correlation 0.999514**, argmax matching, `max|diff|` 0.68 on a logit range of
  −22…28. Effectively lossless, against 0.816 for the best int4 build.
- **1B fp16 keeps the protocol: a well-formed `<tool_call>` in 2 of 3 seeds**, against 0 of 3 usable
  at q4. This is the gate that decides the dtype, not the correlation number.
- Sizes: **350M fp16 912 MB, 1B fp16 3.68 GB.** 1B is the shipping model (350M cannot follow the
  protocol at any precision), so the browser cost of Antares is ~3.7 GB — three times LFM2's 1.22 GB
  and a real constraint on §11.5's UI, not a footnote.

Two sharp edges worth not re-discovering. onnxruntime hardcodes its external-data sidecar as
`<name>.onnx.data` with no override, where optimum, onnx-community and transformers.js all use
`<name>.onnx_data`; the name is recorded inside every external initializer, so the file has to be
renamed *and* the references rewritten. And `use_external_data_format` in `transformers.js_config`
is keyed by real file name — fp32 is `model.onnx`, never `model_fp32.onnx` — where a wrong key means
the sidecar is simply never fetched.


### 11.11 Measured at M13 (2026-08-05, this machine)

**The guest gained `ripgrep` 14.1.1 and `tree` 2.2.1**, and the artifact grew from **107.6 MiB to
112.2 MiB** (114 022 106 → 117 650 243 bytes, +3.4%). No boot regression: `make test-integration`
runs in **8.5 s** against the ~12 s recorded at M5. A single `bin/smolbox exec` round trip measures
~4.5 s wall clock, but that is process start plus wasm compile plus boot plus teardown — a different
quantity from §1's ~3.1–3.2 s `InstantiateModule` → ready-banner figure, and not comparable to it.

**Adding `rg` exposed a pre-existing mount bug that `find` had been hiding.** The host mount's
readdir does not report `d_type`, so tools split cleanly by whether they trust it:

| tool | on `/mnt/host` | why |
|---|---|---|
| `ls`, `cat`, `grep -rn`, `tree`, `sed` | correct, including nested | they `stat()` each entry |
| `find` | **silently incomplete** — lists `sub/` but never `sub/nested.txt` | trusts `d_type` to decide what to descend |
| `rg` | **fails loudly** — `IO error … Not a directory (os error 20)` on every regular file | trusts `d_type`, then opens a "directory" that is a file |

All of it is mount-specific: on `/tmp` both `find` and `rg` work perfectly, and `stat` on a mounted
file correctly reports "regular file". The mount also presents every entry with mode `0000`, which
is the same metadata loss showing through a second way. `find` has been in the exec tool's own
description since M7, so this predates Antares entirely — `rg` merely made it loud. The silent
failure is the worse one: `find` returns a confident, incomplete file list.

Consequences, all recorded rather than papered over:

- Four conformance cases now pin this, including one named **"KNOWN GAP"** that asserts `find` does
  *not* find the nested file. It is a bug pinned as a test, so fixing the mount makes it fail and
  forces the decision back into view rather than leaving folklore behind.
- **The Antares system prompt's advertised command list is no longer Antares'.** The original names
  `find` and `rg`; ours names `ls, tree, cat, head, tail, grep, wc, sed` and says outright that
  `find` and `rg` do not traverse this mount. This is a real deviation from the RL-trained prompt
  (§11.1.14 showed prompt wording moves the score) and is taken deliberately: advertising a broken
  tool costs budget to discover, and `tree` covers layout while `grep -rn` covers search.
- `rg` is kept installed rather than reverted. It works on explicit paths, so
  `find … | xargs rg` and `rg pattern file` both work, and its failure is at least visible.

**The protocol layer is CI-testable, which was the design constraint.** 21 new tests
(`localize.test.ts`) drive the whole run against `FakeModelClient` with no GPU and no VM, plus 16
dialect tests. The suite went 230 → **267**. Scripts replay what M12 actually captured: flattened
arguments, an empty `<tool_call>`, unwrapped JSON with hallucinated paths, and a model that reasons
forever without calling anything.

**A claim from §11.4 that turned out to be wrong, corrected here.** That section called
`Conversation.elide` dropping the oldest history entry a *bug* to be fixed for both loops. It is not:
§10.3 specifies exactly that behaviour for chat — oldest tool outputs first, then oldest turns — and
a chat has no single message its whole meaning depends on. Only the localization run does, so only
`LocalizeRun` pins `history[0]`, and `Conversation` is left alone. The requirement differs; the
existing code was right.


### 11.12 Measured at M14 (2026-08-05, this machine)

**The whole localization protocol runs in CI with no GPU.** `tests/e2e/scan.spec.ts` drives 7 cases
against a **real VM and a real mounted tree** with a scripted model, in the ordinary browser suite —
not opt-in, no GPU. The browser suite went 30 → **43 cases**; unit tests 230 → **267**. The scripts
are the raw strings antares-1b actually emitted at M12, flattened arguments and all.

**The path check is the feature, and it is worth its own test.** A submitted path is resolved against
the mount through the same bridge the model used, and a path that does not resolve is dropped and
*reported as dropped*. The e2e case submits one real file and one invented one and asserts both the
finding and the rejection reach the page. At 0.135 File F1 hallucinated paths are routine output
rather than an edge case, so "the model named files that do not exist" is a signal about the run,
not an embarrassment to hide.

**Rendering model output with `textContent`, not escaped HTML.** The first draft of the page built
entries by interpolating into `innerHTML` behind a hand-rolled `escapeHtml`. Everything on that page
is model output or command output; hand-rolled escaping around untrusted strings is a bug waiting to
happen, and building nodes is the same amount of code. The DOM shim (`web-globals.d.ts`) grew exactly
three members — `removeAttribute`, `click`, and a two-field `navigator.gpu` — rather than pulling in
a DOM lib the rest of the bundle does without.

**`test -f` on a model-supplied path is quoted with `JSON.stringify`.** The sandbox makes an
injected `; rm -rf /` survivable, not acceptable, and the path checker is the one place a submitted
string reaches `sh -c` outside the tool surface's own guards.

**Deliberately not built**, and listed so the omissions are decisions rather than gaps: SARIF output,
sweep-across-CWEs, run history, subagents, line-level findings (the model does not produce them),
remediation advice, and the CLI's CWE database with its automatic selection — the page offers the
CLI's nine-CWE default focus set and free text instead.

### 11.13 Status

| # | Deliverable | Status |
|---|---|---|
| M12 | ONNX conversion, registry entry, `antares` dialect | **done** — conversion verified bit-exact; fp16 ships, no int4 (§11.10) |
| M13 | Tool profile, host tools, localize loop, `rg`/`tree` in the guest | **done** — 21 unit + 16 dialect tests; artifact re-measured (§11.11) |
| M14 | `/scan/` UI, CWE picker, trajectory view, findings + JSON export | **done** — 7 e2e cases against a real VM in CI (§11.12) |

The one done-when condition **not** met: no milestone here has been run against the real model on
WebGPU. M12 verified the converted weights under onnxruntime on CPU, which is a different runtime
from ORT-web on a GPU. Until someone runs `make antares-onnx` and opens `/scan/` on a machine with a
GPU, "Antares works in smolbox" is supported by everything except the last step.

### 11.14 Corrected after M14: the tool schema did not match the trained one

Asked directly whether the tools handed to Antares match the schema it was trained on, the answer
turned out to be **no for `terminal`** and yes for the two submit tools. Recorded because the bug is
more interesting than the fix.

`profiledDefinition` built the model-facing schema by taking smolbox's *generated* `inputSchema` and
substituting the renamed keys. §11.2 called that an anti-drift feature — "a field added to
protocol.Request shows up here too" — and it is, but it is also wrong: substituting keys on our
schema is not the same as presenting theirs. The rendered `terminal` tool carried **six** properties
where the report's Appendix A.1 has two:

| | report | as shipped at M14 |
|---|---|---|
| properties | `command`, `max_chars` | `command`, **`cwd`, `env`, `stdin`, `timeout_ms`**, `max_chars` |
| `command` description | "The shell command to run" | smolbox's `sh -c` paragraph |
| `max_chars` description | "Maximum number of output characters before truncation (default: 2000)" | smolbox's `max_output` byte-cap text |
| `default: 2000` | present | absent |
| stray keys | none | `$schema`, `title` |

Three things made that worse than cosmetic. The four extra arguments are **real smolbox arguments**,
so a model hallucinating `stdin` or `cwd` would have had them accepted by `decodeArgs` and quietly
take effect. The definition cost **1928 characters** against the report's 518 — on every turn, to a
1.8B model, which is exactly the tax §10.1 measured and warned about. And the report is explicit
that its interface was held constant across evaluated models, with only tool-call *serialization*
adapted; changing the schema is evaluating a different agent.

**The fix keeps the anti-drift gate and drops the schema reuse.** A `ToolProfile` now carries an
explicit argument allowlist — model-facing name, wire name, trained description, optional default —
and `profiledDefinition` emits exactly those properties, taking each `type` from the generated schema
so types still cannot drift, and throwing at construction if a profile names a wire field that does
not exist. `applyProfile` rejects any argument outside the allowlist rather than passing it through,
because the profile *is* the tool's argument surface.

Measured after the fix: `terminal` renders **518 characters** (1410 saved per turn), the three tools
together **1131**, and `tool-profile.test.ts` asserts all three against Appendix A.1 transcribed
verbatim, by deep equality — a subset check would have passed the original bug. 12 new tests; the
suite is 267 → **274**.

Worth generalising: the two schemas that were written *from* the report by hand (the submit tools)
were correct, and the one that was *derived* from an existing schema was not. Reuse was the thing
that introduced the drift.

### 11.15 UI pass (2026-08-05)

A deliberate pass over the flows, weighted to `/scan/`. What changed and why:

**The four-button gauntlet is gone.** The page shipped with `1. Boot VM`, `2. Pick folder`,
`3. Load model`, `Scan` — a sequence the user had to know and perform in order, where clicking the
wrong one first did nothing useful. There is now one primary action: **Scan** does whatever setup is
still missing, and a readiness strip (`VM · folder · model`) shows state rather than demanding
input. The model stays last because it is 3.7 GB and nobody should pay for it by opening a page.

**Findings carry their evidence — the thing §11.5 asked for and the first cut did not ship.** Each
ranked path now lists up to three commands that named it, with the matching output line. It is a
reconstruction, not the model's reasoning (it never states one), so it is presented as "these
commands mentioned this file" for the reader to check against the trace. A bare ranked path from a
0.135-F1 model is not something a person can act on; the commands are.

**A 3.7 GB load needed a progress bar, not a status line.** Model download had been reporting through
the same single line that everything else overwrote, per file. It is now a real bar with an overall
percentage and the total size, plus a live run bar (elapsed, commands used against budget, current
phase) so a long run is legibly working rather than possibly hung.

**Smaller things that were wrong rather than merely plain:** "Change folder…" implied a folder
existed before one was picked (now "Choose folder…" until it does); `$ · 13 LEFT` was noise (now
`command · 13 left`); the empty exploration pane stranded its guidance at the top of a 30 rem box
(now centred, via `:has(.empty)`, which degrades to the old behaviour where unsupported); errors
during load now say what to do — a locally-built model that is missing reports the `make` command
rather than a 404 from inside transformers.js.

**Cross-page navigation.** `/scan/` was unreachable from anywhere. All three pages now carry a
`VM · chat · scan` nav, and `/` describes what the other two are for.

**Dark mode**, via `prefers-color-scheme`, because a terminal-adjacent tool that is white-only is
unpleasant next to a terminal.

Three new e2e cases cover the parts that are behaviour rather than decoration: evidence reaching the
findings panel, the readiness strip and run counters tracking real progress, and export staying
disabled until there is something to export. Browser suite 43 → **46**; unit 274 → **276**. The
caveat test now asserts the benchmark number and the "not proof" framing by meaning rather than exact
wording, so the copy can improve without the guarantee weakening.
