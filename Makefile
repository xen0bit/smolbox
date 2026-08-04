SHELL := /bin/bash

BIN         := bin
DIST        := dist
WASM        := $(DIST)/smolbox.wasm
DOCKER_SOCK := /var/run/docker.sock

VM_IMAGE  := smolbox/vm:dev
C2W_IMAGE := smolbox/c2w-builder:dev
C2W_VERSION ?= 0.8.4

.PHONY: all build wasm wasm-js vm-image builder-image require-docker web serve \
        test test-integration test-web test-e2e test-e2e-js test-conformance lint clean

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
	docker run --rm \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(PWD)/$(DIST):/out \
		$(C2W_IMAGE) --assets /assets $(VM_IMAGE) /out/smolbox.wasm

wasm-js: vm-image builder-image
	@mkdir -p $(DIST)/js
	docker run --rm \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(PWD)/$(DIST):/out \
		$(C2W_IMAGE) --assets /assets --to-js $(VM_IMAGE) /out/js/

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

serve:
	bun web/serve.ts

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

test-conformance:
	@test -f "$(WASM)" || { echo "error: $(WASM) missing; run 'make wasm' first (M1)" >&2; exit 1; }
	go test -tags integration ./tests/conformance/...

lint:
	golangci-lint run
	bunx --bun tsc --noEmit -p web/tsconfig.json

clean:
	rm -rf $(DIST) $(BIN) web/dist
