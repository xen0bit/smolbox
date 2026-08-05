import { serve } from "bun";

const distRoot = new URL("./dist/", import.meta.url);
// Model weights are served straight out of dist/models rather than copied into
// web/dist: the q4 checkpoint is ~1.2 GB and duplicating it per bundle is silly.
const modelRoot = new URL("../dist/models/", import.meta.url);
const port = Number(Bun.env.PORT ?? 8080);

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

serve({
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

    const modelPrefix = "/models/";
    const root = pathname.startsWith(modelPrefix) ? modelRoot : distRoot;
    const rel = pathname.startsWith(modelPrefix) ? pathname.slice(modelPrefix.length) : "." + pathname;

    const file = Bun.file(new URL(rel, root));
    if (!(await file.exists())) {
      return new Response("not found: " + pathname, { status: 404, headers: isolationHeaders });
    }
    return new Response(file, { headers: isolationHeaders });
  },
});

console.log(`smolbox dev server (cross-origin isolated): http://localhost:${port}`);
