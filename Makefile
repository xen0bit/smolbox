SHELL := /bin/bash

BIN         := bin
DIST        := dist
WASM        := $(DIST)/smolbox.wasm
DOCKER_SOCK := /var/run/docker.sock

VM_IMAGE  := smolbox/vm:dev
C2W_IMAGE := smolbox/c2w-builder:dev
C2W_VERSION ?= 0.8.4

.PHONY: all build wasm wasm-js vm-image builder-image require-docker web serve generate model gemma-kernels \
        test test-integration test-web test-e2e test-e2e-js test-e2e-firefox test-e2e-agent \
        test-conformance lint clean

# c2w runs as root in the container, so everything it writes to dist/ lands
# root-owned — and then a later `mkdir dist/js` fails with EPERM for the user who
# ran make. Fixing this by running the converter as --user does NOT work: with no
# passwd entry for the uid, $HOME is / and buildx dies on `mkdir /.docker`. So
# leave the conversion exactly as it is and hand ownership back afterwards, from
# a root container (the only thing here with the rights to do it).
RECLAIM_DIST = docker run --rm -v $(PWD)/$(DIST):/out --entrypoint chown $(VM_IMAGE) \
		-R $(shell id -u):$(shell id -g) /out

all: build wasm web

require-docker:
	@if [ ! -S "$(DOCKER_SOCK)" ]; then \
		echo "error: $(DOCKER_SOCK) not found; this target drives BuildKit through the host Docker daemon" >&2; \
		exit 1; \
	fi

vm-image: require-docker
	@test -f vm/Dockerfile || { echo "error: vm/Dockerfile missing (lands in M1)" >&2; exit 1; }
	docker build -f vm/Dockerfile -t $(VM_IMAGE) .

builder-image: require-docker
	@test -f build/Dockerfile.c2w || { echo "error: build/Dockerfile.c2w missing (lands in M1)" >&2; exit 1; }
	docker build -f build/Dockerfile.c2w -t $(C2W_IMAGE) build/

wasm: vm-image builder-image
	@mkdir -p $(DIST)
	docker run --rm \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(PWD)/$(DIST):/out \
		$(C2W_IMAGE) --assets /assets $(VM_IMAGE) /out/smolbox.wasm
	@$(RECLAIM_DIST)

wasm-js: vm-image builder-image
	@mkdir -p $(DIST)/js
	docker run --rm \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(PWD)/$(DIST):/out \
		$(C2W_IMAGE) --assets /assets --to-js $(VM_IMAGE) /out/js/
	@$(RECLAIM_DIST)

build:
	mkdir -p $(BIN)
	go build -o $(BIN)/smolbox ./cmd/smolbox

web:
	mkdir -p web/dist
	bun build web/src/worker.ts web/src/main.ts --target=browser --outdir web/dist
	cp web/index.html web/dist/index.html
	@if [ -f "$(WASM)" ]; then cp $(WASM) web/dist/; \
	else echo "note: $(WASM) not built yet; run 'make wasm' (M1)"; fi
	@if [ -d "$(DIST)/js" ]; then \
		mkdir -p web/dist/js && \
		bun build web/src/emscripten/js-main.ts --target=browser --outfile web/dist/js/main.js && \
		cp -r $(DIST)/js/. web/dist/js/ && \
		cp web/js.html web/dist/js/index.html; \
	else echo "note: dist/js not built yet; run 'make wasm-js' (M6)"; fi
	mkdir -p web/dist/agent web/dist/scan web/dist/ort
	bun build web/src/agent/agent-main.ts web/src/agent/model-worker.ts \
		--target=browser --outdir web/dist/agent
	cp web/agent.html web/dist/agent/index.html
	@# The Antares localization page. Its own entry point rather than a mode of
	@# the chat page: the run has a budget, a termination protocol and a ranked
	@# answer, none of which chat has (PLAN §11.5).
	bun build web/src/agent/scan-main.ts --target=browser --outdir web/dist/scan
	cp web/scan.html web/dist/scan/index.html
	@# onnxruntime-web otherwise pulls these from jsdelivr at runtime; serving them
	@# locally keeps the page pinned to the installed version and works offline.
	@# Copy every simd-threaded variant rather than guessing: ORT picks the build
	@# at runtime (this version asks for .asyncify for WebGPU, not .jsep), and a
	@# missing one fails as an opaque "no available backend found".
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.*.wasm web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.*.mjs web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs web/dist/ort/

# Pulls a registry checkpoint into dist/models (gitignored). The agent page
# prefers it and falls back to the HF CDN when it is absent.
#   make model                  the default entry (LFM2 1.2B Tool, 1.22 GB)
#   make model MODEL=qwen3-1.7b a specific one
#   make model MODEL=--list     what is on offer
#   make model MODEL="gemma4-e2b-onnx --dtype q4"   a build other than the
#     entry's preferred one, for an adapter that cannot run the preferred one
model:
	bun web/fetch-model.ts $(MODEL)

# The Gemma 4 WebGPU kernel engine. Downloaded rather than vendored: the Space
# that publishes it declares no license, so a pinned pull into gitignored dist/
# is the honest way to depend on it (web/fetch-kernels.ts). web/serve.ts serves
# it at /kernels/ straight out of dist, exactly as it does the weights, and the
# agent page imports it dynamically and says to run this when it is absent.
gemma-kernels:
	bun web/fetch-kernels.ts

# Builds Antares into ONNX, because nobody publishes one (PLAN §11.1.5). This is
# the only target in the repo that needs Python, uv and an HF_TOKEN; everything
# else is Go and bun. The weights are gated, and acceptance is per repository —
# accepting antares-1b does not grant antares-350m.
#   make antares-onnx                     the shipping model (1B)
#   make antares-onnx ANTARES=antares-350m the small one (cannot follow the
#                                          protocol — see PLAN §11.10)
ANTARES ?= antares-1b
antares-onnx:
	@test -f .env || { echo "error: .env not found. Copy .env.example and set HF_TOKEN."; exit 1; }
	set -a && . ./.env && set +a && cd tools && uv run python convert_antares.py $(ANTARES)

# Checks a converted build still behaves like the checkpoint it came from:
# greedy agreement against the safetensors reference, and whether it still
# emits tool calls under Antares' own sampling settings.
antares-verify:
	cd tools && uv run python verify_onnx.py \
		--source dist/models/fdtn-ai/$(ANTARES) \
		--onnx dist/models/fdtn-ai/$(ANTARES)-ONNX --dtype fp16

serve:
	bun web/serve.ts

# Rewrites docs/schema/*.json from the Go wire types. TestArtifactsAreCurrent
# (under `make test`) fails when the checked-in files no longer match, so this
# is the only way to change them.
generate:
	go run ./cmd/gen-tool-api

test:
	go test ./...

test-integration:
	@test -f "$(WASM)" || { echo "error: $(WASM) missing; run 'make wasm' first (M1)" >&2; exit 1; }
	go test -tags integration ./tests/integration/...

test-web:
	bun test web/src

test-e2e: web
	bunx --bun playwright test --config tests/e2e/playwright.config.ts

# The cross-browser mount: Firefox has no showDirectoryPicker, so this is the
# only suite that exercises the <input webkitdirectory> fallback for real.
test-e2e-firefox: web
	bunx --bun playwright test --config tests/e2e/playwright.firefox.config.ts

test-e2e-js: web
	@test -d "$(DIST)/js" || { echo "error: $(DIST)/js missing; run 'make wasm-js' first (M6)" >&2; exit 1; }
	bunx --bun playwright test --config tests/e2e/playwright.emscripten.config.ts

# The M8 agent spike. Opt-in and not in CI: it needs a real GPU adapter (headless
# Chromium has no software fallback for WebGPU) and the local weights.
test-e2e-agent: web
	@test -d "$(DIST)/models" || { echo "error: $(DIST)/models missing; run 'make model' first (M8)" >&2; exit 1; }
	SMOLBOX_WEBGPU=1 bunx --bun playwright test --config tests/e2e/playwright.agent.config.ts

test-conformance:
	@test -f "$(WASM)" || { echo "error: $(WASM) missing; run 'make wasm' first (M1)" >&2; exit 1; }
	go test -tags integration ./tests/conformance/...

lint:
	golangci-lint run
	bunx --bun tsc --noEmit -p web/tsconfig.json

clean:
	rm -rf $(DIST) $(BIN) web/dist
