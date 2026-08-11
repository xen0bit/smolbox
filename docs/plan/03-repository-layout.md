## 3. Repository layout

```
Makefile
PLAN.md                       # index over docs/plan/ (this file is §3)
README.md                     # ideal end-state scope
package.json + bun.lock       # web deps (typescript, @types/bun) — bun manages these
vm/Dockerfile                 # (1) THE VM: minimal Alpine guest image
build/Dockerfile.c2w          # (2) BUILDS THE VM: c2w toolchain -> dist/smolbox.wasm
cmd/smolbox/                  # CLI: one-shot exec + interactive REPL
cmd/gen-tool-api/             # M7: writes docs/schema/*.json from the Go types (`make generate`)
guest/smolagentd/             # guest agent, static linux/amd64, baked into vm/Dockerfile
internal/protocol/            # wire types + framing, shared by host and guest
internal/vm/                  # wazero wiring, boot, session lifecycle
internal/hostfs/              # read-only mount provider interface + os-backed impl
internal/tool/                # M7: the model-facing tool surface over the exec API
  schema.go                   #   reflection -> JSON Schema, ordered properties
  tool.go                     #   definition, dialect adapters, DecodeArgs, Call, Render
  artifacts.go                #   the generated file set, shared by the generator and its test
web/
  serve.ts                    # dev server: Bun.serve with COOP/COEP headers; /models/ -> dist/models
  fetch-model.ts              # M8: pulls the pinned checkpoint into dist/models (`make model`)
  index.html                  # minimal page: boot/run UI + crossOriginIsolated check
  js.html                     # M6: the same UI for the emscripten build, served at /js/
  agent.html                  # M8: the WebGPU agent spike, served at /agent/
  src/
    agent/                    # M8: the model side (no GPU-free logic below this line)
      messages.ts             #   page <-> model-worker message contract
      model-worker.ts         #   transformers.js on WebGPU, its own dedicated worker
      parse.ts                #   tool-call parser: Pythonic AND JSON (28 unit tests)
      agent-main.ts           #   page entry: VM + model + the transcript; window.__smolagent
    emscripten/               # M6: the --to-js page (no worker, no fsbridge)
      js-main.ts              #   page entry: Module wiring + window.__smolbox
      protocol-pty.ts         #   Module['pty'] over the shared StdinChannel
    worker.ts                 # wasm + WASI shim in a dedicated worker (M4)
    main.ts                   # page entry: spins up the worker, exposes window.__smolbox
    protocol.ts               # TS twin of internal/protocol framing + types
    stdio.ts                  # stdio router: FrameDecoder + SAB stdin channel
    session.ts                # TS twin of internal/vm session client
    tool.ts                   # M7: TS twin of internal/tool (definition, adapters, renderResult)
    mount.ts                  # M5: mount providers (picker / OPFS) behind one interface
    fsbridge/                 # M5: SAB layout, worker Fd, main-thread async service
      protocol.ts             #   SAB layout + op codecs, shared by both ends
      worker-fd.ts            #   blocking Fd subclass (worker thread)
      main-host.ts            #   async service + all caching + virtual symlinks (main thread)
  tsconfig.json
tests/
  conformance/cases.json      # shared behaviour table, run by ALL THREE drivers (`requires` tags)
  conformance/toolcall_test.go # M7: the mock caller — a scripted tool-call transcript
  tool/render-cases.json      # M7: golden tool-result renderings, run by Go AND bun
  integration/                # Go, build tag `integration`
  e2e/                        # Playwright: boot + echo hello + OPFS mount + conformance drivers
    conformance.spec.ts       #   M5: the WASI page, all 14 cases
    emscripten.spec.ts        #   M6: the /js/ page, the 8 non-mount cases
    agent.spec.ts             #   M8: the agent spike; opt-in (SMOLBOX_WEBGPU=1), needs a GPU
testdata/mount/               # fixture directory used as the mounted folder
docs/tool-api.md              # M7: the tool-call surface, hand-written spec
docs/schema/                  # M7: GENERATED from the Go types — never hand-edit
dist/                         # build output (gitignored)
```
