SHELL := /bin/bash

BIN         := bin
DIST        := dist
WASM        := $(DIST)/smolbox.wasm
DOCKER_SOCK := /var/run/docker.sock

VM_IMAGE  := smolbox/vm:dev
C2W_IMAGE := smolbox/c2w-builder:dev
C2W_VERSION ?= 0.8.4

.PHONY: all build wasm wasm-js vm-image builder-image require-docker web serve generate model \
        test test-integration test-web test-e2e test-e2e-js test-e2e-agent test-conformance lint clean

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
	mkdir -p web/dist/agent web/dist/ort
	bun build web/src/agent/agent-main.ts web/src/agent/model-worker.ts \
		--target=browser --outdir web/dist/agent
	cp web/agent.html web/dist/agent/index.html
	@# onnxruntime-web otherwise pulls these from jsdelivr at runtime; serving them
	@# locally keeps the page pinned to the installed version and works offline.
	@# Copy every simd-threaded variant rather than guessing: ORT picks the build
	@# at runtime (this version asks for .asyncify for WebGPU, not .jsep), and a
	@# missing one fails as an opaque "no available backend found".
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.*.wasm web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.*.mjs web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm web/dist/ort/
	cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs web/dist/ort/

# Pulls the ~1.2 GB q4 checkpoint into dist/models (gitignored). The agent page
# prefers it and falls back to the HF CDN when it is absent.
model:
	bun web/fetch-model.ts

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
