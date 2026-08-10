/**
 * Tests for the static server's content negotiation.
 *
 * These run against a real `serve.ts` process over a real socket rather than
 * calling the handler directly: the behaviour that matters here is the shape of
 * the response headers (Vary, Content-Encoding, the range interaction), and a
 * unit call would not exercise Bun's own header handling.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { acceptsEncoding, cacheControl } from "./serve.ts";

let dist: string;
let proc: Bun.Subprocess;
let base: string;

// Long enough to be worth compressing and to slice a range out of.
const WASM_BODY = Buffer.from("\0asm" + "smolbox".repeat(4096));

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), "smolbox-serve-"));
  await writeFile(path.join(dist, "smolbox.wasm"), WASM_BODY);
  await writeFile(path.join(dist, "smolbox.wasm.br"), zlib.brotliCompressSync(WASM_BODY));
  await writeFile(path.join(dist, "smolbox.wasm.gz"), zlib.gzipSync(WASM_BODY));

  // Under kernels/, which is one of the prefixes serve.ts routes to DIST_DIR;
  // anything else resolves against the bundle directory beside serve.ts.
  const HTML = Buffer.from("<!doctype html><title>x</title>" + "<p>hello</p>".repeat(200));
  await mkdir(path.join(dist, "kernels"), { recursive: true });
  await writeFile(path.join(dist, "kernels", "page.html"), HTML);
  await writeFile(path.join(dist, "kernels", "page.html.br"), zlib.brotliCompressSync(HTML));

  // A file with no encoded siblings, standing in for the model weights that
  // `make compress` deliberately skips.
  await mkdir(path.join(dist, "models"), { recursive: true });
  await writeFile(path.join(dist, "models", "model.safetensors"), WASM_BODY);

  const port = 18106 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", path.join(import.meta.dir, "serve.ts")], {
    env: { ...process.env, DIST_DIR: dist, HOST: "127.0.0.1", PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "identity" } });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("serve.ts did not come up");
});

afterAll(async () => {
  proc?.kill();
  await rm(dist, { recursive: true, force: true });
});

describe("acceptsEncoding", () => {
  test("matches a plain token", () => {
    expect(acceptsEncoding("gzip, deflate, br", "br")).toBe(true);
    expect(acceptsEncoding("gzip, deflate", "br")).toBe(false);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(acceptsEncoding("  GZIP , BR ", "gzip")).toBe(true);
  });

  test("honours an explicit q=0 refusal", () => {
    expect(acceptsEncoding("br;q=0, gzip", "br")).toBe(false);
    expect(acceptsEncoding("br;q=0.1", "br")).toBe(true);
  });

  test("treats a wildcard as an offer, and q=0 on it as a refusal", () => {
    expect(acceptsEncoding("*", "br")).toBe(true);
    expect(acceptsEncoding("*;q=0", "br")).toBe(false);
  });

  test("is false for a missing header", () => {
    expect(acceptsEncoding(null, "br")).toBe(false);
  });
});

describe("encoding negotiation", () => {
  test("prefers brotli when both are offered", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "gzip, br" },
    });
    expect(r.headers.get("content-encoding")).toBe("br");
    expect(r.headers.get("vary")).toBe("Accept-Encoding");
  });

  test("falls back to gzip when brotli is not offered", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "gzip" } });
    expect(r.headers.get("content-encoding")).toBe("gzip");
  });

  test("serves identity when nothing is offered", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "identity" } });
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("vary")).toBe("Accept-Encoding");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
  });

  test("reports the identity size for a progress bar to divide by", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "br" } });
    // Content-Length measures the encoded body; X-Uncompressed-Length is what
    // the decoded stream will actually add up to.
    expect(r.headers.get("x-uncompressed-length")).toBe(String(WASM_BODY.length));
    expect(Number(r.headers.get("content-length"))).toBeLessThan(WASM_BODY.length);
    expect(new Uint8Array(await r.arrayBuffer()).byteLength).toBe(WASM_BODY.length);
  });

  test("does not advertise ranges on an encoded body", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "br" } });
    expect(r.headers.get("accept-ranges")).toBeNull();
  });

  // Bun types a response from the file extension, and the variant's extension
  // is `.br`. Left alone, index.html.br is typed as its container and browsers
  // download the page instead of rendering it; smolbox.wasm.br loses the
  // application/wasm that WebAssembly.instantiateStreaming insists on.
  test("keeps the identity Content-Type on an encoded body", async () => {
    const [enc, identity] = await Promise.all(
      ["br", "identity"].map((e) =>
        fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": e } }),
      ),
    );
    expect(enc.headers.get("content-type")).toBe(identity.headers.get("content-type"));
    expect(enc.headers.get("content-type")).toContain("wasm");
  });

  test("keeps text/html on an encoded page", async () => {
    const r = await fetch(`${base}/kernels/page.html`, { headers: { "Accept-Encoding": "br" } });
    expect(r.headers.get("content-encoding")).toBe("br");
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  test("serves a file with no encoded sibling as identity", async () => {
    const r = await fetch(`${base}/models/model.safetensors`, {
      headers: { "Accept-Encoding": "br, gzip" },
    });
    expect(r.headers.get("content-encoding")).toBeNull();
  });

  // `make web` rewrites a bundle and leaves its .br/.gz siblings behind, so a
  // rebuilt file whose encoded copy still holds the previous build must come
  // back as identity. Serving the stale variant looks like the edit never
  // happened, with nothing in the response to hint at why.
  test("ignores an encoded sibling older than the file it encodes", async () => {
    const stale = path.join(dist, "kernels", "stale.js");
    await writeFile(stale, "console.log('old');\n".repeat(100));
    await writeFile(`${stale}.br`, zlib.brotliCompressSync(Buffer.from("console.log('old');\n")));
    // Rewrite the identity file so it is strictly newer than the variant.
    await Bun.sleep(10);
    const fresh = "console.log('new');\n".repeat(100);
    await writeFile(stale, fresh);

    const r = await fetch(`${base}/kernels/stale.js`, { headers: { "Accept-Encoding": "br, gzip" } });
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(await r.text()).toBe(fresh);
  });

  test("serves an encoded sibling that is newer than the file it encodes", async () => {
    const body = "console.log('current');\n".repeat(100);
    const current = path.join(dist, "kernels", "current.js");
    await writeFile(current, body);
    await Bun.sleep(10);
    await writeFile(`${current}.br`, zlib.brotliCompressSync(Buffer.from(body)));

    const r = await fetch(`${base}/kernels/current.js`, { headers: { "Accept-Encoding": "br" } });
    expect(r.headers.get("content-encoding")).toBe("br");
    expect(await r.text()).toBe(body);
  });
});

describe("range requests", () => {
  // The Gemma kernel engine reads model.safetensors in 256 KB windows. If a
  // Range request were ever answered with an encoded body, those offsets would
  // land in the middle of a brotli stream.
  test("answers a range with identity bytes even when brotli is offered", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "br, gzip", Range: "bytes=0-15" },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("content-range")).toBe(`bytes 0-15/${WASM_BODY.length}`);
    const got = new Uint8Array(await r.arrayBuffer());
    expect(Buffer.from(got)).toEqual(WASM_BODY.subarray(0, 16));
  });

  test("a mid-file range still lands on identity offsets", async () => {
    const r = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "br", Range: "bytes=1000-1015" },
    });
    expect(Buffer.from(new Uint8Array(await r.arrayBuffer()))).toEqual(
      WASM_BODY.subarray(1000, 1016),
    );
  });
});

describe("cacheControl", () => {
  test("HTML never sticks", () => {
    expect(cacheControl("/index.html")).toBe("no-cache");
    expect(cacheControl("/agent/index.html")).toBe("no-cache");
  });

  test("the pinned onnxruntime build is immutable", () => {
    expect(cacheControl("/ort/ort-wasm-simd-threaded.jsep.wasm")).toContain("immutable");
  });

  test("artifacts a rebuild rewrites in place still revalidate", () => {
    // These change under the same name, so `immutable` would strand a client on
    // a stale VM or a stale checkpoint with no way to notice.
    for (const p of ["/smolbox.wasm", "/main.js", "/models/repo/onnx/model.onnx", "/kernels/gemma4/x.js"]) {
      expect(cacheControl(p)).toBe("public, max-age=86400");
    }
  });
});

describe("validators", () => {
  test("the ETag distinguishes the encodings", async () => {
    const [br, gzip, identity] = await Promise.all(
      ["br", "gzip", "identity"].map((enc) =>
        fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": enc } }),
      ),
    );
    const tags = [br, gzip, identity].map((r) => r.headers.get("etag"));
    // Three representations, three validators: a cache keyed on ETag alone
    // must not be able to confuse them.
    expect(new Set(tags).size).toBe(3);
  });

  test("revalidating with the matching ETag gives a 304", async () => {
    const first = await fetch(`${base}/smolbox.wasm`, { headers: { "Accept-Encoding": "br" } });
    const etag = first.headers.get("etag")!;
    const second = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "br", "If-None-Match": etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("content-encoding")).toBe("br");
  });

  test("an ETag from another encoding does not satisfy the request", async () => {
    const identity = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "identity" },
    });
    const r = await fetch(`${base}/smolbox.wasm`, {
      headers: { "Accept-Encoding": "br", "If-None-Match": identity.headers.get("etag")! },
    });
    expect(r.status).toBe(200);
  });
});
