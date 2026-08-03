# AGENTS.md — smolbox

Guidance for agent sessions working in this repo. Read PLAN.md for the design, research notes, and
milestone status; it is the source of truth and is kept current.

## What this is

A full x86_64 Linux VM that runs as a portable `.wasm` artifact. A minimal Alpine image is converted
with [container2wasm](https://github.com/container2wasm/container2wasm); the same `dist/smolbox.wasm`
runs under [wazero](https://wazero.io) (local CLI, tests) and later in a browser, mounting a host
directory read-only at `/mnt/host`. A future on-device LLM will drive it through a framed exec API.

Milestone status: **M0 (scaffolding), M1 (wasm build + wazero boot), M2 (guest agent + session +
CLI), M3 (read-only host mount under wazero + shared conformance table), and M4 (browser worker +
stdio router + TS session, preopen spike proven) done. M5 (sync FS bridge + browser mount) is
next.**

## Toolchain

- **Go 1.24.3** (pinned in `go.mod`; do not bump without updating PLAN.md). wazero is pinned to
  **v1.11.0** because v1.12+ requires go ≥ 1.25.
- **Docker 29.x** with the daemon socket at `/var/run/docker.sock` — required for `make wasm`.
- **bun 1.2.x** for all web tooling (bundle, `bun test`, `bunx --bun tsc`, dev server). Node is
  irrelevant; Playwright (M4) may need a Node pin — revisit then.
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
| `make test-integration` | boot `dist/smolbox.wasm` under wazero, session-lifecycle tests only |
| `make test-conformance` | run the shared `tests/conformance/cases.json` table through the wazero driver |
| `make build` | `bin/smolbox` CLI (`exec`, `repl`) |
| `make web` / `make serve` | bundle browser worker + page, copy `smolbox.wasm` + `index.html`; Bun dev server with COOP/COEP |
| `make test-web` | `bun test web/src` (protocol framing + session unit tests) |
| `make test-e2e` | Playwright: boots `dist/smolbox.wasm` in headless Chromium, `echo hello` + preopen spike (M4) |
| `make clean` | remove `dist/ bin/ web/dist/` |

Everything gate = `make lint test` then `make test-integration` + `make test-conformance` (both need
`dist/smolbox.wasm`).

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

### Browser poll_oneoff: convert every clock into one timeline
The base browser_wasi_shim `poll_oneoff` only handles a single clock subscription and busy-loops;
`web/src/worker.ts` replaces it entirely (the guest kernel polls fd 0 for console input, driven by
the emulator's `select(0)`). The shim's MONOTONIC clock is `performance.now()*1e6` but its REALTIME
clock is `Date.now()*1e6` — subtract a REALTIME deadline from `performance.now()` and you get a
~24.8-day `Atomics.wait` and a VM that boots forever. Normalise all deadlines to
`performance.now()` ms before waiting. (PLAN §2.11.11-12.)

### Testing
- `tests/integration/` and `tests/conformance/` are behind the `integration` build tag and require
  `dist/smolbox.wasm`. The integration suite is session-lifecycle only; all behaviour lives in the
  shared conformance table.
- `tests/conformance/cases.json` is the single declarative table: `{name, steps[{request,
  expect}]}` where `expect` is a partial `protocol.Response` matcher. The wazero driver (M3) runs it
  today; the browser driver (M5) must run the **same** file so behaviour cannot diverge. Each case
  boots a fresh session; ordered steps give stateful cases (timeout→orphan-check, cd persists).
- `tests/e2e/` (Playwright, M4) boots `dist/smolbox.wasm` in headless Chromium through the real
  worker + `window.__smolbox` hook: `echo hello` and the preopen spike (in-memory `/mnt/host`).
  Playwright runs under bun (`bunx --bun playwright test`); install browsers with
  `bunx --bun playwright install chromium`. The e2e suite is not in CI yet (M5).
- When adding a mount fixture to `testdata/mount/`, update the `ls -1` expectation in the table
  (busybox sorts alphabetically) or the fixture/table drift silently.

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
3. If the conformance table or a `testdata/` fixture changed: `make test-conformance` passes.
4. `gofmt`/`go vet` clean; `bunx --bun tsc --noEmit` clean.
5. Update PLAN.md (measurements, open questions, risks) and this file if the change affects them.
