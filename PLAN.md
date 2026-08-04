# smolbox — Implementation Plan

> Status: M0 (scaffolding), M1 (wasm build), M2 (guest agent + session + CLI), M3 (read-only host
> mount under wazero + shared conformance table), M4 (browser worker + stdio router + TS session,
> with the preopen spike), M5 (sync FS bridge + browser mount + browser conformance driver), and
> M6 (emscripten `--to-js` target) complete. M7 (tool-API docs, JSON Schema, mock caller) is next.
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
18. **`arg-module.js` always emits the netdev args, and that *is* upstream's no-network mode.** The
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
  index.html                  # minimal page: boot/run UI + crossOriginIsolated check
  js.html                     # M6: the same UI for the emscripten build, served at /js/
  src/
    emscripten/               # M6: the --to-js page (no worker, no fsbridge)
      js-main.ts              #   page entry: Module wiring + window.__smolbox
      protocol-pty.ts         #   Module['pty'] over the shared StdinChannel
    worker.ts                 # wasm + WASI shim in a dedicated worker (M4)
    main.ts                   # page entry: spins up the worker, exposes window.__smolbox
    protocol.ts               # TS twin of internal/protocol framing + types
    stdio.ts                  # stdio router: FrameDecoder + SAB stdin channel
    session.ts                # TS twin of internal/vm session client
    mount.ts                  # M5: mount providers (picker / OPFS) behind one interface
    fsbridge/                 # M5: SAB layout, worker Fd, main-thread async service
      protocol.ts             #   SAB layout + op codecs, shared by both ends
      worker-fd.ts            #   blocking Fd subclass (worker thread)
      main-host.ts            #   async service + all caching + virtual symlinks (main thread)
  tsconfig.json
tests/
  conformance/cases.json      # shared behaviour table, run by ALL THREE drivers (`requires` tags)
  integration/                # Go, build tag `integration`
  e2e/                        # Playwright: boot + echo hello + OPFS mount + conformance drivers
    conformance.spec.ts       #   M5: the WASI page, all 14 cases
    emscripten.spec.ts        #   M6: the /js/ page, the 8 non-mount cases
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
| `test-e2e-js` | Playwright against the `/js/` page: boot smoke + the non-mount conformance cases |
| `build` | `go build ./cmd/smolbox` → `bin/smolbox` |
| `web` | bundle `web/src/{worker,main}.ts` + copy `index.html` and `dist/smolbox.wasm` → `web/dist` |
| `serve` | `bun web/serve.ts` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` |
| `test` | Go unit tests; no Docker required |
| `test-integration` | `go test -tags integration ./tests/integration/...`; requires `dist/smolbox.wasm` |
| `test-web` | `bun test web/src` — protocol framing + session unit tests |
| `test-e2e` | Playwright (`make web` first) against `make serve` |
| `test-conformance` | runs `tests/conformance/cases.json` through the Go/wazero driver (browser driver **M5 done**) |
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
| M7 | Tool-API docs, JSON Schema, mock caller | `make test-conformance` covers the tool surface |

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
standalone unit test.

**TS unit tests** (`bun test`, **M4 + M5 done**): the TS framing twin (`protocol.ts`) round-trips
requests/ready/responses against the Go wire shape and skips noise; the SAB stdin channel and
`session.ts` against a mock worker (boot, seq'd exec dispatch, close, error paths); and the fsbridge
suite — SAB codec round-trips, `MountHost` dispatch against fake directory handles, every `BridgeFd`
write op returns `ERRNO_ROFS`, chunked reads larger than the payload window, `..` escapes →
`ERRNO_NOTCAPABLE`, and cache invalidation on `remount()`.

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
running `make test-e2e-js` — **M6 done**.

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
