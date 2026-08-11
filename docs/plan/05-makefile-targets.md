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
| `web` | bundle `web/src/{worker,main}.ts` and the agent entries → `web/dist`, and copy both pages plus `web/style.css` (the tokens, controls and terminal styling they share) |
| `serve` | `bun web/serve.ts` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; serves `smolbox.wasm`, `js/`, `models/` and `kernels/` from `DIST_DIR` (default `dist/`) |
| `generate` | `go run ./cmd/gen-tool-api` → rewrites `docs/schema/*.json` from the Go wire types |
| `test` | Go unit tests; no Docker required |
| `test-integration` | `go test -tags integration ./tests/integration/...`; requires `dist/smolbox.wasm` |
| `test-web` | `bun test web/src` — protocol framing + session unit tests |
| `test-e2e` | Playwright (`make web` first) against `make serve` |
| `test-conformance` | runs `tests/conformance/cases.json` through the Go/wazero driver **and the mock caller** (browser driver **M5 done**) |
| `lint` | `golangci-lint run` + `tsc --noEmit` |
| `clean` | remove `dist bin web/dist` |
| `all` | `build wasm web` |

`make wasm` fails with an actionable message if `/var/run/docker.sock` is absent.
