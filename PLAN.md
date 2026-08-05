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

## 1. Context

`smolbox` starts from an empty repo. The end state is two components:

1. **A full x86_64 Linux VM running in portable WebAssembly**, which treats a dynamically mounted
   host directory as a read-only part of its filesystem. It must run under **wazero** (local
   debugging, Go integration tests) and in a **browser**, where the mounted directory comes from the
   File System Access API (`showDirectoryPicker`).
2. **A small LLM on WebGPU** that performs terminal tool calls into the VM.

This plan builds **component 1 in full** and designs the exec API so component 2 drops in later.
No WebGPU or model work is in scope. The deliverable for component 2 is a stable, documented
tool-call surface plus a mock caller that exercises it end to end.

### Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Browser filesystem | Lazy sync bridge (`SharedArrayBuffer` + `Atomics.wait`) | True lazy mount, any directory size; costs nothing extra because COOP/COEP is already mandatory (§4.4) |
| Guest image | Minimal Alpine — busybox, coreutils/findutils/grep, guest agent | Smallest wasm, fastest boot |
| Build targets | Both; **WASI primary**, emscripten `--to-js` secondary | One artifact runs under wazero *and* the browser; emscripten has a faster CPU but **cannot mount host directories**, and boots and does console I/O more slowly (§4.3, measured at M6) |
| Exec API | Persistent stateful session over stdio | Boot cost is paid once (§8, risk 1); `cwd`/`env`/`/tmp` persist between tool calls |

### Local toolchain (verified 2026-08-03)

`go1.24.3 linux/amd64` · `Docker 29.7.1` · `bun 1.2.18`

Web tooling runs on **bun**, not npm/Node: `bun install` (deps → `bun.lock`), `bun build` (bundling),
`bun test` (TS unit tests), `bunx --bun tsc --noEmit` (typecheck), and `web/serve.ts` (`Bun.serve`
dev server with COOP/COEP headers). The only remaining Node dependency is Playwright's own test
runner at M4 — revisit whether `bunx playwright` suffices, else pin a modern Node for e2e only.

### Measured at M1 (2026-08-03, this machine)

- **Artifact:** `dist/smolbox.wasm` = **112 852 843 bytes** (107.6 MiB). Bochs + pre-booted kernel +
  rootfs.bin + boot.iso, embedded. Below the ~130 MiB limit seen for full-featured images; no
  `--external-bundle` needed.
- **Boot → shell ready:** **~2.5–2.7 s** under wazero (`go test -tags integration`), on the same
  machine. The wizer pre-boot does its job — nothing like the 16 s riscv64 datapoint (§2.8).
- **`make wasm` wall time:** ~5–6 min cold (everything compiled from source in BuildKit); nearly
  free after caching. CI caches `dist/smolbox.wasm` (§7).
- `smolbox exec`/`repl` are M2; today's driver is the integration harness (`tests/integration`).

### Measured at M2 (2026-08-03, this machine)

- **Guest boot → ready banner:** ~3.1–3.2 s under wazero (VM-only, from `InstantiateModule` to the
  `#SMOLBOX-READY#` frame), up from ~2.5 s for the M1 shell — the Go agent (~2.1 MB static binary)
  init on the interpreted Bochs CPU. Total session start including the host-side compile of the
  114 MB module is ~5.1–5.7 s; `Session.BootLatency` reports the VM-only number.
- **M2 integration matrix: 10/10 green** (`make test-integration`): ready within budget, echo
  round-trip, non-zero exit propagation, stdout/stderr separation, `sleep 5` + 500 ms timeout kills
  the process group (exit 137) with no orphan/zombie, 1 MiB stdout intact, `Truncated` past
  `MaxOutput`, a >4096-byte command round-trip (ICANON guard), stateful cwd, and the `/mnt/host`
  mount read through the agent. Each test boots its own VM; the suite runs in ~76 s.

### Measured at M3 (2026-08-03, this machine)

- **Conformance table (`tests/conformance/cases.json`) landed: 14 cases, 14/14 green.**
  `make test-conformance` (wazero driver, one fresh VM boot per case) runs in **~103 s** for the
  whole table. The 10-test M2 matrix moved into the table as the shared declarative source of truth;
  `tests/integration` is now session-lifecycle only (boot budget/caps, `Close`), ~12 s.
- The full mount suite is exercised end to end: `cat` of the fixture file, nested subdirectory,
  `ls -1 /mnt/host` matches the fixture tree, symlink read (`link.txt → hello.txt`), a write
  rejected with `rc=1` / `can't create ...: Invalid argument` at the host boundary, and the `../`
  escape case — **`cat /mnt/host/../secret.txt` fails with "No such file or directory" and never
  exposes the sentinel** (`testdata/secret.txt`, a file sitting next to the mounted dir).
- **Traversal finding (§2.11.10):** the guest kernel resolves `..` above the `/mnt/host` bind mount
  inside the guest before any 9p request reaches wazero, so wazero's `WithReadOnlyDirMount` `../`
  caveat is neutralised in practice — the black-box case holds without guest-side sanitisation.

### Measured at M4 (2026-08-03, this machine)

- **Browser boot → ready: ~2.6 s** (headless Chromium via Playwright, single VM boot from
  `page.goto` to the `#SMOLBOX-READY#` banner; whole `echo hello` e2e test 2.5–2.6 s, the spike
  mount test ~3.1 s). The wizer pre-boot plus the browser's native wasm compiler (not an
  interpreter) make the browser roughly as fast as wazero's ~3.2 s. The single-threaded
  browser_wasi_shim caveat from §2.4 affects concurrency, not speed.
- **Preopen spike: proven.** An in-memory `PreopenDirectory` at `/mnt/host` (fd 3, §2.4 pattern)
  reaches the guest: `cat /mnt/host/hello.txt`, `ls -1 /mnt/host`, and a nested subdirectory read
  all work from Playwright. The `..`-escape and write-rejection cases are **not** covered yet —
  they land with the real Fd in M5.
- **Playwright runner: `bunx --bun playwright test` works under bun.** No Node pin needed after all
  (risk 7 resolved); system Node 18 stays unused. Browsers install via
  `bunx --bun playwright install chromium`.
- **M4 e2e: 2/2 green** (`make test-e2e`): boot + `echo hello` round-trip, and the spike mount
  suite. Web unit tests: 17/17 (`make test-web`).
- The browser worker's stdin is a **SharedArrayBuffer batch channel** (main thread writes whole REQ
  frames, the emulator's fd_read consumes them; `Atomics.wait` sleeps the worker instead of
  busy-looping). This is a one-way preview of the M5 fsbridge pattern (§4.4).

### Measured at M5 (2026-08-03, this machine)

- **Browser passes the full conformance table: 14/14 green** (`make test-e2e`,
  `tests/e2e/conformance.spec.ts`). The exact same `tests/conformance/cases.json` runs in headless
  Chromium through the sync FS bridge mounted on an OPFS directory that mirrors `testdata/mount` —
  including the write-rejection (`EROFS` at the bridge), `../` escape (guest-VFS neutralised, never
  reaching the bridge), nested reads, and the virtual symlink (`link.txt → hello.txt`, which OPFS
  cannot express). Suite: ~52 s for 14 cases, one fresh VM boot each.
- **Boot + mount smoke: 2/2 green** (boot.spec). `echo hello` ~2.6 s; the OPFS mount smoke ~3.9 s.
- **fsbridge unit tests: 55 new** (`make test-web`, 72 total): SAB codec round-trips, MountHost
  dispatch against fake handles, every BridgeFd write op → `ERRNO_ROFS`, chunked reads, `..`
  escapes → `ERRNO_NOTCAPABLE`, and cache invalidation on remount.
- **Two real bugs found while wiring the bridge:**
  1. `TextDecoder.decode`/`TextEncoder.encode` **throw on views over a `SharedArrayBuffer`**
     ("The provided ArrayBufferView value must not be shared"). The bridge must `.slice()` bytes out
     of the SAB before decoding — the request/response JSON is copied into a fresh buffer (§2.11.11).
  2. The e2e fixture walker double-wrapped directories, so OPFS got a `sub/` whose `children` was
     itself `{kind, children}` — surfaced as spurious `kind`/`children` symlink entries in
     `ls /mnt/host/sub`. Fixed in `tests/e2e/harness.ts`; the `ls -1` conformance case is the guard.
- **Caching lives entirely on the main thread** (a deliberate deviation from §4.4's "worker
  memoizes"): the worker cannot receive `postMessage` while the module runs, so worker-side cache
  invalidation on `remount()` would need an epoch dance through the SAB. Keeping memoized
  STAT/READDIR, the chunk LRU, and the path→handle map in `MountHost` makes `remount()` a plain
  cache clear (§4.4).
- **Virtual symlink table**: the File System Access API cannot represent symlinks, so the bridge
  presents a path→target table registered alongside the handle. The conformance fixture derives it
  from `testdata/mount`'s real symlink, so the guest-observable behaviour is identical to wazero's.
- **The VM boots with no mount attached**: the preopen resolves as an empty directory until the user
  (or test) calls `setMount(handle, links)` — mount and remount are main-thread-only and never
  round-trip the worker.

### Measured at M6 (2026-08-04, this machine)

- **The emscripten page passes the non-mount half of the shared table: 10/10 green**
  (`make test-e2e-js`, `tests/e2e/emscripten.spec.ts`) — the boot smoke, the no-mount guard, and the
  8 cases of `tests/conformance/cases.json` not tagged `requires: ["mount"]`, one fresh VM each.
  Suite ~2.0 min, of which the 1 MiB case alone is ~51 s (see console throughput below). The 6 mount
  cases stay excluded by tag; the Go and WASI-browser drivers still run all 14.
- **A GitHub Actions runner is ~2.6× slower than this machine on this target**: boot 23.7 s against
  7.4 s, the small cases ~19–20 s against ~7–8 s, whole suite 5.5 min against 2.0 min. That is
  enough to push the 1 MiB case past the harness's default 120 s exec budget (~48 s of console
  transfer here becomes ~125 s there), so the emscripten driver runs with
  `EMSCRIPTEN_EXEC_TIMEOUT_MS = 300 s` and a 10-minute per-test budget. The case itself is
  unchanged — it is a slow runtime, not a different one. **The WASI suite needs none of this**; its
  console is 10× faster, so the same case takes 7.1 s.
- **Artifact:** `dist/js` = **121 738 772 bytes (116.1 MiB)** — `qemu-system-x86_64.data` 80.2 MB
  (bzImage + rootfs.bin + `vm.state` snapshot + BIOS blobs), `qemu-system-x86_64.wasm` 41.2 MB,
  `out.js` 278 KB, `load.js` 7.6 KB, `arg-module.js` 739 B. Slightly larger than the 107.6 MiB WASI
  artifact, and it is 5 files instead of 1.
- **`make wasm-js`:** ~2.3 s fully cached (BuildKit shares almost everything with `make wasm`).
- **The two browser builds are each faster at different things** (same machine, headless Chromium,
  warm HTTP cache):

  | | WASI (Bochs + browser_wasi_shim) | emscripten (QEMU/TCG JIT) |
  |---|---|---|
  | page open → ready banner | **~1.8 s** | ~7.0 s |
  | console throughput, 1 MiB response | **~345 kB/s** | ~35 kB/s |
  | `awk` 1e6-iteration loop | 129.4 s | **44.9 s** (2.9×) |
  | 20k-iteration `sh` loop | 7.9 s | **5.4 s** (1.5×) |
  | `head -c 2000000 /dev/zero \| md5sum` | 1.6 s | **1.1 s** (1.4×) |

  So the emscripten target is the faster **CPU**, as upstream claims, but it is *not* the faster
  build end to end: it pays ~5 s more to boot (116 MiB of assets plus a QEMU snapshot restore,
  against a wizer pre-booted Bochs) and its console is ~10× slower. It earns its place on long
  CPU-bound work; the WASI build wins on short calls, and it is the only one with a host mount.
- **The console is the emscripten target's bottleneck, structurally.** QEMU's emulated 16550 UART
  writes **one byte per `fd_write`**, and every one of those is a `proxyToMainThread` hop from the
  QEMU pthread to the page. That is the whole ~35 kB/s. Nothing in smolbox can fix it short of
  replacing the chardev.
- **A live emscripten VM costs ~2.1–2.4 CPU cores, even when idle.** Measured across the whole
  page's processes after `close()` had already stopped the guest agent: QEMU's main loop busy-polls
  (the unavoidable consequence of §2.11.15 — the alternative is a VM that never boots) and the TCG
  threads never stop, because QEMU does not exit (§2.11.17). Against a 4-vCPU CI runner that is
  most of the machine, which is why the e2e suite there boots in 16–22 s rather than ~7 s and why
  its budgets are sized separately (`EMSCRIPTEN_{BOOT,EXEC}_TIMEOUT_MS`) with one retry.
  **Teardown is clean, though:** closing the browser context drops CPU back to ~3 % within 3 s, so
  finished tests do not leave spinning workers behind — verified explicitly, because accumulating
  zombie VMs was the obvious suspect and it was wrong.
- The dev server is not a factor: 12 sequential page loads (80 MB `.data` each, ~1 GB served) showed
  a flat 6.5–6.9 s boot, flat JS heap, and flat asset-fetch times.
- **Two real bugs found while wiring the page:**
  1. The shipped `TTY.stream_ops.poll` blocks the VM forever with a headless console (§2.11.15) —
     the single reason the first boot attempt hung.
  2. `FrameDecoder` was **quadratic** and the byte-at-a-time console exposed it (§2.11.16). Fixed in
     `web/src/protocol.ts`; it made the 1 MiB case go from >300 s (timeout) to ~40 s, and the WASI
     browser suite got faster too (52 s → 47 s, the 1 MiB case 7.1 s). Two unit tests guard it
     (`make test-web`, 74 total): a 512 KiB frame fed one byte at a time must decode in under 5 s
     (it takes ~155 ms; the old decoder took minutes), and 200 consecutive frames must survive the
     buffer's compact/grow path in order.
- **QEMU never exits, so there is no clean teardown** (§2.11.17). `SmolboxHandle.close()` on the
  emscripten page shuts the *agent* down and calls the session over; the runtime dies with the page.

### Measured at M7 (2026-08-04, this machine)

- **The mock caller passes on the first run: 12 scripted tool calls, every rendering asserted
  verbatim** (`tests/conformance/toolcall_test.go`, ~10 s for the transcript, ~23 s for all three
  tests including three VM boots). It is one continuous session — orient, read, search, a search
  that finds nothing, a refused write, `cd`, a relative-path report, stdin, per-call env, a timeout,
  a truncation — so ordering and persistence are part of what is asserted.
- **The tool surface costs three Go files, one generator, one TS twin, and no new dependencies.**
  `internal/tool` derives the JSON Schemas from the `internal/protocol` structs by reflection;
  nothing is hand-maintained except the descriptions, and a field with no description is a build
  failure rather than an undocumented property. `make test` runs the whole gate in under a second
  with no Docker.
- **Anti-drift is enforced in three places, all cheap:** `TestArtifactsAreCurrent` fails when a
  checked-in `docs/schema/*.json` no longer matches the Go types (verified by perturbing a file:
  it fails, `make generate` clears it); `web/src/tool.test.ts` deep-equals the TS twin against those
  same generated files; and `TestDocsTableMatchesInputSchema` holds the field tables in
  `docs/tool-api.md` to the schema's property list. `make test-web` is now **108 tests** (was 74);
  `internal/tool` adds **38**.
- **Two real bugs the schema work surfaced**, both pre-existing and neither caught by the
  conformance table: `protocol.Response.Stdout` is a plain `[]byte`, so a silent command sends
  `"stdout": null` and not `""` (§2.11.22), and the TS `Request.stdin` contract inverts the wire's
  (§2.11.23). The first is now in the generated schema as `["string", "null"]`; the second would
  have double-encoded every tool call carrying stdin.

### Measured at M8 (2026-08-05, this machine)

- **The spike passes end to end: one prompt, one real tool call, one grounded answer, in 3.6 s**
  (`make test-e2e-agent`, 9.5 s including page load and VM boot). The transcript, verbatim:
  the model emitted `run_terminal_command(cmd="ls /mnt/host", cwd="/mnt/host", env={}, stdin="",
  timeout_ms=0, max_output=0)`, the call went through `callTool` into a live `Session`, the guest
  listed the OPFS-backed mount (`hello.txt`, `link.txt`, `sub`), and the model read that result and
  answered *"The files found in /mnt/host are hello.txt, link.txt, and sub."* Component 2 is a
  consumer of the M7 surface exactly as designed — **no file under `internal/tool` or `web/src/tool.ts`
  changed to make this work.**
- **Model load is far cheaper than expected: ~4.2 s** for 1.22 GB of q4 weights from `dist/models`
  onto the GPU, and **~2.1 s per generation** (46 tokens). The 1.2 GB download is a one-off
  (`make model`), not a per-run cost.
- **The chat template does the tool wrapping for us — §9.1.4's open question resolved, favourably.**
  `apply_chat_template(messages, { tools })` renders `<|tool_list_start|>[…]<|tool_list_end|>` itself
  and serialises whatever tool objects it is handed **verbatim**, so `web/src/tool.ts`'s
  `openaiTool()` — the anti-drift-guarded, generated schema — reaches the model untouched. No
  hand-rolled special tokens. The `tool` role is wrapped in `<|tool_response_start|>` by the same
  template, so `renderResult`'s M7 output feeds straight back in.
- **The model emits Pythonic tool calls, not JSON, and no prompt wording changed that** — the one
  decision in §9.2 that did not survive contact. Five system prompts were tried against a loaded
  model, including the exact "Output function calls as JSON" line from Liquid's own docs (§9.1.3),
  leading, trailing, on its own line, and with a worked JSON example. **Four produced correct
  Pythonic calls; the fifth produced JSON only because dropping the sandbox context made the model
  hallucinate a fake directory listing instead of calling anything** — a false positive, not a win.
  The calls themselves were consistently *right* (`cmd="ls /mnt/host"` every time), so the fix is to
  parse the syntax the model actually speaks rather than keep bargaining with the prompt.
  `web/src/agent/parse.ts` now reads both syntaxes; JSON stays supported because it costs nothing.
- **`stdin=None` is why the Pythonic reader drops None-valued arguments.** The model fills in every
  optional parameter rather than omitting it, and Python `None` means "not provided". Passing it
  through as `null` would hit `decodeArgs`' type check ("stdin must be a string") and fail a call
  that was actually well-formed.
- **The agent spike cannot run in CI, and that is structural** (§2.11.25). Headless Chromium needs
  `--use-angle=vulkan --enable-features=Vulkan` for a real adapter, and
  `--enable-unsafe-swiftshader` provides **no** software fallback — `requestAdapter()` simply returns
  null. A GPU-less runner has no path to WebGPU at any speed. `make test-e2e-agent` is therefore
  opt-in (`SMOLBOX_WEBGPU=1`) and deliberately absent from CI; the parser it depends on is covered by
  28 GPU-free unit tests that do run there (`make test-web`, **136 total**, was 108).
- **Toolchain drift since M1** (this machine, verified 2026-08-05): **go1.26.5** (go.mod still pins
  `go 1.24.3` and builds clean; the wazero v1.11.0 pin's rationale — v1.12+ needs go ≥ 1.25 — no
  longer binds locally, though CI's pin still decides), **bun 1.3.14** (was 1.2.18), Docker 29.7.1,
  golangci-lint 2.12.2. All five suites re-verified green on a fresh install: `lint`, `test`,
  `test-web` (136), `test-e2e` (16/16), `test-e2e-js` (10/10 in 1.5 min, against PLAN's 2.0 min).
- **`transformers.js` is at 4.2.0, not the v3 §9.1.2 assumed.** Its browser export resolves to
  `dist/transformers.web.js` under `bun build --target=browser`; the `onnxruntime-node` and `sharp`
  dependencies are node-only and bun blocks their postinstalls, so the browser bundle is unaffected
  (`model-worker.js` bundles to 0.99 MB).

---

## 2. Research notes

Everything in this section was verified against upstream sources. Links are the record.

### 2.1 container2wasm

- Repo: <https://github.com/container2wasm/container2wasm> · README: <https://raw.githubusercontent.com/container2wasm/container2wasm/main/README.md>
- Converts an OCI image to `.wasm`, emulating the CPU: **Bochs** for x86_64, **TinyEMU** for
  riscv64, **QEMU** for the `--to-js` browser target. Linux runs on the emulated CPU and **runc**
  starts the container. BuildKit executes the conversion.
- The kernel is **pre-booted at build time with wizer** to cut startup latency — **WASI target only**.
- **Host directories reach the guest via WASI preopens, which the emulator mounts over virtio-9p.**
  This is the mechanism the whole project depends on.
- Latest release **v0.8.4**, published 2026-03-16. Assets:
  `container2wasm-v0.8.4-linux-amd64.tar.gz` (6.5 MB), `container2wasm-v0.8.4-linux-arm64.tar.gz`
  (5.9 MB), `c2w-net-proxy.wasm` (21.6 MB), `SHA256SUMS`.
  → **The builder image downloads the release tarball; it does not compile c2w from source.**
- Requirements: Docker 18.09+ with `DOCKER_BUILDKIT=1`, Buildx v0.8+.
- CLI: `c2w [options] image-name [output file]`. Flags: `--assets`, `--dockerfile`, `--builder`
  (default `docker`), `--target-arch` (default `amd64`), `--build-arg`, `--to-js`, `--debug-image`,
  `--show-dockerfile`, `--legacy`, `--external-bundle`.
- Runtime support table: **wazero has full stdio + mapdir support**. wasmtime full. wamr partial.
  wasmer/wasmedge limited (no stdin).
- `--external-bundle` mounts the container image at runtime instead of embedding it — the fallback
  if the artifact is too large to ship.
- Repo layout worth knowing: `cmd/{c2w,c2w-net,create-spec,get-qemu-state,init}`, `examples/`,
  `tests/`. `examples/llm-agent` exists but is only a README describing a VS Code extension
  (`vscode-llmlet`) on github.dev — **no reusable code**, do not plan around it.

### 2.2 The upstream wazero harness — copy this

<https://raw.githubusercontent.com/container2wasm/container2wasm/main/tests/wazero/main.go>

The whole runtime wiring is one `ModuleConfig`:

```go
wasi_snapshot_preview1.MustInstantiate(ctx, r)
compiled, _ := r.CompileModule(ctx, wasmBytes)
conf := wazero.NewModuleConfig().
    WithSysWalltime().WithSysNanotime().WithSysNanosleep().
    WithRandSource(crand.Reader).
    WithStdout(os.Stdout).WithStderr(os.Stderr).WithStdin(os.Stdin).
    WithFSConfig(fsConfig).
    WithArgs(append([]string{"arg0"}, args[1:]...)...)
_, err = r.InstantiateModule(ctx, compiled, conf)
```

with `fsConfig = wazero.NewFSConfig().WithDirMount(hostPath, guestPath)` parsed from
`-mapdir guest::host`. Networking is optional and bolted on via `gvisor-tap-vsock` +
`wazero/experimental/sock` — **out of scope for smolbox**, but that file is where to look if it is
ever wanted.

We substitute **`WithReadOnlyDirMount`** for the read-only requirement:
<https://github.com/wazero/wazero/blob/main/fsconfig.go> — "same as `WithDirMount` except only read
operations are permitted", implemented by wrapping `DirFS` in a `ReadFS`. Note its documented caveat:
it does **not** by itself prevent `../` traversal, so the guest path must also be sanitised.

### 2.3 Host mounting is proven upstream — for WASI only

<https://raw.githubusercontent.com/container2wasm/container2wasm/main/tests/integration/wazero_test.go>

- `wazero-mapdir`: writes `hi` into a host dir, passes `--mapdir=/mapdir::<hostdir>`, runs
  `cat /mapdir/hi`, expects `teststring`. **Confirms preopen → guest path works.**
- `wazero-mapdir-io`: runs an interactive `sh` and drives it with scripted `input -> expected` pairs
  (`cat /mapdir/hi\n` → `teststring`, `mkdir /mapdir/from-guest\n`, `echo -n hello > …\n`), then
  asserts the files on the **host** afterwards. **Confirms bidirectional 9p and, more importantly,
  that driving a long-lived shell over stdio works — which is the entire persistent-session model.**

<https://raw.githubusercontent.com/container2wasm/container2wasm/main/tests/integration/browsers_test.go>
— contains only `ToJS: true` cases. **There is no upstream test for a host-directory mount in the
browser.** That is unproven territory and is why M4 opens with a spike (§8, risk 2).

### 2.4 The browser example — and where to inject

- `examples/wasi-browser/README.md`: uses **`browser_wasi_shim`** as the WASI polyfill and
  **`xterm-pty`** for the terminal. Trade-off stated upstream: "You can reuse container converted to
  WASI both on the machine (e.g. wasmtime) and inside browser", but it is a single-threaded
  interpreter and therefore slower than the emscripten path.
  <https://raw.githubusercontent.com/container2wasm/container2wasm/main/examples/wasi-browser/README.md>
- `htdocs/` contains: `index.html`, `worker.js`, `worker-util.js`, `wasi-util.js`, `stack.js`,
  `stack-worker.js`, `ws-delegate.js`, `browser_wasi_shim/`.
- **`worker.js`** builds the fd table and instantiates:
  ```js
  fds = [
      undefined, // 0: stdin
      undefined, // 1: stdout
      undefined, // 2: stderr
      certDir,   // 3: certificates dir
      undefined, // 4: socket listenfd
      undefined, // 5: accepted socket fd
  ];
  WebAssembly.instantiate(wasm, { "wasi_snapshot_preview1": wasi.wasiImport })
  ```
  A `wasiHack()` function patches `fd_read` (fd 0) and `fd_write` (fd 1,2) to route through
  xterm-pty's `ttyClient.onRead()` / `onWrite()`.
- **`worker-util.js`** builds that slot as:
  ```js
  var certDir = new PreopenDirectory("/.wasmenv", { ... });
  var _path_open = certDir.path_open;
  certDir.path_open = (e, r, s, n, a, d) => { var ret = _path_open.apply(certDir, [...]); ... };
  certDir.dir.contents["."] = certDir.dir;
  ```
  Three things this proves: **(a)** an arbitrary guest path preopen reaches the guest in the browser;
  **(b)** subclassing/patching `Fd` methods is the supported injection technique; **(c)** c2w's guest
  traversal needs the directory to resolve `"."` to itself — a gotcha our custom `Fd` must reproduce.
- `wasi-util.js` is only WASI poll/event plumbing (`EventType`, `Subscription`), referencing
  <https://github.com/bjorn3/browser_wasi_shim/issues/14>. Nothing filesystem-related.

### 2.5 browser_wasi_shim — the `Fd` contract is fully synchronous

<https://github.com/bjorn3/browser_wasi_shim> · `src/fd.ts`

```ts
export abstract class Fd {
  fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array }
  fd_read(size: number): { ret: number; data: Uint8Array }
  fd_readdir_single(cookie: bigint): { ret: number; dirent: wasi.Dirent | null }
  fd_filestat_get(): { ret: number; filestat: wasi.Filestat | null }
  fd_pwrite(data: Uint8Array, offset: bigint): { ret: number; nwritten: number }
  path_open(dirflags, path, oflags, base, inheriting, fdflags): { ret: number; fd_obj: Fd | null }
  path_filestat_get(flags: number, path: string): { ret: number; filestat: wasi.Filestat | null }
  path_lookup(path: string, dirflags: number): { ret: number; inode_obj: Inode | null }
  path_readlink(path: string): { ret: number; data: string | null }
  path_create_directory / path_link / path_unlink / path_unlink_file /
  path_remove_directory / path_rename / fd_allocate / fd_close / fd_seek / fd_sync / fd_tell / …
}
```

Every method **returns a value; none returns a promise.** Upstream also warns: "A subset of
`wasi_snapshot_preview1` is implemented. The rest either throws an exception, returns an error or is
incorrectly implemented." Built-in backends (`File`, `OpenFile`, `Directory`, `PreopenDirectory`) are
in-memory only.

### 2.6 The browser sync problem, and why the bridge is free

- `showDirectoryPicker()` returns a `FileSystemDirectoryHandle` whose every operation is **async**.
  <https://developer.chrome.com/docs/capabilities/web-apis/file-system-access>
- `createSyncAccessHandle()` — the only synchronous file API on the web — **throws
  `InvalidStateError` if the file is not in the origin private file system**, and exists only inside
  dedicated Web Workers.
  <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle>
  → **A picked directory can never be read synchronously. A blocking bridge is mandatory.**
- Availability: Chromium-only (Chrome/Edge/Opera); not Firefox, not Safari. Secure context required.
- **The bridge is free.** `xterm-pty` "relies on SharedArrayBuffer and Atomics" and requires
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`.
  <https://github.com/mame/xterm-pty> — so the page is cross-origin isolated regardless, and the
  worker-blocks / main-thread-serves pattern is already in use for the TTY.
- `Atomics.wait` blocks and **is only usable on worker threads**; the main thread must use
  `Atomics.waitAsync` or ordinary message handling.
  <https://v8.dev/features/atomics> ·
  <https://developer.mozilla.org/en-US/docs/Web/API/Atomics/wait>

### 2.7 The emscripten `--to-js` target

<https://raw.githubusercontent.com/container2wasm/container2wasm/main/examples/emscripten/README.md>

- `c2w --to-js alpine:3.20 /tmp/out-js/htdocs/` emits JS + wasm into a directory. Supports x86_64,
  aarch64, riscv64. QEMU with **JIT and MTTCG multi-threading**; core count via the `VM_CORE_NUMS`
  build arg. Materially faster than the WASI path.
- **No directory sharing.** The README documents networking modes only, upstream's README scopes
  directory sharing to WASI images, and `browsers_test.go` has no mapdir case. Wiring virtio-9p
  through emscripten's FS is a research project and is explicitly **out of scope**.
- Recorded at M6, not acted on: the generated `arg-module.js` *does* pass
  `-virtfs local,path=/,mount_tag=wasi0`, so the guest can already see emscripten's MEMFS root. A
  future host mount would therefore be a custom emscripten FS backend rather than new QEMU plumbing.
  Still out of scope — the mount belongs to the WASI target, which is the one with a real read-only
  boundary.

### 2.8 Performance data (thin)

<https://github.com/container2wasm/container2wasm/issues/75> — the only concrete public number:
**~16 s to run hello world in node on a 4-core/4 GB device**, on `riscv64/alpine`. That is
boot-dominated, which is the strongest argument for the persistent-session design. No official
boot-time or artifact-size table exists. **M1 must measure and record real numbers.**

### 2.9 Background reading

- <https://medium.com/nttlabs/container2wasm-2dd90a18cc9a> — author's overview of container2wasm
- <https://medium.com/nttlabs/vscode-container-wasm-57d17dda7caa> — containers in VS Code on browser
- <https://pkg.go.dev/github.com/tetratelabs/wazero> — wazero API
- <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system> — OPFS
- <https://simonwillison.net/2024/Jan/3/container2wasm/> — short practical writeup

### 2.10 Open questions to resolve during implementation

- Exact semantics of c2w's `--dockerfile` and `--assets` flags. **Resolved at M1:** `--assets <dir>`
  passes a named build context `assets=<dir>`; when the embedded Dockerfile declares a stage with
  the same name, the named context **shadows it** (verified with a minimal Dockerfile), so the broken
  `assets-base` clone is skipped entirely.
- Whether c2w resolves a locally-built image tag from the host Docker image store without a registry
  push. **Confirmed at M1:** `c2w smolbox/vm:dev …` reads the locally-built tag straight from the
  daemon store. No push needed.
- Actual artifact size for minimal Alpine. **Measured at M1:** 107.6 MiB; `--external-bundle` not
  needed (§1).

### 2.11 Gotchas discovered at M1 (recorded so M2+ does not re-derive them)

1. **c2w v0.8.4's embedded Dockerfile is broken without `--assets`.** Its `assets-base` stage runs
   `git clone -b v0.8.4 https://github.com/ktock/container2wasm`, but that branch does not exist
   (repo has no tags). Workaround: bake a pinned `container2wasm/container2wasm@v0.8.4` checkout
   into the builder image at `/assets` and pass `--assets /assets` (§4.1). The org moved to
   `container2wasm/` after v0.8.4; only `SOURCE_REPO` differs on `main`, no tool versions changed.
2. **The emulator exits with code 1 the instant the guest reads stdin and hits EOF.**
   `bochs/wasm.cc` → `console_read_stdin()`:
   ```c
   ret = read(s->stdin_fd, buf, len);
   if (ret < 0) return 0;      /* EAGAIN: safe, guest keeps waiting */
   if (ret == 0) exit(1);      /* EOF: whole VM dies */
   ```
   Every harness — wazero and wasmtime — must keep stdin **open for the VM's lifetime** (a pipe that
   is never closed; nonblocking reads return `EAGAIN`, which is the safe path). Closing stdin kills
   the VM with exit 1, which wasted an entire debug session masquerading as "the module is broken".
   The in-memory `io.Pipe` reader does not work under wazero's nonblocking path; use a real
   `os.Pipe()` read end (`WithStdin(*os.File)`), matching the upstream harness.
3. **The host mapdir reaches the guest via a `m:` line in the virtual `info` file.** The emulator
   (`write_preopen_info`) emits `m: <guestpath>` for every WASI preopen except `pack`/root; the guest
   init's `parseInfo` turns each into a bind mount of `/mnt/wasi0/<path>` at `<path>`. So
   `WithReadOnlyDirMount(host, "/mnt/host")` is exactly the right API, and writes fail (the guest
   shell reports `can't create …: Invalid argument`) because wazero's `ReadFS` rejects them — the
   read-only boundary holds at the host FS layer as designed.
4. **The `=\n` "handshake" is not a runtime concern.** At runtime the emulator serves the first
   post-boot reads from a hardcoded `"=\n"` buffer (`init_done_str`), so no host cooperation is
   needed; stdin is only consumed by actual guest input afterwards.
5. **wazero v1.12+ requires go ≥ 1.25.** smolbox pins wazero **v1.11.0** to stay on the pinned
   `go 1.24.3` toolchain.
6. **`go mod tidy` drops the `integration`-tagged dependency** if run before `tests/integration`
   exists; keep the file present when adding deps used only behind the tag.
7. **golangci-lint's `install.sh` is broken for v2.x** (caught in CI). Releases now publish
   `*.tar.gz.sbom.json`; `install.sh` greps the bare tarball name from `*-checksums.txt`, which also
   matches the `.sbom.json` line, so the "expected" checksum becomes two lines and never verifies.
   Use `golangci/golangci-lint-action@v7+` in CI (v6 rejects golangci-lint v2 outright).
8. **PID 1 must reap orphans.** After a timeout `kill(-pgid)` the shell dies first and its children
   are reparented to the agent (PID 1); unless the agent `wait4`s them they linger as zombies
   (surfaced as `/proc/<pid>/comm` still showing the dead `sleep`). The agent runs a `WNOHANG` reap
   pass after every exec.
9. **execve env duplicates resolve to the child libc's first match.** Appending `Request.Env` entries
   to a base env list does not override — the base value wins. The agent strips overridden keys from
   the base before appending (§4.2).
10. **Guest `..` above the mount root never reaches wazero.** Verified at M3: the guest kernel
    resolves `..` relative to the `/mnt/host` bind mount inside the guest's own VFS, so a
    `cat /mnt/host/../secret.txt` yields "No such file or directory" inside the guest — the host
    file next to the mounted dir stays invisible. wazero's `WithReadOnlyDirMount` `../`-traversal
    caveat (§2.2) is neutralised by the guest kernel, not by wazero; keep the black-box traversal
    case in `tests/conformance/cases.json` as the regression guard if the emulator ever changes.
11. **browser_wasi_shim's `poll_oneoff` must be replaced, and its clock timelines mixed carefully.**
    The base shim only handles a *single* clock subscription and busy-loops on it; the guest kernel
    polls fd 0 for console input (the emulator's `rx_timer_handler` runs a `select(0)` on stdin,
    which wasi-libc turns into a `poll_oneoff` with an fd_read + a REALTIME clock subscription). The
    upstream browser example replaces it entirely — so does M4's worker (§4.3). **The trap:** the
    shim's MONOTONIC clock is `performance.now()*1e6` but its REALTIME clock is `Date.now()*1e6`;
    subtracting a REALTIME deadline from `performance.now()` yields a ~24.8-day `Atomics.wait` and a
    VM that boots forever. Convert every clock deadline into one timeline (`performance.now()` ms)
    before waiting or comparing.
12. **The browser console is a synchronous wasm thread — it cannot receive postMessage mid-boot.**
    `wasi.start()` blocks the worker for the VM's lifetime, so exec requests cannot be delivered by
    message. The worker instead hands the main thread a `SharedArrayBuffer` stdin channel at startup
    and the main thread writes REQ frames straight into it; responses still come back over
    postMessage (raised inside the worker's `fd_write`). This is why `web/src/stdio.ts` owns a
    `StdinChannel` and why the fsbridge (M5) is the same shape, only two-way.
13. **TextDecoder/TextEncoder throw on views over a `SharedArrayBuffer`.** Chromium rejects decoding
    a `Uint8Array` whose buffer is shared ("The provided ArrayBufferView value must not be shared").
    The fsbridge JSON envelopes must be `.slice()`d into a fresh buffer before decode on *both*
    ends; the binary payload window is read with `TypedArray.prototype.slice`, which already copies
    into a non-shared buffer. M5's first browser boot hung for a full `BRIDGE_TIMEOUT_MS` on this —
    the worker's stat request was fine, but the main thread's decoder threw and never answered.
15. **The emscripten build's shipped `TTY.stream_ops.poll` blocks the whole VM on a headless
    console — the override is mandatory.** c2w's `out.js` looks like it needs no patching (unlike
    the older upstream examples it already ships a PTY-aware `TTY`), but its `poll` calls
    `PTY_askToWaitAgain` whenever the pty has no input, which throws `ErrnoError(1006)`; the
    enclosing `PTY_wrapPoll` then parks the QEMU pthread on `Atomics.wait` until somebody *types*.
    A terminal user always eventually does; a programmatic session never does, so QEMU's main loop
    never reaches its first serial write and the VM appears dead with zero output. Both upstream
    examples (`examples/emscripten{,-simple}/htdocs/index.html`) override
    `Module['TTY'].stream_ops.poll` in `preRun` for exactly this reason. smolbox installs the same
    mask minus the block: `(pty.readable ? 1 : 0) | (pty.writable ? 4 : 0)`. Keeping POLLOUT is a
    deliberate improvement on upstream's `1 : 0`, which drops writability for fd 1/2. **The blocking
    path must stay in `TTY.stream_ops.read`** — that is what suspends `fd_read` between exec calls,
    and `StdinChannel.onWrite` → `ProtocolPty.notifyInput` is what wakes it.
16. **`FrameDecoder` was quadratic, twice over; the emscripten console is what exposed it.** The TS
    decoder reallocated and recopied its whole pending buffer on every `feed`, *and* restarted the
    newline search from the beginning of the pending line each time. Both are invisible when chunks
    are large (the WASI worker's `fd_write` delivers big buffers), and catastrophic when the console
    delivers one byte at a time: a 1.4 MB base64 response frame became ~1e12 byte copies, i.e. a
    >300 s exec that never completed. The decoder now grows by doubling and remembers a `scanned`
    offset, both amortized O(1) per byte. Any future console transport should assume single-byte
    chunks are legal.
17. **QEMU does not exit when the guest stops, so the emscripten build has no clean teardown.**
    c2w's init runs `poweroff -f` once the container command returns, but the kernel is booted with
    `acpi=off` (see the generated `arg-module.js` `-append`), so there is no power-management path
    and the CPU just halts inside a still-running emulator. `Module['onExit']` never fires — waiting
    on it hangs indefinitely (verified past 90 s). The kernel command line lives inside the restored
    `vm.state` snapshot, so it cannot be changed after the fact. `web/src/emscripten/js-main.ts`
    therefore does not use `Session.close()`: it sends the `shutdown` op as a plain request, treats
    the agent's reply as the end of the session, and lets the runtime die with the page.
19. **An un-clocked `poll_oneoff` could sleep the WASI worker forever — the un-clocked cousin of
    §2.11.11.** The M4 fix normalised clock *timelines*, but `waitMs` still started at
    `2**31 - 1` ms (~24.8 days) and was only ever bounded by a clock subscription. A guest poll
    carrying **only** fd-read subscriptions therefore parked the worker in `Atomics.wait`
    indefinitely — and during boot that is fatal, because the host does not write to stdin until
    the ready banner says the guest is up, so nothing can ever wake it. Symptom: a rare boot that
    produces no ready banner while neighbouring boots take 3–4 s. `MAX_POLL_MS` is now **250 ms**,
    which turns that case into a slow re-poll and costs nothing on the normal path (a clock
    subscription already bounds `waitMs` far below it). Found while chasing a CI-only boot hang;
    it was never reproduced locally, including at 2.5× CPU oversubscription (20/20 clean), so
    treat this as the leading explanation rather than a confirmed root cause — the boot watchdogs
    below exist to settle it if it recurs.
20. **Boot hangs must be self-diagnosing, because `wasi.start()` blocks the worker.** No timer can
    fire in the WASI worker once the VM is running, so its watchdog rides the `poll_oneoff` loop
    and posts a stall report (elapsed, poll count, last `waitMs`, un-clocked poll count, console
    bytes) every 5 s after 20 s without a banner. **Silence in those reports is itself the signal**
    — it means `poll_oneoff` stopped returning, i.e. the worker is parked in a wait. The emscripten
    page can use a plain `setInterval` instead (QEMU runs on a pthread, so its main thread is
    free); there `writes=0` would mean the guest never reached its first serial write, which is
    what a regressed TTY poll override looks like (§2.11.15). The e2e harness appends the last 40
    console lines to any boot failure, so CI logs carry the evidence without an artifact download.
21. **`arg-module.js` always emits the netdev args, and that *is* upstream's no-network mode.** The
    generated arguments carry `-netdev socket,connect=127.0.0.1:8888`, so the page logs a failed
    `ws://127.0.0.1:8888/` connection at boot. Upstream's example ships the same arguments and
    documents plain `localhost:8080` (no `?net=` parameter) as "container runs without networking":
    the socket is only reached when `Module['websocket'].url` is set. smolbox never sets it, so the
    console error is cosmetic and the sandbox stays offline. Do not "fix" it by editing the args.
14. **Virtual symlinks are a bridge concern, not an OPFS concern.** The File System Access API has
    no symlink concept, so `MountHost` keeps a path→target table checked before the directory
    handle, and the worker's readdir/stat report `FILETYPE_SYMBOLIC_LINK` for those entries. The
    conformance fixture derives the table from `testdata/mount`'s real symlink, keeping the
    single-table invariant: `cat /mnt/host/link.txt` behaves identically in the browser and under
    wazero. The e2e fixture walker initially double-wrapped directories, surfacing spurious
    `kind`/`children` symlink entries in `ls` — the `ls -1` conformance case catches any future
    regression.
22. **A silent command sends `"stdout": null`, not `""`** (found at M7 while generating the schema).
    `protocol.Response.Stdout` is a plain `[]byte` with no `omitempty`, and `encoding/json` renders a
    nil slice as `null`. The TS side already survived it — `decodeBytes` returns `""` for anything
    that is not a string — but nothing said so on purpose. The generated schema now types `stdout`
    and `stderr` as `["string", "null"]`, derived automatically: any required field of a nilable Go
    kind gets `null` added. A consumer that validates against the schema and assumes a string would
    have failed on the first command that printed nothing.
23. **`Request.stdin` means the opposite thing in Go and in TS, and the tool layer has to convert.**
    On the wire and in Go it is base64 (`[]byte`, decoded by `json.Unmarshal`). In `web/src/protocol.ts`
    it is `string | Uint8Array` where a **string is plain text** that `encodeRequest` base64s on the
    way out. A tool call's `stdin` argument is base64, so `decodeArgs` in `web/src/tool.ts` must
    `atob` it into a `Uint8Array`; passing the string straight through would double-encode every
    call carrying stdin. The mock caller's stdin step is what pins the Go side of this, and
    `tool.test.ts` asserts the decoded bytes on the TS side.

24. **WebGPU needs a secure context, real launch flags, and has no software fallback** (M8). Three
    things that each look like "WebGPU is broken" and are not:
    (a) `navigator.gpu` is **undefined** on `data:` and `about:blank` URLs — it is gated on a secure
    context, so any probe must run against `http://localhost` or https;
    (b) in headless Chromium `requestAdapter()` returns **null** with default flags — the minimum
    that yields a real adapter is `--use-angle=vulkan --enable-features=Vulkan` (measured:
    `{vendor: "nvidia", architecture: "lovelace"}`);
    (c) **`--enable-unsafe-swiftshader` does not help** — it yields no adapter either, so there is no
    GPU-less path. That is why `make test-e2e-agent` is opt-in and not in CI.
    Also absent from this adapter's feature list: **`shader-f16`**. That rules out the `q4f16`
    checkpoint (868 MB, against q4's 1.22 GB) for any run that has to work headless.
25. **onnxruntime-web picks its wasm build at runtime, and a missing variant fails as "no available
    backend found".** transformers.js defaults `ONNX_ENV.wasm.wasmPaths` to a jsdelivr URL
    (`transformers.web.js:7788`); pointing it at a local `/ort/` directory is right for offline use
    and version pinning, **but copying only the variant you expect is not.** This version asks for
    `ort-wasm-simd-threaded.asyncify.mjs` on the WebGPU path, not the `.jsep` build the file names
    suggest, and the failure surfaces as an opaque backend error rather than a 404 for the file.
    `make web` copies **every** `ort-wasm-simd-threaded.*` variant for this reason. (Note the CDN
    default would not itself have been blocked by COEP: jsdelivr sends
    `cross-origin-resource-policy: cross-origin` and `access-control-allow-origin: *`. Vendoring is
    about offline and pinning, not isolation.)
26. **Cache Storage cannot hold a 1.2 GB model file.** transformers.js caches downloaded weights in
    the Cache API by default; a `put` of the q4 `.onnx_data` fails with
    `UnknownError: Failed to execute 'put' on 'Cache': Unexpected internal error`. It is noisy but
    survivable — except it fires on every load. `env.useBrowserCache = false` when serving from
    `dist/models`, where the browser cache buys nothing anyway (the file is already local).
27. **c2w's output is root-owned, and `docker run --user` is the wrong fix.** The converter runs as
    root in the container, so `dist/smolbox.wasm` and `dist/js/` land root-owned and the *next*
    `mkdir dist/js` fails with EPERM for whoever ran make — a confusing failure that has nothing to
    do with the build. The obvious fix breaks it: with `--user $(id -u):$(id -g)` there is no passwd
    entry for the uid, so `$HOME` is `/` and buildx dies on `ERROR: mkdir /.docker: permission
    denied` before conversion starts. (`--group-add` off `getent group docker` is separately unsafe:
    the group is not named `docker` everywhere, and an empty expansion swallows the next argument.)
    The Makefile therefore leaves the conversion byte-for-byte as it was — the path CI exercises —
    and hands ownership back afterwards with a one-shot root container (`RECLAIM_DIST`).
28. **bun block-buffers stdout to a pipe, which makes a long download look like a hang.** `make model`
    piped into a log file showed nothing for minutes while it was working normally; the progress
    lines were sitting in a 4 KB buffer and were lost entirely when the process was killed. Anything
    that reports progress over a multi-minute operation must write to **stderr** (unbuffered) or
    flush explicitly — `web/fetch-model.ts` uses stderr. Related: HF does not return a usable
    `content-length` on a HEAD through bun's fetch (it negotiates a compressed transfer), so the
    size check uses HF's own `x-linked-size` header, which it exposes via
    `access-control-expose-headers` for exactly this.

---

## 3. Repository layout

```
Makefile
PLAN.md                       # this file
README.md                     # ideal end-state scope
package.json + bun.lock       # web deps (typescript, @types/bun) — bun manages these
vm/Dockerfile                 # (1) THE VM: minimal Alpine guest image
build/Dockerfile.c2w          # (2) BUILDS THE VM: c2w toolchain -> dist/smolbox.wasm
cmd/smolbox/                  # CLI: one-shot exec + interactive REPL
cmd/gen-tool-api/             # M7: writes docs/schema/*.json from the Go types (`make generate`)
guest/smolagentd/             # guest agent, static linux/amd64, baked into vm/Dockerfile
internal/protocol/            # wire types + framing, shared by host and guest
internal/vm/                  # wazero wiring, boot, session lifecycle
internal/hostfs/              # read-only mount provider interface + os-backed impl
internal/tool/                # M7: the model-facing tool surface over the exec API
  schema.go                   #   reflection -> JSON Schema, ordered properties
  tool.go                     #   definition, dialect adapters, DecodeArgs, Call, Render
  artifacts.go                #   the generated file set, shared by the generator and its test
web/
  serve.ts                    # dev server: Bun.serve with COOP/COEP headers; /models/ -> dist/models
  fetch-model.ts              # M8: pulls the pinned checkpoint into dist/models (`make model`)
  index.html                  # minimal page: boot/run UI + crossOriginIsolated check
  js.html                     # M6: the same UI for the emscripten build, served at /js/
  agent.html                  # M8: the WebGPU agent spike, served at /agent/
  src/
    agent/                    # M8: the model side (no GPU-free logic below this line)
      messages.ts             #   page <-> model-worker message contract
      model-worker.ts         #   transformers.js on WebGPU, its own dedicated worker
      parse.ts                #   tool-call parser: Pythonic AND JSON (28 unit tests)
      agent-main.ts           #   page entry: VM + model + the transcript; window.__smolagent
    emscripten/               # M6: the --to-js page (no worker, no fsbridge)
      js-main.ts              #   page entry: Module wiring + window.__smolbox
      protocol-pty.ts         #   Module['pty'] over the shared StdinChannel
    worker.ts                 # wasm + WASI shim in a dedicated worker (M4)
    main.ts                   # page entry: spins up the worker, exposes window.__smolbox
    protocol.ts               # TS twin of internal/protocol framing + types
    stdio.ts                  # stdio router: FrameDecoder + SAB stdin channel
    session.ts                # TS twin of internal/vm session client
    tool.ts                   # M7: TS twin of internal/tool (definition, adapters, renderResult)
    mount.ts                  # M5: mount providers (picker / OPFS) behind one interface
    fsbridge/                 # M5: SAB layout, worker Fd, main-thread async service
      protocol.ts             #   SAB layout + op codecs, shared by both ends
      worker-fd.ts            #   blocking Fd subclass (worker thread)
      main-host.ts            #   async service + all caching + virtual symlinks (main thread)
  tsconfig.json
tests/
  conformance/cases.json      # shared behaviour table, run by ALL THREE drivers (`requires` tags)
  conformance/toolcall_test.go # M7: the mock caller — a scripted tool-call transcript
  tool/render-cases.json      # M7: golden tool-result renderings, run by Go AND bun
  integration/                # Go, build tag `integration`
  e2e/                        # Playwright: boot + echo hello + OPFS mount + conformance drivers
    conformance.spec.ts       #   M5: the WASI page, all 14 cases
    emscripten.spec.ts        #   M6: the /js/ page, the 8 non-mount cases
    agent.spec.ts             #   M8: the agent spike; opt-in (SMOLBOX_WEBGPU=1), needs a GPU
testdata/mount/               # fixture directory used as the mounted folder
docs/tool-api.md              # M7: the tool-call surface, hand-written spec
docs/schema/                  # M7: GENERATED from the Go types — never hand-edit
dist/                         # build output (gitignored)
```

---

## 4. Design

### 4.1 The two Dockerfiles

The user requirement is a Dockerfile **for** the VM and a separate Dockerfile that **builds** the VM.
Keeping them separate means the heavy c2w toolchain caches independently of the guest image, so
iterating on guest packages does not re-download the toolchain.

**`vm/Dockerfile` — the VM.** Build context is the repo root (it needs the Go module to compile the
guest agent); invoked as `docker build -f vm/Dockerfile .`.

```dockerfile
FROM golang:1.24-alpine AS agent
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal/protocol ./internal/protocol
COPY guest ./guest
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
      -o /smolagentd ./guest/smolagentd

FROM alpine:3.21          # pin by digest for reproducible wasm builds
RUN apk add --no-cache coreutils findutils grep
COPY --from=agent /smolagentd /sbin/smolagentd
RUN mkdir -p /mnt/host
ENTRYPOINT ["/sbin/smolagentd"]
```

Tagged `smolbox/vm:dev`.

**`build/Dockerfile.c2w` — builds the VM.** A builder *image*, not a build stage.

- From `debian:bookworm-slim`; install `curl ca-certificates`, Docker CLI + buildx plugin.
- Download `container2wasm-v${C2W_VERSION}-linux-amd64.tar.gz` from the GitHub release, **verify
  against `SHA256SUMS`**, install `c2w` on `PATH`. `C2W_VERSION` is an `ARG`, default `0.8.4`.
- `ENTRYPOINT ["/usr/local/bin/c2w"]`.

Run with the host Docker socket mounted, because c2w drives BuildKit through the host daemon and
reads the source image from its image store. The `--assets /assets` flag is a **required workaround**
(§2.11.1): it shadows the broken `assets-base` stage in c2w's embedded Dockerfile.

```
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(PWD)/dist:/out \
  smolbox/c2w-builder:dev --assets /assets smolbox/vm:dev /out/smolbox.wasm
```

This is why `make wasm` depends on `make vm-image` — the tag must already exist locally.

> **M1 guest entrypoint.** The guest image currently runs `ENTRYPOINT ["/bin/sh"]`, so the converted
> module is an interactive shell — the fastest thing to drive from a raw wazero harness. M2 swaps the
> entrypoint to `/sbin/smolagentd` once the agent speaks the framed protocol.

### 4.2 Guest agent and the exec protocol

`guest/smolagentd` is the container entrypoint and owns the console. It is the thing the LLM will
ultimately talk to.

**Console handling.** The guest console is a tty, so the agent first puts fd 0 into raw mode
in-process (`unix.IoctlGetTermios` / `IoctlSetTermios`, clearing `ICANON | ECHO | ICRNL | ONLCR`).
Clearing `ICANON` is not cosmetic: canonical mode caps a line at ~4096 bytes and would silently
truncate large requests. Doing it in-process avoids depending on busybox `stty`.

**Framing.** Line-oriented, base64 payloads, magic prefix:

```
guest -> host, once:  #SMOLBOX-READY#<b64 json caps>\n
host  -> guest:       #SMOLBOX-REQ#<seq>#<b64 json request>\n
guest -> host:        #SMOLBOX-RES#<seq>#<b64 json response>\n
```

Base64 makes the payload immune to any residual tty munging. The host scanner **discards every line
without the prefix**, so kernel messages and boot noise are harmless and no `quiet` kernel-arg
tuning is needed.

**`internal/protocol`** — imported by both host and guest, so the wire cannot drift:

```go
type Request struct {
    Op        string            `json:"op"`   // "exec" | "ping" | "info" | "shutdown"
    Cmd       string            `json:"cmd"`  // passed to sh -c
    Cwd       string            `json:"cwd,omitempty"`
    Env       map[string]string `json:"env,omitempty"`
    Stdin     []byte            `json:"stdin,omitempty"`
    TimeoutMS int               `json:"timeout_ms,omitempty"`
    MaxOutput int               `json:"max_output,omitempty"` // default 1 MiB
}

type Response struct {
    Seq        int    `json:"seq"`
    ExitCode   int    `json:"exit_code"`
    Stdout     []byte `json:"stdout"`
    Stderr     []byte `json:"stderr"`
    TimedOut   bool   `json:"timed_out"`
    Truncated  bool   `json:"truncated"`
    DurationMS int64  `json:"duration_ms"`
    Error      string `json:"error,omitempty"`
}
```

The agent runs each `exec` in its own **process group** so a timeout can `kill(-pgid)` without
leaking children. `stdout` and `stderr` go to separate capped buffers, so child output never reaches
the console and never corrupts the frame stream. `Cwd` defaults to the previous command's directory —
that is what makes the session stateful.

**Implementation notes (M2).** The agent tracks the session cwd itself: it `os.Chdir`s to the current
cwd before spawning (so the child inherits it — no shell-quoting of paths), wraps the user command as
`sh -c '<cmd>; rc=$?; pwd >&3; exit $rc'`, and reads the child's final cwd off an `ExtraFiles` fd-3
pipe. A command ending in `exit`/`exec` skips the `pwd`, so cwd is left unchanged (best-effort).
**Environment is per-request only** (decided at M2): `Request.Env` is merged over the agent's env with
overridden keys stripped first so the overlay wins (execve env duplicates resolve to the child libc's
*first* match — appending alone would let the base value win); guest-side `export` does not carry
over. Raw mode matters twice: `ICANON` off so >4096-byte REQ frames read whole, and `ECHO` off so the
host's REQ lines are not echoed back to stdout, where the host scanner would mistake them for a guest
request. As PID 1 the agent must reap orphans: a process-group kill on timeout orphans the command's
grandchildren to the agent, so `exec` runs a `wait4(-1, WNOHANG)` reap pass after every command —
without it, timed-out commands leave zombies that live forever.

**`internal/vm`** mirrors §2.2:

- `Boot(ctx, Options)` compiles `dist/smolbox.wasm`, wires an `os.Pipe` for stdin (never an
  `io.Pipe` — wazero's nonblocking path mishandles it, §2.11.2) and a pipe for stdout, and calls
  `InstantiateModule` **in a goroutine** — it blocks for the life of the VM.
- Mounts: `Options.Mounts []hostfs.Mount{HostPath, GuestPath}` → `fsConfig.WithReadOnlyDirMount(host, guest)`.
  Default guest path `/mnt/host`.
- A reader goroutine scans framed lines and dispatches responses by `seq`.
- `Exec` is mutex-serialized — one session, one command at a time — and honours `ctx` cancellation.
- `Close` sends `shutdown`, then closes the runtime.

`cmd/smolbox` exposes `smolbox exec --mount <dir> -- <cmd>` and `smolbox repl --mount <dir>`, the
fastest way to debug the VM by hand.

**Read-only is enforced at the host FS layer**, not in the guest — `WithReadOnlyDirMount` in Go, an
`ERRNO_ROFS`-returning `Fd` in the browser. That is the real security boundary; a guest-side
`mount -o ro` would only be defence in depth.

### 4.3 Browser runtime

`web/src/worker.ts` is a fork of upstream `htdocs/worker.js` (§2.4) with two changes.

**1. Stdio is programmatic first, terminal second.** Upstream patches `fd_read`/`fd_write` straight
into xterm-pty's `TtyClient`. We route through `stdio.ts` instead: bytes from fd 1/2 feed the session
decoder **and** are optionally mirrored to a terminal; fd 0 is fed by the session writer. One worker
serves both headless agent calls and a visible console.

The worker cannot receive postMessage while the module runs (§2.11.12), so fd 0 is fed through a
**one-way SharedArrayBuffer batch channel** that the main thread writes REQ frames into and the
worker's `fd_read`/`poll_oneoff` consume (§1, measured at M4). This is the stdin half of the M5
fsbridge, minus the request/response protocol.

**2. The mounted directory is injected as `fds[3]`**, replacing upstream's `certDir` slot. M4's spike
was an in-memory `PreopenDirectory` (§1); M5 replaces it with the sync-bridge `BridgeFd`. The worker
posts a second SAB (`{type:"fschannel"}`) at startup; the main thread services it. **The VM boots
with no mount attached** — the preopen resolves as an empty directory until the user (or test) calls
`setMount(handle, links)`, and mount/remount are main-thread-only (they never round-trip the worker,
so there is no mid-run injection problem).

### 4.3b The emscripten (`--to-js`) page (M6)

`web/js.html` + `web/src/emscripten/` is a second page at `/js/` over the *same* protocol stack:
`protocol.ts`, `stdio.ts` and `session.ts` are reused verbatim, and only the console transport
differs. There is no worker of our own and no fsbridge.

- **Everything runs on the main thread.** QEMU's `main()` runs on a pthread, but every PTY-touching
  syscall (`xterm_pty_old_poll`, `PTY_waitForReadableWithAtomicImpl`, `xterm_pty_old_fd_read`,
  `_fd_write`, `___syscall_ioctl`) is in `out.js`'s `proxiedFunctionTable`, so `Module['pty']` is
  called on the page. `js-main.ts` can therefore hold the session directly and feed a fake
  `MessageSink` — `Session` cannot tell the difference between that and a worker's `onmessage`.
- **`ProtocolPty`** (`web/src/emscripten/protocol-pty.ts`) implements the xterm-pty contract over the
  same `StdinChannel` the WASI worker uses: `read`/`readable` drain REQ frames out of the SAB,
  `write` hands guest console bytes to `StdioRouter`. `StdinChannel.onWrite` fires
  `notifyInput()` so a published frame wakes the runtime's pending `onReadable` — and `onReadable`
  fires immediately (via `queueMicrotask`) when data is already buffered, closing the lost-wakeup
  window between the pthread's EAGAIN probe and its registration of the wait.
- **`preRun` does two things**: writes `/pack/info` (the `t:` line the guest init needs; no `m:`
  lines, this target is deliberately no-mount) and replaces `TTY.stream_ops.poll` — mandatory, see
  §2.11.15.
- **No host mount and no clean exit.** `setMount` is a no-op that says so; `close()` shuts the agent
  down by request rather than waiting for a module exit that never comes (§2.11.17).

### 4.4 The sync FS bridge

```
worker thread (wasm, may block)        main thread (holds the DirectoryHandle)
  Fd.path_open(...)                      -- never blocks --
    encode req into SAB
    postMessage(wake)              ──►   onmessage: readRequest() (sync)
    Atomics.wait(state, REQ)             await handle.getFileHandle(...)
                              ◄──        write payload into SAB
    state == RESP → decode               Atomics.store(state, RESP); Atomics.notify
    return {ret, fd_obj}
```

- **SAB layout:** `[state:i32][errno:i32][reqLen:i32][respLen:i32][reserved×4]`, then a 64 KiB
  request region and a 1 MiB payload window. The response JSON reuses the request region (requests
  are strictly serialized); READ binary data goes into the payload window. Reads larger than the
  window are chunked by the worker into repeated `READ{path, offset, len}` ops.
- **Ops:** `STAT`, `READDIR`, `READ`, `READLINK`. Every write op (`path_create_directory`,
  `fd_pwrite`, `path_unlink_file`, `path_rename`, …) returns `wasi.ERRNO_ROFS` **without touching the
  bridge at all**. `path_open` also rejects write intent (`O_CREAT`/`O_TRUNC` or `RIGHTS_FD_WRITE`)
  up front, and normalises paths itself: absolute paths and `..` above the mount root →
  `ERRNO_NOTCAPABLE` (a defensive boundary — the guest VFS already resolves `..` above the bind
  mount, §2.11.10).
- **The main thread never blocks** — `Atomics.wait` is forbidden there (§2.6). The worker signals via
  `postMessage` and *then* blocks; the main thread replies through the SAB and `Atomics.notify`.
  This is exactly the xterm-pty pattern, and the two blocking channels (tty, fs) are independent SABs
  serviced by the same non-blocking event loop.
- **Caching lives entirely in `MountHost` on the main thread** (deviation from an earlier draft
  where the worker memoized — §1, measured at M5). The worker cannot receive `postMessage` while the
  module runs, so worker-side cache invalidation on `remount()` would need an epoch dance through the
  SAB. Memoized `STAT`/`READDIR`, a chunk LRU (512 entries), and the path→handle map all sit next to
  the handle; `remount()` clears them in one call — the answer to "the user edited the folder".
- **Virtual symlinks.** The File System Access API cannot represent symlinks, so `MountHost` keeps a
  path→target table checked before the directory handle, and the worker's readdir/stat report
  `FILETYPE_SYMBOLIC_LINK` for those entries. The conformance fixture derives the table from
  `testdata/mount`'s real symlink (§2.11.14), so `cat /mnt/host/link.txt` behaves identically in the
  browser and under wazero.
- **Gotcha from §2.4:** c2w's guest traversal needs the directory to resolve `"."` to itself. Our `Fd`
  handles `"."` and `".."` explicitly (readdir cookie 0/1, §2.4 pattern) and rejects `..` escapes
  above the mount root (see also the `WithReadOnlyDirMount` traversal caveat in §2.2).

**Testability.** `mount.ts` accepts anything structurally matching `FileSystemDirectoryHandle`.
Playwright cannot drive `showDirectoryPicker()`, but `navigator.storage.getDirectory()` (OPFS)
returns the same interface — so E2E tests populate an OPFS tree (walked from `testdata/mount` on the
Node side, so the bytes match the wazero mount) and mount that, exercising the identical code path
with no native dialog.

**Browser support.** Chromium-only for the picker. Firefox and Safari get a clearly-labelled degraded
path (drag-and-drop a folder, or OPFS) behind the same provider interface. The page must check
`crossOriginIsolated === true` at startup and fail with a readable message rather than a cryptic
`Atomics` error.

### 4.5 Tool-call surface for the future LLM (M7 — done)

`internal/protocol` *is* the tool surface; `internal/tool` is the model-facing view of it. The model
gets exactly **one** tool, `run_terminal_command`. Listing a directory, reading a file, searching a
tree — those are commands, not more tools.

**The schemas are derived, not written.** `objectSchema` reflects over the `internal/protocol`
structs, so a schema cannot describe a shape the wire does not have. Only the *descriptions* are
hand-written, and they live in `internal/tool` rather than as doc comments on the wire types: they
are prompt text, not Go documentation. A field with no description is a hard error, which is what
stops the model-facing surface from quietly growing when somebody adds a field to `protocol.Request`.

**The tool input is `Request` minus `op`, with `cmd` required.** Two deliberate deviations:

- `op` is not in the input schema and a tool call that sets it is rejected before the session sees
  it (`ErrOpNotAllowed`). The tool is the exec surface and nothing else — a model must not be able
  to talk its own sandbox into `shutdown` by naming it in an argument object.
- `cmd` is `omitempty` on the wire (correct: `ping` carries none) and required for the tool (a tool
  call without a command is meaningless).

Unknown fields are rejected rather than ignored, so a hallucinated `"recursive": true` comes back as
an error the caller can feed to the model instead of a flag silently dropped.

**Two dialects, one definition.** `Definition` is runtime-neutral; `Anthropic()` and `OpenAI()` are
thin adapters over the same input schema, mirrored in `web/src/tool.ts`. The future WebGPU model's
inference stack picks the dialect; nothing about smolbox changes.

**`Call` returns both renderings** — text for the model, `*protocol.Response` for the host. `Render`
deliberately omits `duration_ms`: the rendering is asserted verbatim by the mock caller, and a
wall-clock number would make every transcript unstable. It takes a `tool.Execer` interface, not a
`*vm.Session`, so the package has no dependency on wazero and the same call path serves the browser.

**Anti-drift is mechanical, in three places:** `TestArtifactsAreCurrent` (checked-in JSON vs. the Go
types), `web/src/tool.test.ts` (the TS twin deep-equals that same JSON), and
`TestDocsTableMatchesInputSchema` (the prose tables in `docs/tool-api.md` vs. the schema's property
list). The Go/TS `Render` twins are held together by `tests/tool/render-cases.json`, run by both
suites — the same shared-table trick as the conformance table, one level up.

**The mock caller** (`tests/conformance/toolcall_test.go`) is the proof the surface works without a
model: 12 scripted tool calls against a real booted VM, each an argument object exactly as a model
would emit it, with the rendered result asserted verbatim. It proves the two things a JSON Schema
cannot — that a model-shaped argument object reaches the guest and comes back correctly, and that
the text a model would read is stable enough to assert.

---

## 5. Makefile targets

| Target | Does |
|---|---|
| `vm-image` | `docker build -f vm/Dockerfile -t smolbox/vm:dev .` |
| `builder-image` | `docker build -f build/Dockerfile.c2w -t smolbox/c2w-builder:dev build/` |
| `wasm` | deps `vm-image builder-image` → `dist/smolbox.wasm` (WASI, primary) |
| `wasm-js` | same via `c2w --to-js` → `dist/js/` (emscripten, **no host mount**) |
| `test-e2e-js` | Playwright against the `/js/` page: boot smoke + the non-mount conformance cases |
| `model` | `bun web/fetch-model.ts` → pulls the pinned q4 checkpoint (1.22 GB) into `dist/models` |
| `test-e2e-agent` | Playwright against `/agent/`: the M8 spike. Opt-in, needs a GPU and `make model`; **not in CI** |
| `build` | `go build ./cmd/smolbox` → `bin/smolbox` |
| `web` | bundle `web/src/{worker,main}.ts` + copy `index.html` and `dist/smolbox.wasm` → `web/dist` |
| `serve` | `bun web/serve.ts` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` |
| `generate` | `go run ./cmd/gen-tool-api` → rewrites `docs/schema/*.json` from the Go wire types |
| `test` | Go unit tests; no Docker required |
| `test-integration` | `go test -tags integration ./tests/integration/...`; requires `dist/smolbox.wasm` |
| `test-web` | `bun test web/src` — protocol framing + session unit tests |
| `test-e2e` | Playwright (`make web` first) against `make serve` |
| `test-conformance` | runs `tests/conformance/cases.json` through the Go/wazero driver **and the mock caller** (browser driver **M5 done**) |
| `lint` | `golangci-lint run` + `tsc --noEmit` |
| `clean` | remove `dist bin web/dist` |
| `all` | `build wasm web` |

`make wasm` fails with an actionable message if `/var/run/docker.sock` is absent.

---

## 6. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Go module, layout, Makefile skeleton, CI | `make lint test` green — **done** |
| M1 | `vm/Dockerfile`, `build/Dockerfile.c2w`, `make wasm` | `dist/smolbox.wasm` exists; raw wazero runs `echo hello`; **artifact size and boot time measured and recorded in this file** — **done** (§1) |
| M2 | Guest agent + protocol + `internal/vm` session + CLI | `smolbox repl` works; Go integration matrix green | **done** (§1) |
| M3 | Read-only host mount under wazero + shared conformance table + Go driver | mount cases in the conformance table green — **done** (§1) |
| M4 | Browser worker, stdio router, TS session — **spike the preopen first** | Playwright boots the VM and runs `echo hello` | **done** (§1) |
| M5 | Sync FS bridge + browser mount | browser passes the **same** conformance table as Go — **done** (§1) |
| M6 | `make wasm-js` emscripten target | boots in browser; passes the non-mount conformance cases; documented as no-mount — **done** (§1) |
| M7 | Tool-API docs, JSON Schema, mock caller | `make test-conformance` covers the tool surface — **done** (§1, §4.5) |

---

## 7. Verification

**Shared conformance table (`tests/conformance/cases.json`)** is the core of the strategy: one
declarative list of `{name, requires?, steps[{request, expect}]}` cases, executed by a Go driver
against wazero (`tests/conformance`, **M3 done**), by a Playwright driver against the WASI browser
page (`tests/e2e/conformance.spec.ts`, **M5 done**), and by a third Playwright driver against the
emscripten page (`tests/e2e/emscripten.spec.ts`, **M6 done**).
`requires` names the capabilities a case needs: the first two drivers run everything, while the
emscripten driver skips `["mount"]` because that build has no host mount. The Go driver ignores the
field entirely (unknown JSON keys), so tagging a case cannot weaken it.
`expect` is a partial `protocol.Response` matcher (`exit_code`, exact `stdout`/`stderr`,
`stdout_contains`/`stdout_not_contains`/`stderr_contains`, `stdout_len`, `timed_out`, `truncated`);
each case boots a fresh session and its steps run in order. Behaviour cannot silently diverge
between runtimes — the browser driver runs this **same** file, mounting an OPFS tree walked from
`testdata/mount` (with its symlink presented through the bridge's virtual table).

Cases:

- ready banner arrives within the boot budget
- `echo hello` round-trips
- non-zero exit code propagates
- stdout and stderr stay separated
- `sleep 5` with a 500 ms timeout sets `TimedOut` and leaves no orphan process
- 1 MiB of stdout survives intact
- `Truncated` is set past `MaxOutput`
- a line >4096 bytes round-trips — the `ICANON` regression guard
- **state persists**: `cd /tmp && touch x`, then `test -f /tmp/x` in a *later* call
- **mount**: `cat /mnt/host/hello.txt` matches `testdata/mount`; `ls /mnt/host` matches the fixture
  tree; nested subdirectory read; symlink resolves; `echo x > /mnt/host/hello.txt` fails `EROFS`;
  `../` escape above the mount root fails

**Go unit tests** (no Docker): `internal/protocol` framing round-trips — lines missing the prefix,
interleaved kernel noise, reads split across buffer boundaries, oversized frames. The read-only
provider boundary (`internal/hostfs` is a plain `Mount` struct; wazero's `ReadOnlyDirMount` is the
implementation) is covered end-to-end by the mount cases in the conformance table rather than a
standalone unit test. `internal/tool` (**M7 done**, 38 tests) covers the schema derivation, argument
decoding and its rejections, the dialect adapters, the render goldens, and the three anti-drift
gates (§4.5).

**The tool surface** (**M7 done**): the mock caller in `tests/conformance/toolcall_test.go` runs
under `make test-conformance` — a 12-step scripted transcript against a real booted VM with every
rendering asserted verbatim, plus the negative half (argument injection refused against a live
session, which must stay usable afterwards) and the failed-command / broken-session distinction.
The shared render table `tests/tool/render-cases.json` is run by both the Go and the bun suites.

**TS unit tests** (`bun test`, **M4 + M5 done**): the TS framing twin (`protocol.ts`) round-trips
requests/ready/responses against the Go wire shape and skips noise; the SAB stdin channel and
`session.ts` against a mock worker (boot, seq'd exec dispatch, close, error paths); and the fsbridge
suite — SAB codec round-trips, `MountHost` dispatch against fake directory handles, every `BridgeFd`
write op returns `ERRNO_ROFS`, chunked reads larger than the payload window, `..` escapes →
`ERRNO_NOTCAPABLE`, and cache invalidation on `remount()`. **M7** adds `tool.test.ts`: the TS
definition deep-equals the generated `docs/schema/*.json`, `decodeArgs` refuses the same classes of
malformed call the Go side does, and `renderResult` runs the shared golden table.

**Browser e2e** (`make test-e2e`, Playwright, **M4 + M5 done**): boots `dist/smolbox.wasm` in headless
Chromium through the real worker/session code path and asserts the `echo hello` round-trip, the OPFS
mount smoke (file/nested/list/symlink reads through the sync bridge), and the **full conformance
table** (`tests/e2e/conformance.spec.ts`, 14/14) — the browser half of the single-table guarantee.

**Emscripten e2e** (`make test-e2e-js`, Playwright, **M6 done**): boots `dist/js` at `/js/` and runs
the boot smoke, a `/mnt/host is empty` guard for the no-mount non-goal, and the 8 conformance cases
not tagged `requires: ["mount"]` (10/10). It runs from its own
`tests/e2e/playwright.emscripten.config.ts` because it needs `dist/js` rather than
`dist/smolbox.wasm`; the WASI config `testIgnore`s the spec so `make test-e2e` stays buildable
without it.

**Manual smoke:** `make wasm web serve`, open the page, boot the VM, `echo hello`; pick a folder and
`ls -la /mnt/host` through the picker, or `setMount` the OPFS root.

**CI** (GitHub Actions): unit tests on every push (Go + bun via `oven-sh/setup-bun`, including
`make test-web`); `make wasm` + integration + conformance on a Docker-enabled runner, caching
`dist/smolbox.wasm` keyed on the hashes of `vm/Dockerfile`, `guest/`, and the c2w version; a
browser e2e job (restores the wasm cache, installs Chromium, runs `make test-e2e`) — **M5 done**;
and an emscripten e2e job on the same shape, caching `dist/js` (~116 MiB) under its own key and
running `make test-e2e-js` — **M6 done**. **M7 needed no new job**: the generated-schema staleness
gate rides `make test` in the unit job, the TS twin check rides `make test-web`, and the mock caller
rides `make test-conformance` in the wasm job.

---

## 8. Risks and mitigations

1. **Boot latency.** The only public datapoint (~16 s hello-world, riscv64, §2.8) badly oversold the
   fear. Measured **~2.5–2.7 s** to a shell under wazero on x86_64 (M1, §1), boot-dominated and paid
   once thanks to the persistent-session design. If it ever becomes a problem, `--target-arch riscv64`
   (TinyEMU) is the escape hatch, at the cost of the x86_64 requirement.
2. **Browser WASI mapdir is unproven upstream.** No upstream test covers a host-directory mount in
   the browser (§2.3); the `/.wasmenv` `certDir` precedent shows the mechanism works (§2.4).
   **Mitigation: M4 opens by spiking a hardcoded in-memory `PreopenDirectory` at `/mnt/host` and
   confirming the guest sees it, before any bridge code is written.** Everything downstream depends
   on this, so it must be the first browser task. **Status: resolved at M5** — the in-memory spike
   passed at M4 (§1), and M5's real bridge passes the full conformance table in Chromium, including
   the write-rejection and `../`-escape cases, over a `FileSystemDirectoryHandle` served through the
   SAB (§1, measured at M5).
3. **Wasm artifact size.** **Measured 107.6 MiB for minimal Alpine + BusyBox tooling** (§1). Under the
   pain threshold; if delivery ever hurts, `c2w --external-bundle` mounts the image at runtime
   instead of embedding it.
4. **COOP/COEP required.** Non-negotiable for `SharedArrayBuffer`. `make serve` sets the headers;
   deployment docs must call it out; the page detects `crossOriginIsolated === false` and fails
   clearly.
5. **Emscripten target cannot mount host directories** (§2.7). Ships as an explicitly no-mount
   alternative. Wiring virtio-9p through emscripten's FS is out of scope. **Measured at M6:** it is
   the faster *CPU* (1.4–2.9×) but not the faster build — it boots ~5 s slower and its console runs
   ~10× slower, so it only pays off on long CPU-bound work (§1).
6. **c2w needs the host Docker socket** (§4.1). Documented in the Makefile and README.
7. **Node 18 is EOL — and unused.** All web tooling runs on bun. Playwright's runner at M4 is the
   only Node dependency. **Resolved at M4:** `bunx --bun playwright test` works under bun, so no
   Node pin is needed; browsers install with `bunx --bun playwright install chromium`.
8. **stdin EOF kills the VM.** The emulator exits 1 on any guest stdin read returning EOF
   (§2.11.2). Every host harness must keep stdin open for the VM's lifetime. This is why the session
   owns a persistent `os.Pipe`.
9. **c2w's embedded Dockerfile needs the `--assets` workaround** (§2.11.1, §4.1). The builder image
   bakes the pinned `container2wasm@v0.8.4` checkout and every `make wasm`/`wasm-js` passes
   `--assets /assets`.

---

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
   (**1.22 GB — what smolbox uses**), `model_q4f16.onnx` (868 MB, needs `shader-f16`, which headless
   Chromium does not expose, §2.11.24), and `model_quantized.onnx` (q8, 1.2 GB). There is no
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

---

## 10. Component 2, continued: chat, models, and tools (M9–M11)

§9 proved the mechanism: a local model can drive the VM through the M7 tool surface. This section
built the product around it — a real chat interface, more than one model, and tools the user can
shape. **Status: M9, M10 and M11 are done** (measurements in §10.9).

### 10.1 What M8 established that this section is built on

Facts, not assumptions — each was measured, and each constrains a decision below.

- **The tool surface does not need to change to serve a model.** M8 shipped without touching
  `internal/tool` or `web/src/tool.ts`. Everything here must hold that line: new capability belongs
  *around* the exec API, not inside it.
- **Call syntax is a property of the checkpoint, not of the docs** (§9.1.3). LFM2 emits Pythonic
  against five different prompts, including the wording its own vendor documents for JSON. Any
  second model must be assumed to have its own syntax until a real transcript proves otherwise.
- **A tool definition is expensive prompt real estate.** The rendered system prompt for the *single*
  `run_terminal_command` tool is **2301 characters** (measured against the real template, OpenAI
  dialect). Six tools is roughly 9–14 KB of system prompt on **every** turn, which a 1.2B model pays
  for in both latency and attention. This is the strongest argument against a large tool list and
  the reason §10.5 makes exposure per-session and opt-in.
- **The context window is not the near-term limit; the output cap is.** LFM2's
  `max_position_embeddings` is **128 000**, but `Request.MaxOutput` defaults to **1 MiB** — on the
  order of 250k tokens from a single `cat`. The loop must budget output long before context runs out.
- **There is no CI for anything that needs a GPU** (§2.11.24). This is the single biggest force on
  the designs below: every milestone here is shaped so that its logic is pure and testable without
  one.

### 10.2 Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Chat loop | Multi-turn, **bounded** iterations per user message | An agent that can call tools forever is a hang with extra steps; a hard cap makes the failure legible |
| Output budget | The agent sets **`Request.max_output` per call** and lets `Render` report `truncated` | The knob already exists in the M7 surface and the rendering already says "output truncated" — inventing a second truncation layer would put two different numbers in front of the model |
| History policy | Keep the system prompt and recent turns verbatim; **elide oldest tool outputs first**, leaving the command and exit code | Tool output is the largest and least reusable thing in the history; the *fact* that a command ran and what it returned matters longer than its bytes |
| Model selection | **Curated registry, each entry pinned to a revision and tagged with its dialect** | §10.1: syntax cannot be assumed. A dropdown over known-good entries fails honestly; a free-text model id fails as a mystery |
| Quantization | Chosen at runtime from the **adapter's feature list**, not hardcoded | `shader-f16` is absent in headless Chromium but likely present on a real desktop (§2.11.24), so `q4f16` is a legitimate choice *sometimes*. Ask the adapter |
| Tool sources | **Three**: Go-generated built-ins, user-defined command templates, per-session overrides | All three were asked for, and they are genuinely different things — a schema, a macro, and a preference |
| User-tool **format** | Defined in Go, schema generated by `make generate`, validated in TS against that generated schema | Keeps "one definition, two runtimes" true *of the extension mechanism itself*. The thing that validates user tools is as anti-drift-guarded as the tool surface is |
| Template quoting | Shell-quote interpolations by **default**; explicit `{param:raw}` to opt out | Correctness first: a pattern containing a space or a quote must work. It also makes a future restricted mode safe by construction rather than by audit (risk 15) |
| Tool exposure | Per-session opt-in, default = today's single tool | §10.1's 2301-character measurement. More tools must be a choice someone makes, not a default they absorb |
| Testability | A scripted **`FakeModel`** behind the same worker interface as the real one | The only way any of this gets CI coverage. This is M7's mock-caller trick one level up |

### 10.3 M9 — chat UI and the multi-turn loop

The agent page stops being a spike and becomes something a person uses.

**The loop.** One user message drives: generate → parse → execute every returned call → append results
→ generate again, until the model returns no tool calls or the iteration cap is hit. The cap is a
session setting with a small default; hitting it ends the turn with a visible "stopped after N tool
calls" rather than silently truncating the model's plan.

**Budgets, which are the real content of this milestone.** Three, and they are different:

- *Per call*: the agent sets `max_output` to a few KB rather than the 1 MiB default. `truncated`
  already flows through `Render`, so the model is told its output was cut and can narrow the command.
- *Per history*: oldest tool outputs are elided first (command and exit code retained), then oldest
  turns. Elision must be visible in the UI — a user who cannot see what the model has forgotten
  cannot debug it.
- *Per turn*: `max_new_tokens`, already present, surfaced as a setting.

**Streaming.** `TextStreamer`'s `callback_function` feeds tokens to the page as they generate.
Note the interaction with parsing: a tool call is only parseable once complete, so the UI streams
prose but must hold the `<|tool_call_start|>` region back until the block closes rather than render
half a call.

**Stop.** A user-visible interrupt. Generation and an in-flight `exec` are separately cancellable —
`Session.exec` already takes a timeout and the VM kills the process group, so the pieces exist.

**UI shape.** A message list; tool calls rendered as a collapsible block showing the command, exit
code, and output; the mount picker and model status inline; errors as messages rather than console
noise. Deliberately *not* in scope: theming, persistence of conversations, markdown rendering of
model output.

**`FakeModel`.** A scripted implementation behind the worker's message contract that replays canned
turns — including a tool call, a malformed call, and a plain answer. It makes the loop, the budgets,
the elision policy, the stop path, and the UI drivable by Playwright **in CI, with no GPU**. Its
scripts live in a shared table, the same trick as `cases.json`.

**Done when:** a Playwright suite drives a real multi-turn conversation against `FakeModel` in CI —
tool call executed, result fed back, budget enforced, history elided, stop honoured — and one manual
run against the real model on WebGPU behaves the same.

### 10.4 M10 — the model registry and dialects

**The registry** (`web/src/agent/models.ts`) is a code-defined list. Each entry carries: HF id,
**pinned revision**, candidate dtypes in preference order, approximate download size, context length,
and its **dialect**. The UI is a dropdown over this list showing size and whether the weights are
already in `dist/models`.

**Dialects** (`web/src/agent/dialects/`) are the generalisation of M8's parser. A dialect owns the
tool-call syntax and any prompt-construction quirk. Three are known to exist in the wild — LFM2's
Pythonic, the Hermes/Qwen `<tool_call>{json}</tool_call>` form, and Llama's `<|python_tag|>` — and
they are pure functions over strings, so each is unit-tested from **captured fixtures** with no GPU.

**A dialect is `verified` only once a transcript has been captured from the real model.** Anything
implemented from documentation alone is `unverified` and says so in the UI. This is M8's lesson
encoded as a type: the vendor docs were wrong, and a plan that trusts the next vendor's docs will be
wrong again.

`make model MODEL=<key>` takes a registry key; the default stays LFM2 so existing commands keep
working.

**Done when:** two model families run the same conversation through their own dialects, the dialect
parsers pass unit tests from captured fixtures in CI, and selecting a model with an unverified
dialect warns rather than silently misparsing.

### 10.5 M11 — customizable tools

Three sources feed one registry, and the split is what keeps the existing invariants intact.

1. **Built-in tools**, defined in Go and generated exactly as today — `run_terminal_command` plus,
   optionally, narrow ones (`read_file`, `list_dir`, `search_files`). These keep all three anti-drift
   gates. Note this *amends* PLAN §4.5's "commands, not more tools": that decision was made for a
   model that did not exist yet, and §10.7's open question is whether narrow tools actually help a
   1.2B model or just cost it 2301 characters each.
2. **User-defined command templates**, created in the UI: a name, a description, typed parameters,
   and a shell template such as `grep -rn {pattern} /mnt/host`. They are runtime data, validated
   against a **generated** schema for the definition format itself, and they compile to an ordinary
   exec `Request`.
3. **Per-session overrides**: the description text a model reads, and defaults for `timeout_ms`,
   `max_output`, `cwd`.

**Invariants that must survive, and must be tested to survive:**

- `op` is unreachable from every path. A user tool cannot name it, template it, or override it.
- Unknown arguments are still rejected, per tool.
- Every tool, whatever its source, compiles to an exec `Request` — there is exactly one way into the
  guest.
- The built-in half stays generated. Hand-editing `docs/schema/*.json` remains a test failure.

**Why this is not a new security boundary.** A user-defined template grants the model nothing it
does not already have: with `run_terminal_command` exposed it can run arbitrary shell, so
interpolating model output into a template is the same privilege by a shorter path. Quoting is
specified for *correctness*. That reasoning inverts the moment a "restricted mode" exists that
removes the raw tool (risk 15) — which is exactly why quoting is the default now rather than a
later retrofit.

**Persistence** is local (the browser), with JSON export/import so a tool set can be shared or
checked into a repo. No server, consistent with everything else here.

**Done when:** a user-defined tool is created in the UI, exposed to `FakeModel`, called, and executes
against a real session in CI; the injection and `op` cases are unit-tested; and toggling tools
changes what the rendered system prompt contains.

### 10.6 Milestones

| # | Deliverable | Done when |
|---|---|---|
| M9 | Chat UI, multi-turn loop, the three budgets, `FakeModel` | A CI Playwright suite drives a full multi-turn conversation against `FakeModel` — tool call, feedback, budget, elision, stop — and one manual WebGPU run matches |
| M10 | Curated model registry + per-family dialects | Two model families run the same conversation; dialect parsers unit-tested from captured fixtures in CI; unverified dialects warn |
| M11 | Tool registry: built-ins, user templates, session overrides | A user-defined tool round-trips from UI to guest under `FakeModel` in CI; `op`-injection and quoting cases unit-tested; exposure toggles change the prompt — **done** |

All three are **done**; M9 and M10's done-when conditions are met the same way (§10.9).

### 10.7 Open questions

- **Do narrow tools actually help a 1.2B model?** M8 proves it uses one general tool well. Whether
  `read_file`/`search_files` improve or degrade its choices is unmeasured, and the honest answer may
  be "they cost 2301 characters each and help nothing". M11 should measure before it recommends.
- How many tools before the model starts mis-selecting? Needs a small eval, not an opinion.
- Does the dedicated-worker split still hold when generation streams *and* a tool runs concurrently?
  (Carried over from §9.4; M9's stop button is the first thing that tests it.)
- Whether the agent page should replace `/` as the primary page once it is a real UI, and what
  happens to the VM-only harness that Playwright drives today.
- Conversation persistence across reloads — deliberately out of M9, but users will expect it.
- Whether `FakeModel` scripts and real dialect fixtures can share one table, the way `cases.json` is
  shared across three drivers.

### 10.8 Risks

13. **More tools may make the model worse, and the prompt longer.** Every definition costs ~2301
    characters of system prompt on every turn (§10.1) and adds a selection decision a small model can
    get wrong. **Mitigation:** exposure is opt-in and defaults to today's single tool; M11 measures
    before recommending anything wider.
14. **A dialect implemented from documentation is a guess.** M8's central lesson: the vendor's
    documented JSON switch did not work. **Mitigation:** the `verified`/`unverified` distinction is
    part of the registry, surfaced in the UI, and only a captured transcript promotes a dialect.
15. **Template quoting becomes a real boundary if a restricted mode is ever added.** Today,
    interpolating model output into a shell template is no escalation because raw shell is already
    exposed. Remove `run_terminal_command` from a session and that stops being true instantly.
    **Mitigation:** quote by default *now*, make `{param:raw}` explicit and visible, and treat any
    future restricted mode as a change that must re-audit every template.
16. **Bigger models may not fit.** The measured adapter reports `maxBufferSize` 4 GiB and
    `maxStorageBufferBindingSize` 2 GiB; a 3B checkpoint at q4 approaches that, and the failure mode
    is likely an opaque allocation error rather than a clear message. **Mitigation:** the registry
    carries sizes, and M10 checks adapter limits before attempting a load.
17. **`FakeModel` can drift from real model behaviour.** A loop that only ever sees well-formed
    scripted turns will not survive a real one. **Mitigation:** its scripts must include the failure
    modes M8 actually produced — a Pythonic call, an over-long output, a malformed block — and the
    manual WebGPU run stays part of each milestone's done-when.

### 10.9 Measured at M9–M11 (2026-08-05, this machine)

- **The chat loop is CI-testable, which was the whole design constraint.** `tests/e2e/chat.spec.ts`
  drives **14 cases against a real VM with a scripted model** and runs in the ordinary browser suite —
  no GPU, no opt-in. The browser suite went 16 → **30 cases**; unit tests went 108 → **230**. The
  GPU-only suite stayed a single case, which is the right ratio: everything that *can* be tested
  without a GPU now is.
- **`FakeModelClient` earns its place by replaying real failure modes**, not idealised ones: the
  Pythonic call LFM2 actually emits (filling in every optional argument), a malformed block, a
  command whose output blows the budget, a model that never stops calling, a refused write. Two bugs
  below were found by exactly those cases.
- **The budget belongs to the request, not to the arguments — found by the e2e suite, not the unit
  tests.** M9 applied its per-call cap by writing `max_output` into the model's argument object,
  which worked fine for `run_terminal_command` (where it is a real argument) and broke *every*
  template tool at M11, because a template declares its own parameters and rejects anything else.
  The fix moves the cap onto the compiled request, where it was always conceptually. This is a good
  argument for building the e2e path early: the unit tests on both sides were green and wrong.
- **A scripted fake needs turn boundaries, not message text.** `FakeModelClient` keyed its queue on
  the last user message, so sending the *same* prompt twice replayed an exhausted queue and silently
  produced the fallback answer. It now keys on the user-message count. Asking the same question
  twice is a legitimate thing for a test to do.
- **Prompt cost, measured rather than assumed:** `run_terminal_command` renders **2301 characters**
  of system prompt; the three built-in narrow tools render 500–800 bytes each. That is why exposure
  is opt-in and why `TestBuiltinTemplatePromptCost` fails a builtin over 1200 bytes. Whether narrow
  tools help a 1.2B model remains **unmeasured and open** (§10.7) — M11 shipped the mechanism and the
  cost, not a recommendation.
- **Generating the extension format needed nested structs in the reflector.** `objectSchema` had no
  struct case, since the wire types never nested. The addition stays strict: a nested type must be
  registered with hand-written descriptions rather than reflected blindly, so the rule that an
  undocumented field is a build failure now holds one level down too.
- **Two model families are wired, one is verified.** `lfm2` carries captured transcripts; `hermes`
  (Qwen) and `llama` are implemented from published templates and are marked `unverified` in the
  registry, surfaced in the UI when selected. The `llama` dialect deliberately refuses to treat
  arbitrary JSON as a call — a model quoting `{"some": "config"}` at the user must not become a
  command execution.
- **The real model still works through all of it, unchanged:** `make test-e2e-agent` passes with the
  same transcript as M8 (~9.5 s including load), now through the dialect registry, the multi-turn
  loop and the tool registry. The budget is visible in the request it sends: `max_output: 4096`.
