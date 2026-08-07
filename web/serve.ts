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

serve({
  hostname,
  port,
  async fetch(request) {
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
    return serveFile(file, request.headers.get("range"));
  },
});

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
async function serveFile(file: Bun.BunFile, range: string | null): Promise<Response> {
  const size = file.size;
  const headers: Record<string, string> = { ...isolationHeaders, "Accept-Ranges": "bytes" };

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

// A wildcard bind is not a URL anyone can click, so name localhost in that case
// and the actual address otherwise.
const shown = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
console.log(
  `smolbox dev server (cross-origin isolated): http://${shown}:${port}` +
    ` [bind ${hostname}:${port}, artifacts ${artifactRoot.pathname}]`,
);
