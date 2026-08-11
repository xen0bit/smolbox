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
