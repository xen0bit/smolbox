# The `make serve` dev server, containerised.
#
#   docker build -t smolbox/serve:dev .
#   docker run --rm -p 8080:8080 -v $PWD/dist:/data:ro smolbox/serve:dev
#
# What it does NOT do is build dist/smolbox.wasm. That conversion (`make wasm`)
# drives BuildKit through the host Docker daemon, which a container build has no
# socket for. Run `make wasm` (and optionally `make wasm-js`) on the host first
# and the artifacts get baked in; skip it and the image still builds and serves
# the agent and scan pages, exactly as `make web` does when dist/ is empty.
#
# Configuration, all at run time:
#   HOST       address to bind          (default 0.0.0.0)
#   PORT       port to listen on        (default 8080)
#   DIST_DIR   dist/ to serve artifacts from (default /data)
#
# DIST_DIR is the whole dist/ directory, not one path per artifact: smolbox.wasm,
# the emscripten build and — when mounted — the weights and the Gemma kernel
# engine are all read from it. dist/models is tens of gigabytes of checkpoints
# and none of it belongs in a layer, so only the two small VM artifacts are
# baked in; mount a host dist/ over /data to replace everything at once.

FROM oven/bun:1.2.18-alpine@sha256:a7df687a2f684ee2f7404e2592039e192d75d26a04f843e60d9fc342741187d0 AS web
WORKDIR /src

# `make web` is the single source of truth for how the bundles are produced, so
# the build runs it rather than restating its bun invocations here. bash comes
# along because the Makefile sets SHELL := /bin/bash and alpine has no bash.
RUN apk add --no-cache make bash

# Dependencies first, from the lockfile alone: editing web/src must not re-resolve
# them. onnxruntime-web matters beyond bundling — make web copies its .wasm/.mjs
# runtime files into web/dist/ort so the page never reaches for a CDN.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY Makefile ./
COPY web ./web
# The agent bundle imports the builtin tool schema out of docs/ (tool-registry.ts),
# so the sources are not confined to web/.
COPY docs/schema ./docs/schema

# The VM artifacts, when the host has already built them. A plain COPY cannot be
# conditional and dist/ is gitignored build output that a fresh clone will not
# have, so read them off a bind mount of the build context instead — missing is a
# normal state here, not an error.
RUN --mount=type=bind,target=/ctx \
    mkdir -p dist \
    && if [ -f /ctx/dist/smolbox.wasm ]; then cp /ctx/dist/smolbox.wasm dist/; fi \
    && if [ -d /ctx/dist/js ]; then mkdir -p dist/js && cp -r /ctx/dist/js/. dist/js/; fi

RUN make web

FROM oven/bun:1.2.18-alpine@sha256:a7df687a2f684ee2f7404e2592039e192d75d26a04f843e60d9fc342741187d0
WORKDIR /app

# serve.ts resolves what it serves relative to its own module URL, so the layout
# under /app has to mirror the repo's: the bundles are its ./dist sibling. The
# artifacts (smolbox.wasm, the merged js/ page) go to /data, the default
# DIST_DIR, so an unmounted run still serves them and 404s only the weight and
# kernel paths that need a mount.
COPY web/serve.ts ./web/serve.ts
COPY --from=web /src/web/dist ./web/dist
COPY --from=web /src/dist /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DIST_DIR=/data

# Documents the default only; a different PORT still needs its own -p mapping.
EXPOSE 8080

USER bun
CMD ["bun", "web/serve.ts"]
