# smolbox

A full x86_64 Linux VM that runs anywhere WebAssembly runs — including a browser tab — and can mount
a folder from your machine as a read-only part of its filesystem. A small on-device LLM drives it by
issuing terminal commands.

> **Status: pre-implementation.** This README describes the intended end state. See
> [PLAN.md](PLAN.md) for the implementation plan, research notes, and current milestone.

---

## What it is

Two components.

**1. The VM.** A minimal Alpine Linux container image, converted to a single portable `.wasm`
artifact with [container2wasm](https://github.com/container2wasm/container2wasm). The same artifact
runs under [wazero](https://wazero.io) on your machine and inside a browser tab, and in both places
it can be handed a host directory that appears inside the guest as an ordinary read-only folder at
`/mnt/host`. In the browser, that directory is one the user picked with the File System Access API —
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
  made on disk.
- A second, faster browser build (`c2w --to-js`, QEMU with JIT and multi-threading) is available for
  workloads that do not need a host mount.

### The exec API

- **One long-lived session.** The VM boots once; commands stream over it. Multi-second boot latency
  is paid a single time, not per tool call.
- **Stateful.** Working directory, environment, and anything written to `/tmp` persist across calls,
  so an agent can `cd`, build up state, and reason across steps.
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

- The exec API is exposed as a `run_terminal_command` tool definition, ready for function calling.
- A WebGPU model in the page calls it, reads the folder the user picked, and reports back.
- The tool surface is fully specified and tested against a mock caller **before** any model is
  wired in — the model is a consumer of a proven API, not a prerequisite for it.

### Build and test

- `make wasm` produces the artifact. The guest image and the toolchain that converts it live in
  **two separate Dockerfiles** (`vm/Dockerfile`, `build/Dockerfile.c2w`), so iterating on guest
  packages does not rebuild the conversion toolchain.
- A **single shared conformance table** is executed by both the Go/wazero driver and the Playwright
  browser driver. Behaviour cannot silently diverge between runtimes.
- Browser tests run without a native file dialog by mounting an OPFS directory handle through the
  identical code path.

---

## Getting started

```
make wasm        # build the guest image and convert it to dist/smolbox.wasm
make build       # build the smolbox CLI

./bin/smolbox exec --mount ./testdata/mount -- ls -la /mnt/host
./bin/smolbox repl --mount ~/some/project

make web serve   # bundle and serve the browser runtime on localhost:8080
```

`make wasm` needs a local Docker daemon — the converter drives BuildKit through it.

Toolchain: **Go 1.24+** for the CLI, **Docker** for the conversion, and **bun** for the web tooling
(bundling, unit tests, typecheck, and the dev server). Run `bun install` once to fetch the web
dependencies.

The browser runtime requires **cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`); `make serve` sets these. The directory picker is
Chromium-only today; other browsers get a labelled fallback.

---

## Non-goals

- Networking from inside the VM. container2wasm supports it; smolbox does not enable it. The sandbox
  is offline by design.
- Write access to the mounted host directory. The mount is read-only, deliberately and permanently.
- Host directory mounting in the emscripten (`--to-js`) build. That target has no such support
  upstream, and adding it would mean wiring virtio-9p through emscripten's filesystem layer.
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
- `docs/tool-api.md` — the exec API and tool definitions *(M7)*

## Built on

[container2wasm](https://github.com/container2wasm/container2wasm) ·
[wazero](https://github.com/wazero/wazero) ·
[browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) ·
[xterm-pty](https://github.com/mame/xterm-pty) ·
[Bun](https://bun.sh) ·
[Alpine Linux](https://alpinelinux.org)
