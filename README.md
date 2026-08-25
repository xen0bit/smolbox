# smolbox

A full x86_64 Linux VM that runs anywhere WebAssembly runs — including a browser tab — and can mount
a folder from your machine as a read-only part of its filesystem. A small on-device LLM drives it by
issuing terminal commands.

> **Status: component 1 is complete (M0–M7); component 2 is working (M8–M11).** The VM builds (`make wasm` → `dist/smolbox.wasm`,
> 153 MB, 45 MB brotli) and boots to the guest agent's ready banner under wazero in ~3.2 s and **in a browser in
> ~2.6 s**, with the read-only host mount working under wazero and in the browser via the sync FS
> bridge (a folder picked with the File System Access API is mounted read-only at `/mnt/host`). The
> `smolbox` CLI (`exec`/`repl`) drives it over the framed protocol, and a shared conformance table
> (`tests/conformance/cases.json`) pins the behaviour — **the same table passes under wazero and
> under Chromium**. The
> tool-call surface is specified and tested: [`docs/tool-api.md`](docs/tool-api.md), JSON Schemas
> generated from the Go types, and **a mock caller that runs a scripted tool-call transcript against
> a real VM**. **M8 replaced that mock caller with a real one:** an LFM2-1.2B model running on WebGPU
> in the page picks up the same generated schema, emits a `run_terminal_command` call, and reads the
> folder you picked — the tool surface needed **no changes at all** to serve it.
> See [PLAN.md](PLAN.md) for the implementation plan, research notes, and current milestone.

---

## What it is

Two components.

**1. The VM.** A minimal Alpine Linux container image, converted to a single portable `.wasm`
artifact with [container2wasm](https://github.com/container2wasm/container2wasm). The same artifact
runs under [wazero](https://wazero.io) on your machine and inside a browser tab, and in both places
it can be handed a host directory that appears inside the guest as an ordinary read-only folder at
`/mnt/host`. In the browser, that directory is one the user picked with the browser's folder picker —
files are read lazily, on demand, straight off the local disk, never uploaded anywhere.

**2. The agent.** A small LLM running locally on WebGPU (in the shape of
[LFM2-WebGPU](https://huggingface.co/spaces/LiquidAI/LFM2-WebGPU/tree/main)) that inspects and
operates on that folder by making terminal tool calls into the VM, over a stable, versioned exec API.

Everything runs on the user's machine. No server, no upload, no container runtime, no VM software.

---

## Why

Give a local model a real Unix shell and real files to work with, with a hard sandbox boundary, and
ship the whole thing as a static web page. The model gets `ls`, `grep`, `find`, `cat`, pipes, exit
codes — not a bespoke set of file-reading functions. The user gets a sandbox that can read exactly
one folder they explicitly chose, and cannot write to it.

---

## Scope — what "done" looks like

### The VM

- A single `dist/smolbox.wasm` boots a real x86_64 Linux kernel and starts a container, with no
  native dependencies beyond a WebAssembly runtime. The guest carries busybox, coreutils, findutils,
  grep, ripgrep, tree and **python3** — enough that a model can do real work in one command, and
  nothing more, because every package is wasm bytes every visitor downloads (see
  [§10.24](docs/plan/10-findings.md)).
- It runs identically under **wazero** (Go, for local development and integration tests) and in a
  **browser** via `browser_wasi_shim` — the same bytes, exercised by the same test suite.
- A host directory can be mounted at `/mnt/host`, **read-only**. Reads are enforced read-only at the
  host filesystem boundary, not by guest configuration, so a compromised guest cannot write through.
- In the browser, the mount is backed lazily by a `FileSystemDirectoryHandle` from
  `showDirectoryPicker()`. Large directories cost nothing until read. A `remount()` picks up changes
  made on disk. Browsers without that API (Firefox, Safari) pick the folder through
  `<input type="file" webkitdirectory>` and get an equivalent handle rebuilt from the file list.

### The exec API

- **One long-lived session.** The VM boots once; commands stream over it. Multi-second boot latency
  is paid a single time, not per tool call.
- **Stateful.** The working directory persists across calls (and anything written to `/tmp`),
  so an agent can `cd`, build up state, and reason across steps. Environment is set per request
  via `Request.Env`; guest-side `export` does not carry over.
- **Structured.** Every call returns exit code, stdout, stderr (separately), duration, and explicit
  `timed_out` / `truncated` flags. Output caps and per-call timeouts are enforced in the guest, with
  process-group kills so nothing leaks.
- **One definition, two runtimes.** The wire types are defined once in Go and mirrored in TypeScript,
  with a generated JSON Schema. The Go and browser clients cannot drift.
- **Files come back out over it too, not beside it.** `:get <path>` in either page's terminal reads a
  guest file in 512 KiB `dd | base64` chunks over this same API and hands the bytes to the browser as
  a download, checked against the guest's own `sha256sum`. No new op, no new wire field — new
  capability goes around the exec API, not inside it.

```go
resp, err := session.Exec(ctx, protocol.Request{
    Cmd:       "grep -rn TODO /mnt/host",
    TimeoutMS: 5000,
})
// resp.ExitCode, resp.Stdout, resp.Stderr, resp.TimedOut, resp.Truncated
```

### The agent

- The exec API is exposed as a single `run_terminal_command` tool definition, ready for function
  calling in either the Anthropic or the OpenAI dialect, from Go and from TypeScript. Listing a
  directory, reading a file, searching a tree — those are commands, not more tools.
- The model never chooses the *operation*: `op` is not in the tool's schema, and a call that sets it
  is rejected before the session sees it. A model cannot talk its own sandbox into `shutdown`.
- A WebGPU model in the page calls it, reads the folder the user picked, and reports back, through a
  chat interface with a multi-turn loop, a curated model registry, and tools you can add yourself.
  Each registry entry is pinned to a checkpoint revision and tagged with the dialect its calls
  actually use — LFM2's native Pythonic syntax, the Hermes/Qwen `<tool_call>` JSON form, Gemma 4's
  own grammar — parsed alongside plain JSON. **Working as of M8–M11**: local models on WebGPU via
  transformers.js, and a native WebGPU kernel engine for Gemma 4, in their own worker, loading in
  ~4–7 s. The loop is exercised in CI against a scripted model; real models are run by hand.
- The tool surface is fully specified and tested against a mock caller **before** any model is
  wired in — the model is a consumer of a proven API, not a prerequisite for it. See
  [docs/tool-api.md](docs/tool-api.md).
- The page says what is up rather than what happened last: one chip each for the VM, the model and
  the mounted folder, since all three load independently and any of them can fail on its own, with
  the download bar underneath them for the two very large downloads (the wasm, then the weights).
- **A console beside the chat, on the same VM.** The panel under the composer is the same terminal
  the `/` page is built from, driving the same `Session` — so a command you type queues behind the
  agent's tool call rather than racing it, `cd` moves the directory its next command inherits, and a
  file it wrote to `/tmp` is one you can read back or `:get` out of the VM.

### Build and test

- `make wasm` produces the artifact. The guest image and the toolchain that converts it live in
  **two separate Dockerfiles** (`vm/Dockerfile`, `build/Dockerfile.c2w`), so iterating on guest
  packages does not rebuild the conversion toolchain.
- A **single shared conformance table** is executed by the Go/wazero driver and by the Playwright
  browser driver. Behaviour cannot silently diverge between runtimes.
- Browser tests run without a native file dialog by mounting an OPFS directory handle through the
  identical code path.

---

## Getting started

```
make everything  # the whole served set: wasm, web, gemma-kernels, compress, models
make wasm        # build the guest image and convert it to dist/smolbox.wasm
make model       # optional: pull the default checkpoint (LFM2.5 2.6B) -> dist/models, for a local build
make build       # build the smolbox CLI

./bin/smolbox exec --mount ./testdata/mount -- ls -la /mnt/host
./bin/smolbox repl --mount ~/some/project

make web serve   # bundle and serve the browser runtime on localhost:8080
```

`make everything` (alias `make all`, or just `make`) includes an ~11 GB weight pull as its last,
resumable step — `make model MODEL=<key>` pulls a single registry entry, `make model MODEL=--list`
shows them.

The dev server hosts the VM at `/` and the agent page at `/agent/`. Both pages carry a terminal
whose `:`-prefixed lines are handled by the page rather than the guest — `:get <path>` downloads a
file out of the VM, `:help` lists them. The agent page needs a GPU.

Where it reads weights from is a build flag, `SMOLBOX_MODEL_SOURCE`, and it defaults to `hub`: every
checkpoint comes from huggingface.co, which is what a visitor to a deployment gets and needs no
`make model` at all. `SMOLBOX_MODEL_SOURCE=local make web` reads them from `dist/models` instead —
for debugging a checkpoint off the disk, and what the opt-in GPU suites build. A hub build greys out
any entry that needs something built here rather than fetched: today that is the Gemma 4 kernel
build alone, whose 2.5 GB of weights are on the hub but whose WebGPU engine comes from
`make gemma-kernels`. Every other registry entry is servable from the hub, checked by HEAD against
each pinned revision.

`make wasm` needs a local Docker daemon — the converter drives BuildKit through it.

### Deploying it

`make site` assembles everything a static host needs into `_site/`: both pages, their bundles, the
onnxruntime builds and `dist/smolbox.wasm`, in one flat tree with the site at its root. It is a hub
build by definition — no weights are published, because a visitor gets every checkpoint from
huggingface.co — so it comes to ~230 MB rather than ~11 GB.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes that tree to GitHub Pages on
every push to `main`, and on demand from the Actions tab. Pages needs three accommodations, all
handled at build time because there is no server on the other end to handle them at request time:

- **No response headers.** The runtime needs cross-origin isolation and Pages sends neither
  `Cross-Origin-Opener-Policy` nor `Cross-Origin-Embedder-Policy`, with no way to add them.
  [`web/coi-serviceworker.js`](web/coi-serviceworker.js) installs both from a service worker
  instead, at the cost of one extra reload on a first visit. It does nothing at all when the server
  already sends the headers, so `make serve` and the container image are unaffected — pinned by
  `tests/e2e/coi.spec.ts`.
- **No root.** A project site lives at `https://<user>.github.io/<repo>/`, so every asset path is
  built under a prefix: `SMOLBOX_BASE`, defaulting to `/`, in the same shape as
  `SMOLBOX_MODEL_SOURCE` and for the same reason (see [`web/src/base.ts`](web/src/base.ts)). The
  workflow reads the prefix from the deployment rather than hardcoding it, so a fork or a custom
  domain needs no edit.
- **No size to divide by.** Pages serves `smolbox.wasm` gzipped and sends nothing naming the size of
  the decoded bytes, which are the ones the download bar counts — so the bar had no denominator and
  ran with no percentage for the whole 150 MB. Nothing in the browser can recover that number, so
  `make web` measures the file and bakes it in as `SMOLBOX_WASM_BYTES` (see
  [`web/src/wasm-size.ts`](web/src/wasm-size.ts)). It is only ever the fallback: a server that says
  the size itself, as `make serve` does, is still believed first.

The same dev server runs in a container, built from the root `Dockerfile`:

```
docker build -t smolbox/serve:dev .
docker run --rm -p 8080:8080 -v $PWD/dist:/data:ro smolbox/serve:dev
```

`HOST`, `PORT` and `DIST_DIR` configure the bind address, the port, and the `dist/`
directory the server reads its artifacts from (smolbox.wasm, the model weights and
the Gemma kernel engine) — `/data` in the image, `dist/` beside the source tree
otherwise. Mounting a host `dist/` over `/data` replaces them all at once. The
build bakes in `dist/smolbox.wasm` when the build context already has it and
skips it when it does not — `make wasm` cannot run inside a container build,
since it needs the host's Docker socket.

Toolchain: **Go 1.24+** for the CLI, **Docker** for the conversion, and **bun** for the web tooling
(bundling, unit tests, typecheck, and the dev server). Run `bun install` once to fetch the web
dependencies.

The agent spike is exercised through `make test-e2e-agent` (Playwright drives `/agent/` in headless
Chromium: the model loads on WebGPU, calls the tool, and the call reaches a real VM). It is **opt-in
and not in CI** — headless Chromium has no software WebGPU fallback, so a GPU-less runner cannot run
it. Its tool-call parser carries 28 unit tests that do run in CI.

The VM artifact is exercised today through `make test-integration` (boots `dist/smolbox.wasm` under
wazero and runs the framed protocol matrix over the guest agent), and by hand through the `smolbox`
CLI (`exec`/`repl`). In the browser it is exercised through `make test-e2e` (Playwright boots the
same artifact in headless Chromium: `echo hello`, an OPFS-backed mount smoke, and the **full
conformance table** — the browser passes the same `cases.json` as the Go driver).

The browser runtime requires **cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`); `make serve` sets these, and on a host that
cannot — GitHub Pages — a service worker sets them instead (see *Deploying it* above). Folder mounting works in
every current browser: `showDirectoryPicker()` where it exists, `<input type="file" webkitdirectory>`
otherwise — `make test-e2e-firefox` runs that second path against a real VM in Firefox.

---

## Non-goals

- Networking from inside the VM. container2wasm supports it; smolbox does not enable it. The sandbox
  is offline by design.
- Write access to the mounted host directory. The mount is read-only, deliberately and permanently.
- Being fast at CPU-bound work. An emulated x86_64 CPU inside WebAssembly is not a performance story.
  smolbox optimises for portability and for a real Unix environment, and amortises boot cost across a
  long-lived session.
- Training, fine-tuning, or serving models. The agent is an off-the-shelf local model in the browser.

---

## How it works

```
┌──────────────────────── browser tab (cross-origin isolated) ────────────────────────┐
│                                                                                     │
│   main thread                                  dedicated worker                     │
│   ┌───────────────────────┐                    ┌──────────────────────────────────┐ │
│   │ WebGPU LLM            │  tool call         │  smolbox.wasm                    │ │
│   │  run_terminal_command ├───────────────────►│   Bochs → Linux → runc           │ │
│   │                       │◄───────────────────┤    └─ /sbin/smolagentd (PID 1)   │ │
│   │ FileSystemDirectory   │  {code,out,err}    │        stdio ⇄ framed protocol   │ │
│   │ Handle (user-picked)  │                    │                                  │ │
│   │        ▲              │  SharedArrayBuffer │   WASI preopen /mnt/host         │ │
│   │        └──────────────┼───  Atomics.wait  ─┤    └─ virtio-9p in guest         │ │
│   └───────────────────────┘   (async→sync)     └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘

the same smolbox.wasm, under wazero:

  smolbox CLI ──stdio──► smolagentd            WithReadOnlyDirMount(host, /mnt/host)
```

The browser's File System Access API is asynchronous, but WASI's filesystem interface is
synchronous. The worker bridges the two: it blocks on `Atomics.wait` while the main thread performs
the async read and writes the result back through a `SharedArrayBuffer`. This is the same mechanism
xterm-pty already uses for terminal I/O, which is why cross-origin isolation is required.

---

## Documentation

- [PLAN.md](PLAN.md) — index over `docs/plan/`: implementation plan, research notes, upstream
  references, risks
- [docs/plan/10-findings.md](docs/plan/10-findings.md) — the measurement log: what running a real
  model on a real GPU actually taught us
- [docs/tool-api.md](docs/tool-api.md) — the exec API and the `run_terminal_command` tool definition
- [docs/schema/](docs/schema) — JSON Schemas, generated from the Go wire types (`make generate`)

## Built on

[container2wasm](https://github.com/container2wasm/container2wasm) ·
[wazero](https://github.com/wazero/wazero) ·
[browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) ·
[xterm-pty](https://github.com/mame/xterm-pty) ·
[Bun](https://bun.sh) ·
[Alpine Linux](https://alpinelinux.org)
