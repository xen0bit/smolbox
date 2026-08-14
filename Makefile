SHELL := /bin/bash

BIN         := bin
DIST        := dist
WASM        := $(DIST)/smolbox.wasm
DOCKER_SOCK := /var/run/docker.sock

VM_IMAGE  := smolbox/vm:dev
C2W_IMAGE := smolbox/c2w-builder:dev
C2W_VERSION ?= 0.8.4

.PHONY: all everything build wasm vm-image builder-image require-docker web web-local serve compress generate model models gemma-kernels \
        test test-integration test-web test-e2e test-e2e-firefox test-e2e-agent \
        test-e2e-agent-smoke test-e2e-agent-firefox \
        test-conformance lint clean

# c2w runs as root in the container, so everything it writes to dist/ lands
# root-owned — and then a later write into dist/ fails with EPERM for the user
# who ran make. Fixing this by running the converter as --user does NOT work:
# with no passwd entry for the uid, $HOME is / and buildx dies on
# `mkdir /.docker`. So leave the conversion exactly as it is and hand ownership
# back afterwards, from a root container (the only thing here with the rights).
RECLAIM_DIST = docker run --rm -v $(PWD)/$(DIST):/out --entrypoint chown $(VM_IMAGE) \
		-R $(shell id -u):$(shell id -g) /out

# A bare `make` builds everything a deployment serves, from a clean checkout.
#
# Stated explicitly rather than relying on `everything` being the first target,
# so that adding a target above this line cannot silently change what `make`
# does.
#
# Be aware this includes `models`, an ~11 GB pull. It is the last step for that
# reason, and it is resumable: a re-run skips what already landed, and
# everything else is finished and encoded before it starts.
.DEFAULT_GOAL := everything

# The order is load-bearing, not cosmetic:
#
#   gemma-kernels before      the kernel engine is a .js file under dist and
#     compress                gets encoded like everything else.
#   compress before models    weights are excluded from compression anyway, so
#                             putting the 11 GB pull last means a dropped
#                             connection costs you the download and not also
#                             the encoded artifacts. `make models` is resumable;
#                             re-running it skips what already landed.
#
# Sequential $(MAKE) calls rather than prerequisites, so that `make -jN`
# cannot reorder the steps above into a broken build.
everything:
	$(MAKE) build
	$(MAKE) wasm
	$(MAKE) web
	$(MAKE) gemma-kernels
	$(MAKE) compress
	$(MAKE) models
	@echo ""
	@echo "everything: dist/ is complete and encoded; 'make serve' to run it"

# `all` is the conventional name for the default goal, so it is an alias rather
# than a second, subtly different build.
all: everything

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

build:
	mkdir -p $(BIN)
	go build -o $(BIN)/smolbox ./cmd/smolbox

# Where the agent page reads weights from: `hub` (the default) or `local`.
#
# Baked into the bundle rather than read by the server, because web/dist is
# static and `make compress` writes .br/.gz variants beside every file — there is
# nothing left for a server to rewrite on the way out. See
# web/src/agent/model-source.ts.
#
#   make web                              a deployment: huggingface.co only
#   SMOLBOX_MODEL_SOURCE=local make web   dist/models, for debugging a checkpoint
#
# A hub build hides the entries that need something built locally (today: the
# Gemma 4 kernel engine), so `make everything` produces a page whose every
# offered model a visitor can actually load.
SMOLBOX_MODEL_SOURCE ?= hub

web:
	@case "$(SMOLBOX_MODEL_SOURCE)" in \
		hub|local) ;; \
		*) echo "error: SMOLBOX_MODEL_SOURCE must be 'hub' or 'local', got '$(SMOLBOX_MODEL_SOURCE)'" >&2; exit 1 ;; \
	esac
	@echo "web: model source is $(SMOLBOX_MODEL_SOURCE)"
	mkdir -p web/dist
	bun build web/src/worker.ts web/src/main.ts --target=browser --outdir web/dist
	cp web/index.html web/dist/index.html
	@# Both pages link this; it holds the tokens, the controls and the terminal
	@# styling they share (the agent page grew a terminal of its own at the
	@# console panel, and two copies of those rules had already drifted once).
	cp web/style.css web/dist/style.css
	@# The VM artifacts stay in dist/ and are served from there (web/serve.ts
	@# resolves them via DIST_DIR); web/dist holds only the bundles.
	mkdir -p web/dist/agent web/dist/ort
	@# --define replaces the bare SMOLBOX_MODEL_SOURCE identifier with a literal;
	@# process.env would not survive a browser build, which has no process.
	bun build web/src/agent/agent-main.ts web/src/agent/model-worker.ts \
		--target=browser --outdir web/dist/agent \
		--define SMOLBOX_MODEL_SOURCE='"$(SMOLBOX_MODEL_SOURCE)"'
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

# Pulls a registry checkpoint into dist/models (gitignored), for the page built
# with SMOLBOX_MODEL_SOURCE=local — a hub build ignores dist/models entirely and
# reads every checkpoint from huggingface.co. See `web` above.
#   make model                  the default entry (LFM2.5 2.6B, 1.85 GB)
#   make model MODEL=lfm2-1.2b-tool  a specific one
#   make model MODEL=--list     what is on offer
#   make model MODEL="gemma4-e2b-onnx --dtype q4"   a build other than the
#     entry's preferred one, for an adapter that cannot run the preferred one
model:
	bun web/fetch-model.ts $(MODEL)

# Every downloadable registry entry, in one go — roughly 11 GB, so this is a
# "leave it running" target rather than a routine one. Already-complete files
# are skipped by the fetcher's cached-size check, which makes a re-run a cheap
# way to finish an interrupted pull.
#
# It keeps going past a failure and reports at the end: a dropped connection on
# the 3.6 GB entry must not throw away the five that would have succeeded after
# it. The exit status still reflects the failures, so CI cannot mistake a
# partial shelf for a full one.
models:
	@keys=$$(bun web/fetch-model.ts --keys) || { echo "error: could not read the model registry" >&2; exit 1; }; \
	failed=(); \
	for key in $$keys; do \
		echo "==> $$key"; \
		bun web/fetch-model.ts $$key || failed+=("$$key"); \
	done; \
	if [ $${#failed[@]} -gt 0 ]; then \
		echo "" >&2; \
		echo "failed ($${#failed[@]}): $${failed[*]}" >&2; \
		echo "re-run 'make models' to retry — what already landed is kept" >&2; \
		exit 1; \
	fi; \
	echo ""; \
	echo "all downloadable registry entries are in $(DIST)/models"; \
	echo "note: gemma4-e2b also needs 'make gemma-kernels' for the engine"

# The Gemma 4 WebGPU kernel engine. Downloaded rather than vendored: the Space
# that publishes it declares no license, so a pinned pull into gitignored dist/
# is the honest way to depend on it (web/fetch-kernels.ts). web/serve.ts serves
# it at /kernels/ straight out of dist, exactly as it does the weights, and the
# agent page imports it dynamically and says to run this when it is absent.
gemma-kernels:
	bun web/fetch-kernels.ts

# Writes a .br and a .gz beside every compressible artifact in dist/. serve.ts
# picks them up automatically; without them it serves identity and nothing
# breaks, so this is optional locally and worth doing for anything deployed.
#
# Weights under dist/models are skipped: they are quantised (so they barely
# compress) and the Gemma kernel engine reads them through Range requests.
# Re-running is cheap — a variant newer than its source is left alone.
compress:
	bun web/precompress.ts

# The bundle the GPU suites need: they load checkpoints off the disk, and a hub
# build refuses to (web/src/agent/model-source.ts). It rebuilds web/dist, so a
# `make web` afterwards is what puts the deployment build back — hence the note.
web-local:
	@SMOLBOX_MODEL_SOURCE=local $(MAKE) web
	@echo "note: web/dist now loads weights from dist/models; 'make web' restores the hub build"

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
	@# web/, not web/src: serve.test.ts sits beside serve.ts at the top of web/.
	bun test web

test-e2e: web
	bunx --bun playwright test --config tests/e2e/playwright.config.ts

# The cross-browser mount: Firefox has no showDirectoryPicker, so this is the
# only suite that exercises the <input webkitdirectory> fallback for real.
test-e2e-firefox: web
	bunx --bun playwright test --config tests/e2e/playwright.firefox.config.ts

# The M8 agent spike. Opt-in and not in CI: it needs a real GPU adapter (headless
# Chromium has no software fallback for WebGPU) and the local weights.
test-e2e-agent: web-local
	@test -d "$(DIST)/models" || { echo "error: $(DIST)/models missing; run 'make model' first (M8)" >&2; exit 1; }
	SMOLBOX_WEBGPU=1 bunx --bun playwright test --config tests/e2e/playwright.agent.config.ts

# The same GPU path on the smallest entry in the registry, in ~20 s instead of
# ~15 minutes. This is the one to run between changes; test-e2e-agent is the one
# to run before believing a model. See tests/e2e/playwright.agent-smoke.config.ts
# for what it does and does not prove.
SMOKE_MODEL ?= lfm2.5-350m
test-e2e-agent-smoke: web-local
	@test -d "$(DIST)/models/onnx-community/LFM2.5-350M-ONNX" || \
		{ echo "error: weights missing; run 'make model MODEL=$(SMOKE_MODEL)' first" >&2; exit 1; }
	SMOLBOX_WEBGPU=1 SMOLBOX_MODEL=$(SMOKE_MODEL) \
		bunx --bun playwright test --config tests/e2e/playwright.agent-smoke.config.ts

# The weight cache on Firefox. Separate from test-e2e-agent because reaching a
# WebGPU adapter needs a preference there and a launch flag in Chromium, and
# because Firefox is where the download-progress flood shows up: it hands the
# response body over in far smaller pieces, so a missing throttle costs an order
# of magnitude more messages. See tests/e2e/playwright.agent-firefox.config.ts.
test-e2e-agent-firefox: web-local
	@test -d "$(DIST)/models" || { echo "error: $(DIST)/models missing; run 'make model' first (M8)" >&2; exit 1; }
	bunx --bun playwright test --config tests/e2e/playwright.agent-firefox.config.ts

test-conformance:
	@test -f "$(WASM)" || { echo "error: $(WASM) missing; run 'make wasm' first (M1)" >&2; exit 1; }
	go test -tags integration ./tests/conformance/...

lint:
	golangci-lint run
	bunx --bun tsc --noEmit -p web/tsconfig.json

clean:
	rm -rf $(DIST) $(BIN) web/dist
