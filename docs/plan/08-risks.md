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
