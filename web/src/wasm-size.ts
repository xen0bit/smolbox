// How big smolbox.wasm is, when the response will not say.
//
// The download bar needs a denominator, and the only honest one is the size of
// the bytes the reader actually yields — the *identity* size, because fetch()
// decodes a compressed body before anyone sees it. web/serve.ts hands that over
// in X-Uncompressed-Length whenever it serves a `.br`/`.gz` variant, and
// worker.ts prefers it. GitHub Pages serves the same artifact gzipped
// (~151 MB down to ~56 MB) and sends no such header, so on the deployment the
// denominator was missing and the bar ran indeterminate for the whole download
// — which is what "it lost the progress bar" looks like from the outside.
//
// Nothing at runtime can recover the number there. The browser puts
// `Accept-Encoding: gzip` on every fetch and will not let script remove it, and
// a Range request is no way round it either: Pages answers one against the
// *compressed* representation (`content-range: bytes 0-0/56409697`), so even a
// one-byte probe reports the encoded length. The size is only knowable where
// the file is, which is at build time.
//
// So it is a build flag, the third in the same shape and for the same reason as
// SMOLBOX_BASE (src/base.ts) and SMOLBOX_MODEL_SOURCE (agent/model-source.ts):
// web/dist is static, so there is nothing left for a server to rewrite on the
// way out. `make web` measures dist/smolbox.wasm and substitutes the number;
// a build with no wasm on disk gets 0, which lands back on the indeterminate
// bar rather than on a lie.

/**
 * Substituted at build time by `bun build --define` — see the `web` target.
 *
 * Declared rather than imported for the same reason as SMOLBOX_BASE: it is a
 * bare identifier the bundler replaces with a literal, and a build that omits
 * the flag leaves it undefined, which is why every read goes through a `typeof`
 * guard.
 */
declare const SMOLBOX_WASM_BYTES: string | number | undefined;

/**
 * A byte count from the build flag, or 0 for anything unusable.
 *
 * Permissive like parseBase, and for the same reason: a hand-rolled
 * `bun build` or a unit test importing this module should get a working page.
 * 0 is a meaningful answer here rather than a failure — it is "no denominator",
 * the state the bar already knows how to render.
 */
export function parseWasmBytes(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** What this build measured dist/smolbox.wasm at, or 0 if it had none. */
export const EXPECTED_WASM_BYTES: number = parseWasmBytes(
  typeof SMOLBOX_WASM_BYTES === "undefined" ? undefined : SMOLBOX_WASM_BYTES,
);

/** Just enough of `Headers` to ask it a question, so a test can pass a map. */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The denominator for a download bar over `response`, or 0 for "unknown".
 *
 * Three sources, in falling order of authority:
 *
 *   X-Uncompressed-Length  the server measured the identity bytes and said so.
 *   Content-Length         trustworthy only on an unencoded response, where it
 *                          already counts the bytes the reader will yield.
 *   the build flag         nobody said, so fall back to what was on disk when
 *                          this bundle was built.
 *
 * The build flag is last because it is the only one that can be stale: rebuild
 * the VM without rebuilding the bundle and it describes the previous artifact.
 * That is bounded — `make site` rebuilds the bundle after checking the wasm
 * exists, and `make serve` sends a real header so the flag is never consulted —
 * and the caller guards the rest by dropping the total the moment more bytes
 * arrive than it allows for.
 */
export function downloadTotal(headers: HeaderSource, expected = EXPECTED_WASM_BYTES): number {
  const identity = Number(headers.get("x-uncompressed-length"));
  if (Number.isFinite(identity) && identity > 0) {
    return identity;
  }
  if (!headers.get("content-encoding")) {
    const length = Number(headers.get("content-length"));
    if (Number.isFinite(length) && length > 0) {
      return length;
    }
  }
  return expected;
}
