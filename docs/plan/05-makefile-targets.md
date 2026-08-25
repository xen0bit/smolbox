## 5. Makefile targets

| Target | Does |
|---|---|
| `vm-image` | `docker build -f vm/Dockerfile -t smolbox/vm:dev .` |
| `builder-image` | `docker build -f build/Dockerfile.c2w -t smolbox/c2w-builder:dev build/` |
| `wasm` | deps `vm-image builder-image` → `dist/smolbox.wasm` (WASI, primary) |
| `wasm-js` | same via `c2w --to-js` → `dist/js/` (emscripten, **no host mount**) |
| `test-e2e-js` | Playwright against the `/js/` page: boot smoke + the non-mount conformance cases |
| `model` | `bun web/fetch-model.ts` → pulls the pinned q4 checkpoint (1.22 GB) into `dist/models` |
| `test-e2e-agent` | Playwright against `/agent/`: the M8 spike. Opt-in, needs a GPU and `make model`; **not in CI** |
| `antares-onnx` | **M12.** `uv run tools/convert-antares.py` → converts the gated `fdtn-ai/antares-*` safetensors to ONNX in `dist/models`. Needs Python, `uv` and `HF_TOKEN`; the only target in this repo that needs any of the three (§11.2) |
| `test-e2e-antares` | **M13.** Playwright against `/scan/` with `FakeModelClient` replaying a captured Antares transcript — **in CI, no GPU** |
| `build` | `go build ./cmd/smolbox` → `bin/smolbox` |
| `web` | bundle `web/src/{worker,main}.ts` and the agent entries → `web/dist`, and copy both pages, `web/style.css` (the tokens, controls and terminal styling they share) and `web/coi-serviceworker.js`. Three build flags: `SMOLBOX_MODEL_SOURCE` (`hub`/`local`), `SMOLBOX_BASE` (the path prefix the site is served from, default `/`) and `SMOLBOX_WASM_BYTES` (measured from `dist/smolbox.wasm`, not set by hand) |
| `site` | `_site/` — the tree a static host publishes: `web/dist` plus `dist/smolbox.wasm` at the root, `.nojekyll`, no `.br`/`.gz`, no weights. Hub builds only; ~230 MB against a 1 GB GitHub Pages limit. Driven by `.github/workflows/pages.yml` |
| `serve` | `bun web/serve.ts` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; serves `smolbox.wasm`, `js/`, `models/` and `kernels/` from `DIST_DIR` (default `dist/`) |
| `generate` | `go run ./cmd/gen-tool-api` → rewrites `docs/schema/*.json` from the Go wire types |
| `test` | Go unit tests; no Docker required |
| `test-integration` | `go test -tags integration ./tests/integration/...`; requires `dist/smolbox.wasm` |
| `test-web` | `bun test web/src` — protocol framing + session unit tests |
| `test-e2e` | Playwright (`make web` first) against `make serve` |
| `test-conformance` | runs `tests/conformance/cases.json` through the Go/wazero driver **and the mock caller** (browser driver **M5 done**) |
| `lint` | `golangci-lint run` + `tsc --noEmit` |
| `clean` | remove `dist bin web/dist _site` |
| `all` | `build wasm web` |

`make wasm` fails with an actionable message if `/var/run/docker.sock` is absent.

### 5.1 Why the site is a build flag and not a server setting

Three things a deployment needs, none of which a server can supply once the artifacts exist.

**The base path.** `web/dist` is a static bundle and `make compress` writes `.br`/`.gz` variants
beside every file in it, so there is nothing left for a server to rewrite on the way past — a
rewritten page would invalidate both siblings. The prefix is therefore substituted at bundle time
(`--define SMOLBOX_BASE`), read through `web/src/base.ts`, exactly as `SMOLBOX_MODEL_SOURCE` is.
Every asset the pages fetch by path goes through `asset()`; `web/src/worker.ts` is the one exception
and needs no flag, because a worker resolves a bare URL against its own script and `worker.js` sits
beside `smolbox.wasm` wherever the root is.

**The size of `smolbox.wasm`.** The download bar needs the size of the *decoded* bytes, which is what
a `fetch()` reader yields. `web/serve.ts` sends it as `X-Uncompressed-Length` whenever it serves an
encoded variant; GitHub Pages gzips the artifact and sends no such header, and nothing in the browser
can recover the number — `Accept-Encoding` is a forbidden header name, and a Range request there is
answered against the compressed representation. So `make web` measures the file and substitutes it
(`--define SMOLBOX_WASM_BYTES`), read through `web/src/wasm-size.ts`. It is the fallback, never the
first answer: `downloadTotal()` prefers either header, because the flag is the only source that can
be stale. Building with no wasm on disk sets it to 0, which is the indeterminate bar the page already
knew how to render — the target says so rather than failing. See §10.26.

**Cross-origin isolation.** GitHub Pages sends no COOP/COEP and offers no way to add them, so
`SharedArrayBuffer` — the terminal, the FS bridge, onnxruntime's threaded builds — is unavailable and
both pages fail closed. `web/coi-serviceworker.js` adds the two headers from a service worker, which
costs one reload on a first visit and nothing after. It ships in every build and registers only when
`crossOriginIsolated` is already false, so `make serve` and the container image never see it;
`tests/e2e/coi.spec.ts` pins that.

Verified end to end before the workflow was written, by serving `_site` under `/smolbox/` from a
host sending no isolation headers: both pages reached `crossOriginIsolated === true` through the
worker, `smolbox.wasm` loaded from the prefix, and the guest booted (`uname -a` → `Linux localhost
6.1.0 … x86_64 GNU/Linux`) with no 404s.
