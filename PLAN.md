# smolbox — Implementation Plan

> Status: M0 (scaffolding) and M1 (wasm build) complete. M2 is next.
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
| Build targets | Both; **WASI primary**, emscripten `--to-js` secondary | One artifact runs under wazero *and* the browser; emscripten is faster but **cannot mount host directories** (§4.3) |
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
   Use `golangci/golangci-lint-action@v6` in CI instead.

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
guest/smolagentd/             # guest agent, static linux/amd64, baked into vm/Dockerfile
internal/protocol/            # wire types + framing, shared by host and guest
internal/vm/                  # wazero wiring, boot, session lifecycle
internal/hostfs/              # read-only mount provider interface + os-backed impl
web/
  serve.ts                    # dev server: Bun.serve with COOP/COEP headers
  src/
    worker.ts                 # wasm + WASI shim in a dedicated worker
    stdio.ts                  # stdio router: session decoder + optional terminal mirror
    session.ts                # TS twin of internal/vm session client
    mount.ts                  # directory provider (picker / OPFS / drag-drop)
    fsbridge/
      protocol.ts             # SAB layout, op codes
      worker-fd.ts            # Fd subclass, blocks on Atomics.wait
      main-host.ts            # main-thread async service
  index.html
tests/
  conformance/cases.json      # shared behaviour table, run by BOTH Go and browser drivers
  integration/                # Go, build tag `integration`
  e2e/                        # Playwright
testdata/mount/               # fixture directory used as the mounted folder
docs/tool-api.md              # tool-call surface for the future WebGPU LLM
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

**`internal/vm`** mirrors §2.2:

- `Boot(ctx, Options)` compiles `dist/smolbox.wasm`, wires an `io.Pipe` for stdin and a pipe for
  stdout, and calls `InstantiateModule` **in a goroutine** — it blocks for the life of the VM.
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

**2. The mounted directory is injected as `fds[3]`**, replacing upstream's `certDir` slot, with a
custom `Fd` backed by the sync bridge.

### 4.4 The sync FS bridge

```
worker thread (wasm, may block)        main thread (holds the DirectoryHandle)
  Fd.path_open(...)                      -- never blocks --
    encode req into SAB
    postMessage(wake)              ──►   onmessage: decode req
    Atomics.wait(state, REQ)             await handle.getFileHandle(...)
                              ◄──        write payload into SAB
    state == RESP → decode               Atomics.store(state, RESP); Atomics.notify
    return {ret, fd_obj}
```

- **SAB layout:** `[state:i32][errno:i32][reqLen:i32][respLen:i32][request bytes][payload window]`,
  payload window 1 MiB by default. Reads larger than the window are chunked by the worker into
  repeated `READ{path, offset, len}` ops.
- **Ops:** `STAT`, `READDIR`, `READ`, `READLINK`. Every write op (`path_create_directory`,
  `fd_pwrite`, `path_unlink_file`, `path_rename`, …) returns `wasi.ERRNO_ROFS` **without touching the
  bridge at all**.
- **The main thread never blocks** — `Atomics.wait` is forbidden there (§2.6). The worker signals via
  `postMessage` and *then* blocks; the main thread replies through the SAB and `Atomics.notify`.
  This is exactly the xterm-pty pattern, and the two blocking channels (tty, fs) are independent SABs
  serviced by the same non-blocking event loop.
- **Caching.** The mount is read-only, so the worker memoizes `STAT`/`READDIR` and keeps an LRU of
  content chunks; path→handle resolution is cached on the main thread. `remount()` clears both — that
  is the answer to "the user edited the folder".
- **Gotcha from §2.4:** c2w's guest traversal needs the directory to resolve `"."` to itself. Our `Fd`
  must handle `"."` and `".."` explicitly and reject `..` escapes above the mount root (see also the
  `WithReadOnlyDirMount` traversal caveat in §2.2).

**Testability.** `mount.ts` accepts anything structurally matching `FileSystemDirectoryHandle`.
Playwright cannot drive `showDirectoryPicker()`, but `navigator.storage.getDirectory()` (OPFS)
returns the same interface — so E2E tests populate an OPFS tree and mount that, exercising the
identical code path with no native dialog.

**Browser support.** Chromium-only for the picker. Firefox and Safari get a clearly-labelled degraded
path (drag-and-drop a folder, or OPFS) behind the same provider interface. The page must check
`crossOriginIsolated === true` at startup and fail with a readable message rather than a cryptic
`Atomics` error.

### 4.5 Tool-call surface for the future LLM (design only)

`internal/protocol` *is* the tool surface. Deliverables now, so WebGPU integration is a drop-in later:

- `docs/tool-api.md` plus a JSON Schema for `Request`/`Response`, **generated from the Go types** so
  they cannot drift.
- A `run_terminal_command` tool definition exported from both Go and TS, shaped for function calling.
- A mock caller in `tests/` that issues a scripted sequence of tool calls (list the mount, read a
  file, grep it, report) and asserts the transcript — proving the surface works without a model.

---

## 5. Makefile targets

| Target | Does |
|---|---|
| `vm-image` | `docker build -f vm/Dockerfile -t smolbox/vm:dev .` |
| `builder-image` | `docker build -f build/Dockerfile.c2w -t smolbox/c2w-builder:dev build/` |
| `wasm` | deps `vm-image builder-image` → `dist/smolbox.wasm` (WASI, primary) |
| `wasm-js` | same via `c2w --to-js` → `dist/js/` (emscripten, **no host mount**) |
| `build` | `go build ./cmd/smolbox` → `bin/smolbox` |
| `web` | bundle `web/src` with `bun build` → `web/dist`, copying `dist/smolbox.wasm` |
| `serve` | `bun web/serve.ts` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` |
| `test` | Go unit tests; no Docker required |
| `test-integration` | `go test -tags integration ./tests/integration/...`; requires `dist/smolbox.wasm` |
| `test-web` | `bun test` unit tests for the TS bridge |
| `test-e2e` | Playwright against `make serve` |
| `test-conformance` | drives `tests/conformance/cases.json` through both the Go and browser sessions |
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
| M2 | Guest agent + protocol + `internal/vm` session + CLI | `smolbox repl` works; Go integration matrix green |
| M3 | Read-only host mount under wazero | mount cases in the conformance table green |
| M4 | Browser worker, stdio router, TS session — **spike the preopen first** | Playwright boots the VM and runs `echo hello` |
| M5 | Sync FS bridge + browser mount | browser passes the **same** conformance table as Go |
| M6 | `make wasm-js` emscripten target | boots in browser; documented as no-mount |
| M7 | Tool-API docs, JSON Schema, mock caller | `make test-conformance` covers the tool surface |

---

## 7. Verification

**Shared conformance table (`tests/conformance/cases.json`)** is the core of the strategy: one
declarative list of `{name, request, expect}` cases, executed by a Go driver against wazero and by a
Playwright driver against the browser. Behaviour cannot silently diverge between runtimes.

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
interleaved kernel noise, reads split across buffer boundaries, oversized frames.
`internal/hostfs` provider conformance.

**TS unit tests** (`bun test`): SAB encode/decode; `HostDirFd` against a fake synchronous backend,
asserting every write op returns `ERRNO_ROFS`; chunked reads of a file larger than the payload
window; cache invalidation on `remount()`.

**Manual smoke:** `make wasm web serve`, open the page, pick a folder, `ls -la /mnt/host`.

**CI** (GitHub Actions): unit tests on every push (Go + bun via `oven-sh/setup-bun`); `make wasm` +
integration + e2e on a Docker-enabled runner, caching `dist/smolbox.wasm` keyed on the hashes of
`vm/Dockerfile`, `guest/`, and the c2w version.

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
   on this, so it must be the first browser task.
3. **Wasm artifact size.** **Measured 107.6 MiB for minimal Alpine + BusyBox tooling** (§1). Under the
   pain threshold; if delivery ever hurts, `c2w --external-bundle` mounts the image at runtime
   instead of embedding it.
4. **COOP/COEP required.** Non-negotiable for `SharedArrayBuffer`. `make serve` sets the headers;
   deployment docs must call it out; the page detects `crossOriginIsolated === false` and fails
   clearly.
5. **Emscripten target cannot mount host directories** (§2.7). Ships as a fast, explicitly no-mount
   fallback. Wiring virtio-9p through emscripten's FS is out of scope.
6. **c2w needs the host Docker socket** (§4.1). Documented in the Makefile and README.
7. **Node 18 is EOL — and unused.** All web tooling runs on bun. Playwright's runner at M4 is the
   only Node dependency; verify `bunx playwright` under bun, else pin a modern Node for e2e only.
8. **stdin EOF kills the VM.** The emulator exits 1 on any guest stdin read returning EOF
   (§2.11.2). Every host harness must keep stdin open for the VM's lifetime. This is why the session
   owns a persistent `os.Pipe`.
9. **c2w's embedded Dockerfile needs the `--assets` workaround** (§2.11.1, §4.1). The builder image
   bakes the pinned `container2wasm@v0.8.4` checkout and every `make wasm`/`wasm-js` passes
   `--assets /assets`.
