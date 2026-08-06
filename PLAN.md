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
   File System Access API (`showDirectoryPicker`), or, where that does not exist, an equivalent
   handle rebuilt from an `<input type="file" webkitdirectory>` pick (§4.4).
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
  The picker has a cross-browser substitute (`<input type="file" webkitdirectory>`, §4.4), but it
  hands back `File` objects, which are just as async — the bridge is mandatory either way.
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
with no native dialog. The `<input webkitdirectory>` picker *can* be driven (Playwright's
`filechooser` event takes a directory path), which is what lets the Firefox suite mount
`testdata/mount` through the real dialog instead of a hook.

**Browser support.** `showDirectoryPicker()` is Chromium-only, but folder mounting is not: browsers
without it pick through `<input type="file" webkitdirectory>` (supported by every current engine
despite the prefix), and `web/src/mount-tree.ts` rebuilds the flat `FileList` — whose entries carry
`webkitRelativePath` — into the same structural directory handle the bridge already consumes. Both
paths sit behind `pickDirectoryHandle()`, so `MountHost`, the worker, and the guest see no
difference. Two things the fallback cannot do: the tree is enumerated at pick time rather than
lazily (file *contents* are still lazy — a `File` is a `Blob` over the real file), and it cannot
report empty directories or symlinks. `tests/e2e/mount-picker.spec.ts` runs that path in Firefox
against a real VM (`make test-e2e-firefox`). The page must check `crossOriginIsolated === true` at
startup and fail with a readable message rather than a cryptic `Atomics` error.

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
| `antares-onnx` | **M12.** `uv run tools/convert-antares.py` → converts the gated `fdtn-ai/antares-*` safetensors to ONNX in `dist/models`. Needs Python, `uv` and `HF_TOKEN`; the only target in this repo that needs any of the three (§11.2) |
| `test-e2e-antares` | **M13.** Playwright against `/scan/` with `FakeModelClient` replaying a captured Antares transcript — **in CI, no GPU** |
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
  the page says so in 1.5 s instead of downloading 2.1 GB and failing nine frames deep. Headless
  Chromium does **not** expose `shader-f16` even on a real NVIDIA adapter (confirmed here: vendor
  `nvidia`, architecture `lovelace`, `shader-f16: false` at every `powerPreference`), so this entry
  is unverifiable in this environment by construction — PLAN §2.11.24 again.
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

### 10.12 Gemma 4: the ONNX path, surveyed and not taken

The reference given was `webml-community/gemma-4-webgpu-kernels`, which turns out **not** to be a
path this project should follow: it is a static Space carrying a hand-written WebGPU engine (147
`.wgsl` references, its own `createComputePipeline` calls) driving
`google/gemma-4-E2B-it-qat-mobile-transformers` — safetensors, no ONNX. Adopting it would mean a
second inference backend.

**This section records the alternative, which was surveyed first and then not taken** — §10.13 is
what shipped. Kept because the obstacles below are real and three of them had to be solved anyway.

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
`/models/`. If the licensing is ever clarified this becomes a one-line change.

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
the QAT checkpoint's tensors are f16. Headless Chromium exposes no `shader-f16`
on **any** adapter or behind **any** flag — four combinations were tried
(`--use-angle=vulkan --enable-features=Vulkan`, `--enable-unsafe-webgpu`,
`VulkanFromANGLE`, `--enable-dawn-features=allow_unsafe_apis`); the real NVIDIA
adapter reports 18 features and f16 is not among them, and `--enable-unsafe-webgpu`
alone drops to the fallback adapter. PLAN §2.11.24 again, and the same wall Qwen3
hit in §10.11.

So the entry declares `requiresFeatures: ["shader-f16"]` and the page refuses
**before fetching anything** — 2.5 GB and 7.4 s became an instant, accurate
message. On a desktop browser with a recent GPU this should run; that has not
been observed here and the dialect stays `verified: false` until a transcript
exists. What *is* tested in CI is the half this project wrote:
`gemma-kernels.test.ts` covers the prefix-cache reuse, the reset rules,
cancellation and the token budget against a fake engine, and
`gemma4.test.ts` pins the call grammar to the checkpoint's own rendered template.

---

## 11. Component 2, continued: Antares as a supported model (M12–M14)

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
