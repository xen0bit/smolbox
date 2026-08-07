# smolbox

A full x86_64 Linux VM that runs anywhere WebAssembly runs — including a browser tab — and can mount
a folder from your machine as a read-only part of its filesystem. A small on-device LLM drives it by
issuing terminal commands.

> **Status: component 1 is complete (M0–M7); component 2 is working (M8–M11).** The VM builds (`make wasm` → `dist/smolbox.wasm`,
> 108 MB) and boots to the guest agent's ready banner under wazero in ~3.2 s and **in a browser in
> ~2.6 s**, with the read-only host mount working under wazero and in the browser via the sync FS
> bridge (a folder picked with the File System Access API is mounted read-only at `/mnt/host`). The
> `smolbox` CLI (`exec`/`repl`) drives it over the framed protocol, and a shared conformance table
> (`tests/conformance/cases.json`) pins the behaviour — **the same table passes under wazero, under
> Chromium, and (minus the mount cases) under the emscripten `--to-js` build**, which ships too. The
> tool-call surface is specified and tested: [`docs/tool-api.md`](docs/tool-api.md), JSON Schemas
> generated from the Go types, and **a mock caller that runs a scripted tool-call transcript against
> a real VM**. **M8 replaced that mock caller with a real one:** an LFM2-1.2B model running on WebGPU
> in the page picks up the same generated schema, emits a `run_terminal_command` call, and reads the
> folder you picked — the tool surface needed **no changes at all** to serve it.
> See [PLAN.md](PLAN.md) for implementation plan, research notes, and current milestone.

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
  native dependencies beyond a WebAssembly runtime.
- It runs identically under **wazero** (Go, for local development and integration tests) and in a
  **browser** via `browser_wasi_shim` — the same bytes, exercised by the same test suite.
- A host directory can be mounted at `/mnt/host`, **read-only**. Reads are enforced read-only at the
  host filesystem boundary, not by guest configuration, so a compromised guest cannot write through.
- In the browser, the mount is backed lazily by a `FileSystemDirectoryHandle` from
  `showDirectoryPicker()`. Large directories cost nothing until read. A `remount()` picks up changes
  made on disk. Browsers without that API (Firefox, Safari) pick the folder through
  `<input type="file" webkitdirectory>` and get an equivalent handle rebuilt from the file list.
- A second browser build (`c2w --to-js`, QEMU with a TCG JIT) is available for workloads that do not
  need a host mount. It runs the emulated CPU **1.4–2.9× faster**, but it boots slower (~7 s against
  ~1.8 s, on 116 MB of assets against a wizer pre-booted 108 MB) and its console is ~10× slower, so
  it only pays off on long CPU-bound work. It passes the same conformance table minus the mount
  cases.

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
  chat interface with a multi-turn loop, a model picker, and tools you can add yourself. **Working
  as of M8**: `LFM2-1.2B-Tool` on WebGPU via transformers.js, in its own worker, loading in ~4 s and
  answering in ~3.6 s end to end. The model emits its native Pythonic call syntax, which the page
  parses alongside JSON.
- The tool surface is fully specified and tested against a mock caller **before** any model is
  wired in — the model is a consumer of a proven API, not a prerequisite for it. See
  [docs/tool-api.md](docs/tool-api.md).

### Build and test

- `make wasm` produces the artifact. The guest image and the toolchain that converts it live in
  **two separate Dockerfiles** (`vm/Dockerfile`, `build/Dockerfile.c2w`), so iterating on guest
  packages does not rebuild the conversion toolchain.
- A **single shared conformance table** is executed by the Go/wazero driver and by both Playwright
  browser drivers. Behaviour cannot silently diverge between runtimes. Cases carry a `requires` tag
  naming what they need, so the no-mount emscripten build skips exactly the mount cases and nothing
  else.
- Browser tests run without a native file dialog by mounting an OPFS directory handle through the
  identical code path.

---

## Getting started

```
make wasm        # build the guest image and convert it to dist/smolbox.wasm
make wasm-js     # optional: the emscripten build -> dist/js (no host mount)
make model       # optional: pull the LFM2 checkpoint (1.22 GB) -> dist/models, for the agent page
make build       # build the smolbox CLI

./bin/smolbox exec --mount ./testdata/mount -- ls -la /mnt/host
./bin/smolbox repl --mount ~/some/project

make web serve   # bundle and serve the browser runtime on localhost:8080
```

The dev server hosts the WASI build at `/`, the emscripten build at `/js/` if `dist/js` exists, and
the agent spike at `/agent/`. The agent page needs a GPU; it loads weights from `dist/models` when
`make model` has been run and from the Hugging Face CDN otherwise.

`make wasm` needs a local Docker daemon — the converter drives BuildKit through it.

The same dev server runs in a container, built from the root `Dockerfile`:

```
docker build -t smolbox/serve:dev .
docker run --rm -p 8080:8080 -v $PWD/dist:/data:ro smolbox/serve:dev
```

`HOST`, `PORT` and `DIST_DIR` configure the bind address, the port, and the `dist/`
directory the server reads its artifacts from (smolbox.wasm, the `js/` build, the
weights and the Gemma kernel engine) — `/data` in the image, `dist/` beside the
source tree otherwise. Mounting a host `dist/` over `/data` replaces all of them
at once. The build bakes in `dist/smolbox.wasm` and `dist/js` when the build
context already has them and skips them when it does not — `make wasm` cannot run
inside a container build, since it needs the host's Docker socket.

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
conformance table** — the browser passes the same `cases.json` as the Go driver) and, for the
emscripten build, `make test-e2e-js` (boot smoke, a `/mnt/host` is-empty guard, and the same
`cases.json` minus the mount cases).

The browser runtime requires **cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`); `make serve` sets these. Folder mounting works in
every current browser: `showDirectoryPicker()` where it exists, `<input type="file" webkitdirectory>`
otherwise — `make test-e2e-firefox` runs that second path against a real VM in Firefox.

---

## Non-goals

- Networking from inside the VM. container2wasm supports it; smolbox does not enable it. The sandbox
  is offline by design.
- Write access to the mounted host directory. The mount is read-only, deliberately and permanently.
- Host directory mounting in the emscripten (`--to-js`) build. That target has no such support
  upstream, and adding it would mean wiring virtio-9p through emscripten's filesystem layer. That
  build also has no clean shutdown — its kernel boots with `acpi=off`, so QEMU keeps running after
  the guest halts and the session simply ends with the page.
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

- [PLAN.md](PLAN.md) — implementation plan, research notes, upstream references, risks
- [docs/tool-api.md](docs/tool-api.md) — the exec API and the `run_terminal_command` tool definition
- [docs/schema/](docs/schema) — JSON Schemas, generated from the Go wire types (`make generate`)

## Built on

[container2wasm](https://github.com/container2wasm/container2wasm) ·
[wazero](https://github.com/wazero/wazero) ·
[browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) ·
[xterm-pty](https://github.com/mame/xterm-pty) ·
[Bun](https://bun.sh) ·
[Alpine Linux](https://alpinelinux.org)
