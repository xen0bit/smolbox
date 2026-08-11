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
RUN apk add --no-cache coreutils findutils grep ripgrep tree python3 \
 && cd /usr/lib/python3.12 \
 && rm -rf ensurepip lib2to3 pydoc_data idlelib turtledemo test */test */tests
COPY --from=agent /smolagentd /sbin/smolagentd
RUN mkdir -p /mnt/host
ENTRYPOINT ["/sbin/smolagentd"]
```

Tagged `smolbox/vm:dev`.

**What is in the image, and why each thing is.** `coreutils`/`findutils`/`grep` are the tools the
conformance table and the tool surface assume; `ripgrep` and `tree` are named by the Antares system
prompt (§11.1.16); `python3` is there so a model can do computation and parsing in one call instead
of a five-stage pipeline. Every package here is paid for by every visitor in wasm bytes — python3
alone moved `dist/smolbox.wasm` from 117.7 MB to 152.6 MB, which is more than its 22 MiB install
(§10.24) — so the bar for adding another one is what it saves a model from doing badly, not what it
would be nice to have. There is no `pip`: the guest has no network, so it could only install from
files already inside the VM.

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
