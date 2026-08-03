# AGENTS.md — smolbox

Guidance for agent sessions working in this repo. Read PLAN.md for the design, research notes, and
milestone status; it is the source of truth and is kept current.

## What this is

A full x86_64 Linux VM that runs as a portable `.wasm` artifact. A minimal Alpine image is converted
with [container2wasm](https://github.com/container2wasm/container2wasm); the same `dist/smolbox.wasm`
runs under [wazero](https://wazero.io) (local CLI, tests) and later in a browser, mounting a host
directory read-only at `/mnt/host`. A future on-device LLM will drive it through a framed exec API.

Milestone status: **M0 (scaffolding), M1 (wasm build + wazero boot), and M2 (guest agent + session +
CLI) done. M3 (read-only host mount under wazero, conformance table) is next.**

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
| `make test-integration` | boot `dist/smolbox.wasm` under wazero, run the framed protocol matrix |
| `make build` | `bin/smolbox` CLI (`exec`, `repl`) |
| `make web` / `make serve` | bundle browser worker + Bun dev server with COOP/COEP |
| `make clean` | remove `dist/ bin/ web/dist/` |

Everything gate = `make lint test` then `make test-integration` (needs `dist/smolbox.wasm`).

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

### Protocol framing
The exec API (`internal/protocol`) is line-oriented base64 with magic prefixes
(`#SMOLBOX-READY#`, `#SMOLBOX-REQ#seq#`, `#SMOLBOX-RES#seq#`); the Scanner discards lines without a
prefix (kernel noise). Guest and host share the same Go types, so the wire cannot drift. TS mirrors
it at M4+; docs say one definition, two runtimes.

### Testing
- `tests/integration/` is behind the `integration` build tag and requires `dist/smolbox.wasm`.
- The Go and browser drivers must execute the same `tests/conformance/cases.json` table (M3/M5) so
  behaviour cannot diverge between runtimes.

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
3. `gofmt`/`go vet` clean; `bunx --bun tsc --noEmit` clean.
4. Update PLAN.md (measurements, open questions, risks) and this file if the change affects them.
