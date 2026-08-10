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
    checkpoint (868 MB, against q4's 1.22 GB) for any run on this machine — headless *or* headed,
    Chromium *or* Chrome. §10.14 has the measurements and shows the gate is per-adapter inside Dawn,
    not a property of how the browser is launched.
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
