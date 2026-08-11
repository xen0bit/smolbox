## 6. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Go module, layout, Makefile skeleton, CI | `make lint test` green — **done** |
| M1 | `vm/Dockerfile`, `build/Dockerfile.c2w`, `make wasm` | `dist/smolbox.wasm` exists; raw wazero runs `echo hello`; **artifact size and boot time measured and recorded in this file** — **done** (§1) |
| M2 | Guest agent + protocol + `internal/vm` session + CLI | `smolbox repl` works; Go integration matrix green | **done** (§1) |
| M3 | Read-only host mount under wazero + shared conformance table + Go driver | mount cases in the conformance table green — **done** (§1) |
| M4 | Browser worker, stdio router, TS session — **spike the preopen first** | Playwright boots the VM and runs `echo hello` | **done** (§1) |
| M5 | Sync FS bridge + browser mount | browser passes the **same** conformance table as Go — **done** (§1) |
| M6 | `make wasm-js` emscripten target | boots in browser; passes the non-mount conformance cases; documented as no-mount — **done** (§1), **removed 2026-08-10** (see below) |
| M7 | Tool-API docs, JSON Schema, mock caller | `make test-conformance` covers the tool surface — **done** (§1, §4.5) |

> **M6 was removed from the tree on 2026-08-10**, along with Antares and `/scan/` (§11). The
> `--to-js` build worked and passed the shared table, but it was a second runtime with no host
> mount — the feature this project exists for — kept alive by its own make target, its own Playwright
> config, its own CI job and its own timeout budgets. The findings it produced are still recorded
> here and in §2.11.15–2.11.16 (the `TTY.stream_ops.poll` block, the one-byte console, the quadratic
> `FrameDecoder` it exposed); the last of those fixed a bug in code the WASI build still uses.
