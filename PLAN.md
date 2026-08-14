# smolbox — Implementation Plan

> Status: M0 (scaffolding), M1 (wasm build), M2 (guest agent + session + CLI), M3 (read-only host
> mount under wazero + shared conformance table), M4 (browser worker + stdio router + TS session,
> with the preopen spike), M5 (sync FS bridge + browser mount + browser conformance driver), and
> M6 (emscripten `--to-js` target), and M7 (tool-API docs, JSON Schema, mock caller) complete.
> **Every milestone in §6 is done.** Component 2 opened at §9: **M8, the WebGPU tool-call spike, is
> also done** — a local model on WebGPU drives a real VM through the M7 tool surface end to end,
> without a single change to that surface. **§10 (M9 chat UI and the multi-turn loop, M10 the model
> registry and dialects, M11 customizable tools) is now built and green too.** Every milestone in
> this document is complete.
> This document is the working plan **and** the research notebook. Every external claim below
> carries a link to where it was verified, so later sessions do not have to re-derive it.

---

## How this document is arranged

It got to 236 KB, and every session — human or otherwise — was reading all of it to find one
section. It is now one file per top-level section under [`docs/plan/`](docs/plan/), and this page is
the index.

**Section numbers are the addressing scheme and they do not move.** Code comments, commit messages
and the sections themselves cite `§10.16`, `§2.11.24`, `§11.10`; splitting the file changed which
document a number lives in and nothing else. Correct an entry in place rather than renumbering it,
and append new findings at the end of their section.

### Component 1 — the VM (§1–§8, complete)

| | | |
|---|---|---|
| [§1](docs/plan/01-context.md) | Context | What smolbox is, the two components, and what "done" means for each |
| [§2](docs/plan/02-research-notes.md) | Research notes | Every external claim with a link to where it was verified — container2wasm, wazero, WASI, WebGPU |
| [§3](docs/plan/03-repository-layout.md) | Repository layout | What lives where, and why |
| [§4](docs/plan/04-design.md) | Design | The protocol, the guest agent, the FS bridge, the tool API |
| [§5](docs/plan/05-makefile-targets.md) | Makefile targets | What each target builds and what it needs |
| [§6](docs/plan/06-milestones.md) | Milestones | M0–M7, all closed |
| [§7](docs/plan/07-verification.md) | Verification | How each claim is tested, and by which suite |
| [§8](docs/plan/08-risks.md) | Risks and mitigations | What could still go wrong |

### Component 2 — the WebGPU agent (§9–§11)

| | | |
|---|---|---|
| [§9](docs/plan/09-webgpu-agent.md) | The WebGPU agent | M8: the spike that put a local model in front of the tool surface |
| [§10.1–§10.9](docs/plan/10-chat-models-and-tools.md) | Chat, models and tools | M9–M11: the chat UI, the model registry and dialects, customizable tools |
| [§10.10–§10.25](docs/plan/10-findings.md) | **What running it taught us** | The measurement log. The prefill ceiling, `shader-f16`, the inline-weight ceiling, the model survey, chunked prefill, the mount's timestamps, what python3 and a file export really cost, which checkpoints the hub can serve a browser directly. Start here when something is behaving strangely. |
| [§11](docs/plan/11-antares.md) | Antares | M12–M14, since removed. Kept for the findings, not the feature |

### Where to add things

- A **measurement, a gotcha, or a bug you chased** → a new numbered subsection at the end of
  [§10 findings](docs/plan/10-findings.md). That file is the one that earns its length.
- A **design decision** → the section it belongs to, in place.
- Anything that changes **what a target builds** → [§5](docs/plan/05-makefile-targets.md) and the
  Makefile comment, together.

