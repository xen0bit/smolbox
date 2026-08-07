import { serve } from "bun";
import { pathToFileURL } from "node:url";

/**
 * A served directory: `$name` from the environment when set, otherwise a path
 * relative to this file.
 *
 * The override exists for deployments where the artifacts do not sit beside
 * the source tree — a container serving them out of a mounted volume, say.
 * The trailing slash is not cosmetic: `new URL(rel, root)` resolves *inside* a
 * root only when the root ends in one, and an operator's DIST_DIR will not.
 */
function servedDir(name: string, fallback: string): URL {
  const override = Bun.env[name];
  if (!override) {
    return new URL(fallback, import.meta.url);
  }
  return pathToFileURL(override.endsWith("/") ? override : override + "/");
}

const distRoot = new URL("./dist/", import.meta.url);
// The artifact root: one directory holding everything the build targets put in
// dist/ — smolbox.wasm, the emscripten build (js/), the weights (models/) and
// the Gemma kernel engine (kernels/). A single override replaces one-per-dir
// env vars, which left smolbox.wasm stuck in the image: the weights and
// kernels were mountable, the WASM itself was not. A whole dist/ mounted over
// DIST_DIR overrides all of them at once.
const artifactRoot = servedDir("DIST_DIR", "../dist/");
// 0.0.0.0 is what Bun binds when asked for nothing, spelled out here so HOST has
// something to override.
const hostname = Bun.env.HOST ?? "0.0.0.0";
const port = Number(Bun.env.PORT ?? 8080);

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * The request handler.
 *
 * Split out from the `serve()` call, and the call itself guarded by
 * `import.meta.main`, so that serve.test.ts can import the helpers below
 * without the act of importing this module binding a port.
 */
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }
  if (pathname.endsWith("/")) {
    pathname += "index.html";
  }
  if (pathname.includes("..")) {
    return new Response("forbidden", { status: 403, headers: isolationHeaders });
  }

  const mounts: [string, URL][] = [
    // The bundles served by default live in web/dist; everything that
    // `make wasm`/`make wasm-js`/`make model(s)`/`make gemma-kernels`
    // produces lives in dist/, so those paths are served from DIST_DIR.
    ["/smolbox.wasm", new URL("smolbox.wasm", artifactRoot)],
    ["/js/", new URL("js/", artifactRoot)],
    ["/models/", new URL("models/", artifactRoot)],
    ["/kernels/", new URL("kernels/", artifactRoot)],
  ];
  const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
  const root = mount ? mount[1] : distRoot;
  const rel = mount ? pathname.slice(mount[0].length) : "." + pathname;

  const file = Bun.file(new URL(rel, root));
  if (!(await file.exists())) {
    return new Response("not found: " + pathname, { status: 404, headers: isolationHeaders });
  }

  // Content negotiation against the `.br`/`.gz` siblings `make compress`
  // writes. Nothing is compressed on the fly: these artifacts run to 117 MB
  // and encoding them per request would cost seconds of CPU each time and
  // force a chunked response.
  const chosen = await negotiate(file, new URL(rel, root), request);

  // Caching: every URL here can change without a filename change (`make web`,
  // `make wasm` and `make wasm-js` rewrite the bundles and the VM;
  // model/gemma-kernels re-pull weights), so nothing gets `immutable`. Strong
  // validators plus a day-long max-age give the big artifacts the right
  // behaviour on a slow link: a revisit within the day costs no request at
  // all, a revisit after that is a cheap 304, and a rebuilt artifact is
  // picked up on revalidation rather than served stale forever. HTML entries
  // are `no-cache`: they are tiny, and they are the anchor every other
  // resource revalidates against.
  //
  // The validators describe whichever representation was just chosen, so a
  // client holding the brotli copy revalidates against the brotli entry rather
  // than being told the identity bytes it never had are unchanged. `Vary` goes
  // on every response, including identity ones: without it a shared cache is
  // free to hand a brotli body to a client that asked for none.
  const etag = `"${chosen.file.size}-${chosen.file.lastModified}"`;
  const lastModified = new Date(chosen.file.lastModified).toUTCString();
  const validators: Record<string, string> = pathname.endsWith("index.html")
    ? { ETag: etag, "Last-Modified": lastModified, "Cache-Control": "no-cache" }
    : { ETag: etag, "Last-Modified": lastModified, "Cache-Control": "public, max-age=86400" };
  validators.Vary = "Accept-Encoding";
  if (chosen.encoding) {
    validators["Content-Encoding"] = chosen.encoding;
    // Bun infers Content-Type from the file's extension, and the variant's
    // extension is `.br`/`.gz` — so without this the type of every compressed
    // response describes its container instead of its content. index.html.br
    // came back as a download rather than a page, and smolbox.wasm.br would
    // lose the `application/wasm` that WebAssembly.instantiateStreaming
    // requires. Name the identity file's type explicitly.
    validators["Content-Type"] = file.type;
    // Content-Length is the encoded length, but the body a caller reads is
    // decoded, so a download progress bar driven by Content-Length would run
    // to several hundred percent. Hand over the identity size separately;
    // web/src/worker.ts prefers it. Non-standard, hence the X- prefix.
    validators["X-Uncompressed-Length"] = String(file.size);
  }

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ...isolationHeaders, ...validators } });
  }
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates carry second precision; the file's mtime does not, so floor
    // it to a whole second before comparing or a fresh file is never fresh.
    if (Number.isFinite(since) && Math.floor(chosen.file.lastModified / 1000) * 1000 <= since) {
      return new Response(null, { status: 304, headers: { ...isolationHeaders, ...validators } });
    }
  }

  // `negotiate` returns identity whenever the request carries a Range, so the
  // range arithmetic below always runs against the identity bytes.
  return serveFile(chosen.file, request.headers.get("range"), validators);
}

/**
 * True when `Accept-Encoding` offers `token` at non-zero quality.
 *
 * `identity;q=0, *;q=0` and `br;q=0` both have to come out false: a client that
 * explicitly refuses an encoding must not be handed it. The wildcard counts as
 * an offer, which is what `*` means.
 */
export function acceptsEncoding(header: string | null, token: string): boolean {
  if (!header) {
    return false;
  }
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== token && name !== "*") {
      continue;
    }
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) {
      return false;
    }
    return true;
  }
  return false;
}

interface Negotiated {
  file: Bun.BunFile;
  encoding: "br" | "gzip" | null;
}

/**
 * Picks the encoded sibling to serve, if any.
 *
 * Two rules keep this from breaking the callers that matter:
 *
 * A `Range` request is always answered with identity bytes. Per RFC 9110 a
 * range names an offset into the *selected representation*, so returning
 * `bytes 0-262143` of a brotli stream would be legal and useless — the Gemma
 * kernel engine asks for 256 KB windows of model.safetensors expecting the
 * weights at that offset. Weights are excluded from `make compress` anyway;
 * this is the belt to that braces.
 *
 * Brotli is preferred over gzip when both are offered and both exist: it is
 * around 4.9x on these artifacts against gzip's 3.9x.
 */
async function negotiate(
  identity: Bun.BunFile,
  identityUrl: URL,
  request: Request,
): Promise<Negotiated> {
  if (request.headers.get("range")) {
    return { file: identity, encoding: null };
  }
  const accept = request.headers.get("accept-encoding");
  for (const [token, suffix] of [
    ["br", ".br"],
    ["gzip", ".gz"],
  ] as const) {
    if (!acceptsEncoding(accept, token)) {
      continue;
    }
    const variant = Bun.file(new URL(identityUrl.pathname + suffix, identityUrl));
    if (await variant.exists()) {
      return { file: variant, encoding: token };
    }
  }
  return { file: identity, encoding: null };
}

/**
 * Serves a file, honouring a single `Range` header.
 *
 * Range support is not a nicety here. The Gemma kernel engine reads
 * model.safetensors in 256 KB chunks so it can stream a 2.5 GB checkpoint onto
 * the GPU without holding it in memory, and it caches those chunks in IndexedDB.
 * Against a server that ignores Range it gets the WHOLE file back for every
 * chunk request and dies allocating a 2.5 GB Uint8Array — which is exactly what
 * happened, and looks like an out-of-memory bug in the engine rather than a
 * missing feature here. The HF CDN supports ranges, so the Space never saw it.
 *
 * One range only: that is all any client here asks for, and a multipart
 * response would be a lot of machinery for no caller.
 */
async function serveFile(
  file: Bun.BunFile,
  range: string | null,
  validators: Record<string, string>,
): Promise<Response> {
  const size = file.size;
  const headers: Record<string, string> = { ...isolationHeaders, ...validators };
  // Only the identity representation is range-addressable here: `negotiate`
  // hands back identity for any request carrying a Range, so advertising
  // ranges on an encoded body would promise something never served.
  if (!validators["Content-Encoding"]) {
    headers["Accept-Ranges"] = "bytes";
  }

  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m) {
    return new Response(file, { headers });
  }

  // `bytes=-N` means the last N bytes; `bytes=N-` means from N to the end.
  const [, rawStart, rawEnd] = m;
  const suffix = rawStart === "";
  let start = suffix ? Math.max(0, size - Number(rawEnd || 0)) : Number(rawStart);
  let end = suffix || rawEnd === "" ? size - 1 : Number(rawEnd);
  end = Math.min(end, size - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}

// Only when run as a program (`bun web/serve.ts`), never on import: serve.test.ts
// imports the helpers above and must not bind a port by doing so.
if (import.meta.main) {
  serve({ hostname, port, fetch: handle });

  // A wildcard bind is not a URL anyone can click, so name localhost in that case
  // and the actual address otherwise.
  const shown = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
  console.log(
    `smolbox dev server (cross-origin isolated): http://${shown}:${port}` +
      ` [bind ${hostname}:${port}, artifacts ${artifactRoot.pathname}]`,
  );
}
