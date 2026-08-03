import { serve } from "bun";

const distRoot = new URL("./dist/", import.meta.url);
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
    if (pathname.includes("..")) {
      return new Response("forbidden", { status: 403, headers: isolationHeaders });
    }

    const file = Bun.file(new URL("." + pathname, distRoot));
    if (!(await file.exists())) {
      return new Response("not found: " + pathname, { status: 404, headers: isolationHeaders });
    }
    return new Response(file, { headers: isolationHeaders });
  },
});

console.log(`smolbox dev server (cross-origin isolated): http://localhost:${port}`);
