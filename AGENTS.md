# AGENTS.md — smolbox

Guidance for agent sessions working in this repo. Read PLAN.md for the design, research notes, and
milestone status; it is the source of truth and is kept current.

## What this is

A full x86_64 Linux VM that runs as a portable `.wasm` artifact. A minimal Alpine image is converted
with [container2wasm](https://github.com/container2wasm/container2wasm); the same `dist/smolbox.wasm`
runs under [wazero](https://wazero.io) (local CLI, tests) and later in a browser, mounting a host
directory read-only at `/mnt/host`. An on-device LLM on WebGPU drives it through a framed exec API
(M8 proves the round trip; see `web/src/agent/`).

Milestone status: **M0 (scaffolding), M1 (wasm build + wazero boot), M2 (guest agent + session +
CLI), M3 (read-only host mount under wazero + shared conformance table), M4 (browser worker +
stdio router + TS session, preopen spike proven), M5 (sync FS bridge + browser mount + browser
conformance driver), M6 (emscripten `--to-js` target + its conformance driver), and M7 (tool-API
docs, generated JSON Schema, mock caller) done — every milestone in PLAN §6 is complete.**
Component 2 has started: **M8 (the WebGPU tool-call spike) is done** — a local LFM2 model on WebGPU
drives a real VM through the M7 tool surface, which needed **no changes** to serve it (PLAN §9).
M9+ (multi-turn, chat UI) is not designed yet.

## Toolchain

- **Go 1.24.3** (pinned in `go.mod`; do not bump without updating PLAN.md). wazero is pinned to
  **v1.11.0** because v1.12+ requires go ≥ 1.25. A newer local toolchain is fine — go1.26.5 builds
  the pinned module clean — but the `go.mod` directive and CI's pin are what decide.
- **Docker 29.x** with the daemon socket at `/var/run/docker.sock` — required for `make wasm`.
- **bun 1.2.x or newer** (1.3.14 verified) for all web tooling (bundle, `bun test`, `bunx --bun tsc`, dev server). Node is
  irrelevant; Playwright's runner works under bun (`bunx --bun playwright test`), so no Node pin
  (risk 7, resolved at M4).
- **golangci-lint v2** (`~/.golangci.yml` uses the v2 schema). In CI it is installed via
  `golangci/golangci-lint-action@v7`, **not** golangci's `install.sh`: that script's checksum grep
  also matches the release `*.tar.gz.sbom.json` line and always fails for v2.x releases. (v6 of the
  action rejects golangci-lint v2 outright; v7+ is required.)

## Commands

| Command | Purpose |
|---|---|
| `make lint` | golangci-lint (v2) + `bunx --bun tsc --noEmit` |
| `make test` | Go unit tests (no Docker) |
| `make vm-image` | build guest image `smolbox/vm:dev` from `vm/Dockerfile` |
| `make builder-image` | build `smolbox/c2w-builder:dev` from `build/Dockerfile.c2w` |
| `make wasm` | convert the guest to `dist/smolbox.wasm` (needs Docker) |
| `make wasm-js` | convert the guest to `dist/js/` via `c2w --to-js` (emscripten/QEMU, **no host mount**) |
| `make test-integration` | boot `dist/smolbox.wasm` under wazero, session-lifecycle tests only |
| `make test-conformance` | run the shared `tests/conformance/cases.json` table through the wazero driver, **plus the mock caller** (M7) |
| `make generate` | rewrite `docs/schema/*.json` from the Go wire types — the only sanctioned way to change them |
| `make build` | `bin/smolbox` CLI (`exec`, `repl`) |
| `make web` / `make serve` | bundle browser worker + page, copy `smolbox.wasm` + `index.html`; Bun dev server with COOP/COEP |
| `make test-web` | `bun test web/src` (protocol + session + fsbridge + tool-surface unit tests) |
| `make test-e2e` | Playwright: boots `dist/smolbox.wasm` in headless Chromium — `echo hello`, OPFS mount smoke, and the full conformance table (M5) |
| `make test-e2e-js` | Playwright: boots `dist/js` at `/js/` — boot smoke, the no-mount guard, and the non-mount conformance cases (M6) |
| `make model` | pull the pinned LFM2 checkpoint (1.22 GB) into `dist/models` — needed by the agent page (M8) |
| `make test-e2e-agent` | Playwright: the M8 agent spike at `/agent/`. **Opt-in** (`SMOLBOX_WEBGPU=1`), needs a real GPU and `make model`; **never runs in CI** |
| `make clean` | remove `dist/ bin/ web/dist/` |

Everything gate = `make lint test` then `make test-integration` + `make test-conformance` (both need
`dist/smolbox.wasm`). M5 also gates `make test-web` + `make test-e2e`; M6 adds `make test-e2e-js`
(needs `dist/js`). M8's `make test-e2e-agent` is **not** part of the gate — it needs a GPU and
1.22 GB of weights, so run it by hand when touching `web/src/agent/`.

## How the VM is built (the two Dockerfiles)

1. `vm/Dockerfile` — **the VM**: builds `guest/smolagentd` (Go, static linux/amd64) and layers it on
   pinned `alpine:3.21` with coreutils/findutils/grep. Entrypoint is `/sbin/smolagentd` (M2+); M1
   used `/bin/sh` for harness debugging.
2. `build/Dockerfile.c2w` — **builds** the VM: installs docker CLI + buildx + the pinned c2w release
   (checksum-verified). It also clones `container2wasm/container2wasm@v0.8.4` to `/assets`.
3. `make wasm` runs `c2w --assets /assets smolbox/vm:dev /out/smolbox.wasm` against the host daemon.

**Gotcha:** c2w v0.8.4's embedded Dockerfile clones a nonexistent `ktock/container2wasm -b v0.8.4`
branch; the `--assets /assets` named context shadows that broken stage. Never drop the flag.

Rebuilds are cached by BuildKit; editing `guest/` alone makes `make wasm` cheap.

## Patterns & hard-won rules

### The session stdin must never EOF (critical)
The emulator (`bochs/wasm.cc`) calls `exit(1)` the instant the guest reads stdin and hits EOF.
Keep stdin as a persistent `os.Pipe` whose write end stays open for the VM's lifetime (see
`internal/vm/vm.go`). Never use an `io.Pipe` reader for stdin — wazero's nonblocking
path mishandles it. End the session with the `shutdown` op (`Session.Close`), not by closing stdin;
closing stdin is only the forced-termination fallback.

### The read-only mount is enforced at the host FS boundary
`internal/vm` mounts with `wazero.WithReadOnlyDirMount(host, "/mnt/host")`; the browser uses an
`ERRNO_ROFS`-returning `Fd`. Writes surface in the guest as `can't create ...: Invalid argument`.
Do not rely on guest-side `mount -o ro`.

### Guest `..` above the mount root resolves inside the guest, never to the host
The wazero `WithReadOnlyDirMount` doc warns it does not by itself prevent `../` traversal. In
smolbox that caveat is neutralised by the guest kernel: `..` above the `/mnt/host` bind mount is
resolved by the guest's VFS before any 9p request reaches wazero, so a host file sitting next to the
mounted dir stays invisible (the conformance table asserts `cat /mnt/host/../secret.txt` fails
without leaking its sentinel). Do not weaken the black-box traversal case if the emulator ever
changes this.

### Protocol framing
The exec API (`internal/protocol`) is line-oriented base64 with magic prefixes
(`#SMOLBOX-READY#`, `#SMOLBOX-REQ#seq#`, `#SMOLBOX-RES#seq#`); the Scanner discards lines without a
prefix (kernel noise). Guest and host share the same Go types, so the wire cannot drift. TS mirrors
it at M4+; docs say one definition, two runtimes.

### The browser worker cannot receive postMessage while the VM runs
`wasi.start()` blocks the worker thread for the VM's lifetime, so REQ frames cannot be delivered by
message. The worker hands the main thread a `SharedArrayBuffer` stdin channel at startup
(`web/src/stdio.ts` `StdinChannel`) and the main thread writes whole REQ frames straight into it;
the emulator's `fd_read` consumes them and `Atomics.wait` lets the worker sleep on an empty queue.
Responses come back over postMessage, raised inside the worker's `fd_write`. This is the stdin half
of the M5 fsbridge.

### The sync FS bridge: all caching and the handle live on the main thread
The mount (`web/src/fsbridge/`) is a second SAB (`{type:"fschannel"}` + `{type:"fsreq"}`), the same
shape as stdin but two-way: the worker's `BridgeFd` encodes a request, posts a wake, and blocks on
`Atomics.wait`; the main thread's `MountHost` performs the async `FileSystemDirectoryHandle` reads
and replies via `Atomics.notify`. **All caching (memoized STAT/READDIR, chunk LRU, path→handle map)
and the handle itself live in `MountHost` on the main thread** — the worker cannot receive
postMessage mid-run, so worker-side cache invalidation on `remount()` is impossible without an epoch
dance. `remount()` is a main-thread-only cache clear; the VM boots with an empty mount until the
page calls `setMount(handle, links)`. (PLAN §4.4.)

### The bridge's virtual symlink table
The File System Access API has no symlink concept, so `MountHost` keeps a path→target table checked
before the directory handle, and the worker's readdir/stat report `FILETYPE_SYMBOLIC_LINK`. The e2e
fixture derives it from `testdata/mount`'s real symlink, keeping the single-conformance-table
invariant. When adding a symlink to the fixture, the browser must see it via this table, not OPFS.

### TextDecoder/TextEncoder throw on SharedArrayBuffer views
Chromium rejects decoding a `Uint8Array` whose buffer is a `SharedArrayBuffer` ("...must not be
shared"). The fsbridge `.slice()`s request/response bytes out of the SAB before decoding on **both**
ends (PLAN §2.11.13); the READ payload window is copied with `TypedArray.prototype.slice`, which
already allocates a non-shared buffer.

### The emscripten (`--to-js`) page: everything is on the main thread
`web/js.html` + `web/src/emscripten/` is a second page at `/js/` sharing the whole protocol stack
(`protocol.ts`, `stdio.ts`, `session.ts`) and differing only in the console transport. QEMU's
`main()` runs on a pthread, but every PTY-touching syscall is in `out.js`'s `proxiedFunctionTable`,
so `Module['pty']` (`ProtocolPty`) is called on the page — which is why `js-main.ts` can hold the
`Session` directly and feed it a fake `MessageSink` instead of a worker. Host → guest still goes
through the same `StdinChannel`; `StdinChannel.onWrite` fires `ProtocolPty.notifyInput()` to wake
the runtime's pending `onReadable`, and `onReadable` fires immediately via `queueMicrotask` when
data is already buffered (the lost-wakeup guard). No fsbridge: this target is no-mount.

### The emscripten `TTY.stream_ops.poll` override is mandatory, not cosmetic
c2w's `out.js` ships a PTY-aware `TTY`, so it looks like it needs no patching — but its `poll`
calls `PTY_askToWaitAgain` whenever the pty has no input, and the enclosing `PTY_wrapPoll` parks the
QEMU pthread on `Atomics.wait` until somebody types. With a programmatic console nobody ever does,
so the VM produces **zero output** and looks dead. `js-main.ts` replaces it in `preRun` with the
same mask minus the block — `(pty.readable ? 1 : 0) | (pty.writable ? 4 : 0)`; keeping POLLOUT is a
deliberate improvement on upstream's `1 : 0`. **Leave `TTY.stream_ops.read` blocking**: that is what
suspends `fd_read` between exec calls. (PLAN §2.11.15.)

### The emscripten console delivers one byte at a time
QEMU's emulated 16550 UART writes a single byte per `fd_write`, each a `proxyToMainThread` hop.
That caps console throughput at ~35 kB/s (the WASI build does ~345 kB/s) and it is structural — do
not chase it. It also means **any console-side buffer must be amortized O(1) per byte**: this is
what exposed the quadratic `FrameDecoder` (rebuffering *and* rescanning the pending line on every
chunk), which turned a 1 MiB response into a >300 s hang. (PLAN §2.11.16.)

### The emscripten build has no clean teardown
c2w's init runs `poweroff -f`, but the kernel is booted with `acpi=off`, so the guest cannot power
the machine off and QEMU keeps emulating a halted CPU. `Module['onExit']` never fires (verified past
90 s), and the command line is baked into the restored `vm.state` snapshot, so it cannot be changed.
`js-main.ts` therefore does not call `Session.close()`: it sends `shutdown` as a plain request and
treats the reply as the end of the session. Do not "fix" this by extending the close timeout.
Relatedly, the generated `arg-module.js` always emits `-netdev socket,connect=127.0.0.1:8888`, so
the page logs a failed WebSocket at boot — that is upstream's no-network mode (the socket is only
used when `Module['websocket'].url` is set, which smolbox never does). Cosmetic; leave it.

### Browser poll_oneoff: never let a wait go unbounded
`waitMs` is only ever shrunk by a *clock* subscription, so a guest poll carrying only fd-read
subscriptions has nothing to bound it. Sleeping until stdin arrives is fatal during boot — the host
does not write until the ready banner says the guest is up, so nothing can wake it and the VM hangs
forever. `MAX_POLL_MS` is therefore **250 ms**, not `2**31 - 1`: an un-clocked poll becomes a slow
re-poll, and the normal path is unaffected because a clock subscription already bounds it far below.
Do not raise it back for "efficiency". (PLAN §2.11.19.)

### Boot hangs are self-diagnosing; keep them that way
`wasi.start()` blocks the worker, so no timer can fire there — the WASI boot watchdog rides the
`poll_oneoff` loop and posts a stall report every 5 s after 20 s without a banner. **Silence in
those reports is the signal**: it means `poll_oneoff` stopped returning and the worker is parked.
The emscripten page uses a plain `setInterval` (its main thread is free); `writes=0` there means the
guest never reached its first serial write, i.e. a regressed TTY poll override. `tests/e2e/harness.ts`
appends the last 40 console lines to any boot failure so CI logs carry the evidence. If you touch
the poll or console paths, keep these reports working — a boot hang that reproduces only on CI is
otherwise close to undebuggable. (PLAN §2.11.20.)

### Browser poll_oneoff: convert every clock into one timeline
The base browser_wasi_shim `poll_oneoff` only handles a single clock subscription and busy-loops;
`web/src/worker.ts` replaces it entirely (the guest kernel polls fd 0 for console input, driven by
the emulator's `select(0)`). The shim's MONOTONIC clock is `performance.now()*1e6` but its REALTIME
clock is `Date.now()*1e6` — subtract a REALTIME deadline from `performance.now()` and you get a
~24.8-day `Atomics.wait` and a VM that boots forever. Normalise all deadlines to
`performance.now()` ms before waiting. (PLAN §2.11.11-12.)

### The tool surface: schemas are derived, never written
`internal/tool` is the model-facing view of `internal/protocol`. `docs/schema/*.json` is **generated**
— reflection over the wire structs, run by `make generate`. Never hand-edit those files;
`TestArtifactsAreCurrent` fails under `make test` the moment they drift.

The one thing that *is* hand-written is the field descriptions, and they live in `internal/tool`
rather than as doc comments on `protocol.Request`/`Response`: they are prompt text a model reads, not
Go documentation. **A wire field with no description is a hard failure** (`objectSchema` errors, and
because the schemas are package-level vars it panics at init) — that is deliberate, and it is what
stops the model-facing surface from quietly growing when someone adds a field. Add the field, add the
description, run `make generate`.

`web/src/tool.ts` is a hand-written twin like `protocol.ts`, held to the Go original by
`tool.test.ts` deep-equalling the generated JSON. Change one side, run both suites.

### The model never chooses the op
The tool's input schema is `protocol.Request` **minus `op`**, and `DecodeArgs` rejects any argument
object that sets one (`ErrOpNotAllowed`), before the session is touched. `run_terminal_command` is
the exec surface and nothing else — a model must not be able to talk its own sandbox into `shutdown`
by naming it in an argument object. Unknown fields are rejected too, so a hallucinated argument comes
back as a correctable error rather than a silently dropped flag. If you widen the tool surface, keep
both guards and extend the negative tests in `tool_test.go`, `tool.test.ts`, and the mock caller.

### Render() omits duration_ms on purpose
The mock caller asserts rendered results **verbatim**, so anything wall-clock in the rendering would
make every transcript unstable. `Call` hands back the raw `*protocol.Response` alongside the text for
hosts that want the timing. The exact format is pinned by `tests/tool/render-cases.json`, which the
Go and bun suites both run — the same shared-table trick as the conformance table, one level up. Add
a rendering rule there first, then implement it twice.

### The agent (M8): the model speaks Pythonic, not JSON
LFM2 emits `[run_terminal_command(cmd="ls", stdin=None)]`, **not** JSON — and no system-prompt
wording changes that. Five were measured, including the exact "Output function calls as JSON" line
from Liquid's docs; four produced correct Pythonic calls and the fifth only produced JSON because
dropping the sandbox context made the model hallucinate instead of calling anything. So
`web/src/agent/parse.ts` parses **both** syntaxes. Do not "fix" this by rewording the prompt — that
was tried. Two details the parser earns its keep on: Python `None` means *not provided* and must be
dropped rather than passed through as `null` (`decodeArgs` would reject it), and the whole thing is
pure and unit-tested because it is the only part of the agent CI can run. (PLAN §9.2, §1 M8.)

### The agent's prompt is the generated tool schema, unmodified
`apply_chat_template(messages, { tools: [openaiTool()] })` renders the `<|tool_list_start|>` wrapping
itself and serialises the tool objects verbatim, and it wraps the `tool` role in
`<|tool_response_start|>` on the way back — so `renderResult`'s M7 output feeds straight in. There is
no hand-formatted prompt text and there should not be: the schema is the anti-drift-guarded artifact,
and hand-copying it into a prompt string would be the drift the M7 gates exist to prevent.

### The agent has no CI and cannot have one
Headless Chromium gives **no** WebGPU adapter without `--use-angle=vulkan --enable-features=Vulkan`,
and `--enable-unsafe-swiftshader` provides no software fallback at all — a GPU-less runner cannot run
this at any speed. `make test-e2e-agent` is opt-in behind `SMOLBOX_WEBGPU=1` and is deliberately
absent from CI. The mitigation is structural: **keep agent logic GPU-free wherever it can be.** The
parser has 28 unit tests in `make test-web`; that is where the bugs were. Also note `navigator.gpu`
is undefined outside a secure context, so any probe must run against localhost, not `about:blank`.
(PLAN §2.11.24.)

### Model weights: `make model`, and don't let the browser cache them
`make model` pulls a **pinned revision** into `dist/models` (gitignored, 1.22 GB); `web/serve.ts`
serves it at `/models/` without copying it into `web/dist`. The page prefers local and falls back to
the HF CDN. Two traps: Cache Storage cannot hold a 1.2 GB entry (the `put` fails with an opaque
internal error), so `env.useBrowserCache = false` on the local path; and onnxruntime-web picks its
wasm variant at runtime — this version wants `ort-wasm-simd-threaded.asyncify.*`, not `.jsep` — so
`make web` copies **every** variant. A missing one surfaces as "no available backend found", not a
404. (PLAN §2.11.25-26.)

### Testing
- `tests/integration/` and `tests/conformance/` are behind the `integration` build tag and require
  `dist/smolbox.wasm`. The integration suite is session-lifecycle only; all behaviour lives in the
  shared conformance table.
- `tests/conformance/cases.json` is the single declarative table: `{name, requires?, steps[{request,
  expect}]}` where `expect` is a partial `protocol.Response` matcher. Three drivers run it: wazero
  (M3), the WASI browser page (M5), and the emscripten page (M6) — the **same** file, so behaviour
  cannot diverge. Each case boots a fresh session; ordered steps give stateful cases
  (timeout→orphan-check, cd persists).
- `requires` names the capabilities a case needs. Today the only tag is `["mount"]`, on the 6 cases
  that touch `/mnt/host`; the emscripten driver filters them out because that build has no host
  mount, while the other two drivers run everything. The Go driver ignores the field (unknown JSON
  key), so tagging a case can never weaken the wazero run. **Do not add a tag to dodge a failure** —
  a tag says "this runtime cannot express this", not "this is flaky here".
- `tests/e2e/` (Playwright, M4/M5) boots `dist/smolbox.wasm` in headless Chromium through the real
  worker + `window.__smolbox` hook: `echo hello`, an OPFS mount smoke, and the full conformance
  table (`conformance.spec.ts`). The mount is an OPFS tree walked from `testdata/mount` on the Node
  side (`tests/e2e/harness.ts` `walkFixture`), with the fixture's symlink registered as a virtual
  link. Playwright runs under bun (`bunx --bun playwright test`); install browsers with
  `bunx --bun playwright install chromium`. `test-e2e` is in CI (M5).
- `tests/e2e/agent.spec.ts` (M8) drives `/agent/` from `playwright.agent.config.ts`, which is the
  only config carrying the WebGPU launch flags. It is skipped unless `SMOLBOX_WEBGPU=1`, and both
  other configs exclude it (the WASI config by `testIgnore`, the emscripten one by `testMatch`).
  It asserts the *mechanism* — a parseable call for the one tool that exists, reaching a real
  session, with the mount's real contents in the rendered result — not the model's prose, which is
  not stable enough to assert.
- `tests/e2e/harness.ts` `installMount(page, fixture, hook)` is shared by the VM page and the agent
  page, so both mount through the identical bridge and virtual-symlink path. Take the hook name as a
  parameter rather than forking it.
- `tests/e2e/emscripten.spec.ts` (M6) drives the `/js/` page through `bootJs()` and needs `dist/js`,
  not `dist/smolbox.wasm`. It has **its own config** (`playwright.emscripten.config.ts`) and the
  WASI config `testIgnore`s it, so `make test-e2e` stays runnable without an emscripten build.
  Adding a spec that needs one artifact but not the other means touching both configs.
- That suite runs on **its own budgets and one retry**: `EMSCRIPTEN_BOOT_TIMEOUT_MS` (360 s) and
  `EMSCRIPTEN_EXEC_TIMEOUT_MS` (300 s), because a live VM here burns **~2.4 CPU cores** (the main
  loop busy-polls and QEMU never exits) against a 4-vCPU shared runner, and the console is ~10×
  slower. Boots take 16–22 s there against ~7 s locally, and the 1 MiB case ~3 min against ~48 s.
  If a case legitimately needs longer *on this runtime*, raise the budget — do **not** tag it out of
  the shared table. Context teardown is clean (CPU back to ~3 % within 3 s), so don't go hunting for
  leaked workers; that was checked.
- When adding a mount fixture to `testdata/mount/`, update the `ls -1` expectation in the table
  (busybox sorts alphabetically) or the fixture/table drift silently. **The mock caller's first step
  asserts that same listing verbatim**, so a new fixture means editing `toolcall_test.go` too.
- `tests/conformance/toolcall_test.go` (M7) is the mock caller: one continuous session of 12 scripted
  tool calls with every rendering asserted verbatim. It stands in for the model that does not exist
  yet. Keep it a *transcript* — ordered, stateful, and exact — rather than a set of independent
  assertions; the ordering is half of what it proves.

### Conventions
- **Do not add comments to code unless asked.** One-line doc comments on exported Go identifiers are
  fine.
- Keep `PLAN.md` and this file current when you learn something (measurements, gotchas, decisions).
- Pin external tools/images; when a new dep drags the go directive up, prefer the older version that
  matches `go 1.24.3` (see wazero v1.11.0).
- `dist/`, `bin/`, `web/dist/` are gitignored build output.

## Verify before committing
1. `make lint test` green (M0 gate).
2. If the VM or guest changed: `make wasm` succeeds and `make test-integration` passes.
3. If the conformance table or a `testdata/` fixture changed: `make test-conformance` passes (it also
   runs the mock caller).
4. If `internal/protocol` or `internal/tool` changed: `make generate`, then `make test test-web` —
   the generated schemas, the TS twin, and the docs tables all have drift gates.
5. If `web/src/agent/` changed: `make test-web` covers the parser; run `make test-e2e-agent` by hand
   (needs a GPU + `make model`) — CI cannot, so an untested agent change ships untested.
6. If the web runtime changed: `make test-web` and, with `dist/smolbox.wasm` present, `make test-e2e`
   (the browser must still pass the same conformance table as Go). If shared code under `web/src/`
   changed, also run `make test-e2e-js` with `dist/js` present — the emscripten page reuses
   `protocol.ts`, `stdio.ts` and `session.ts` verbatim.
7. `gofmt`/`go vet` clean; `bunx --bun tsc --noEmit` clean.
8. Update PLAN.md (measurements, open questions, risks) and this file if the change affects them.
