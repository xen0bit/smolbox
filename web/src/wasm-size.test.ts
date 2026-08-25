import { describe, expect, test } from "bun:test";
import { downloadTotal, parseWasmBytes } from "./wasm-size.ts";

/** A stand-in for `Headers`, case-insensitive like the real thing. */
function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("parseWasmBytes", () => {
  test("takes the number the build measured", () => {
    expect(parseWasmBytes("152565835")).toBe(152565835);
    expect(parseWasmBytes(152565835)).toBe(152565835);
    expect(parseWasmBytes(" 152565835 ")).toBe(152565835);
  });

  test("anything unusable is 0, which the bar already knows how to render", () => {
    expect(parseWasmBytes(undefined)).toBe(0);
    expect(parseWasmBytes(null)).toBe(0);
    expect(parseWasmBytes("")).toBe(0);
    expect(parseWasmBytes("0")).toBe(0);
    expect(parseWasmBytes("-1")).toBe(0);
    expect(parseWasmBytes("about 150 MB")).toBe(0);
    expect(parseWasmBytes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("downloadTotal", () => {
  test("an unencoded response already counts the bytes the reader yields", () => {
    expect(downloadTotal(headers({ "Content-Length": "152565835" }), 0)).toBe(152565835);
  });

  test("serve.ts's identity size wins over the encoded Content-Length", () => {
    const h = headers({
      "Content-Encoding": "br",
      "Content-Length": "45178449",
      "X-Uncompressed-Length": "152565835",
    });
    expect(downloadTotal(h, 999)).toBe(152565835);
  });

  test("an encoded response with no identity size falls back to the build flag", () => {
    // This is GitHub Pages exactly: gzip, a Content-Length describing the
    // compressed bytes, and no header naming the size of the decoded ones. It
    // is the case that left the deployment with no percentage at all.
    const h = headers({ "Content-Encoding": "gzip", "Content-Length": "56409697" });
    expect(downloadTotal(h, 151229171)).toBe(151229171);
    expect(downloadTotal(h, 0)).toBe(0);
  });

  test("a chunked response with no length at all falls back the same way", () => {
    expect(downloadTotal(headers({}), 151229171)).toBe(151229171);
    expect(downloadTotal(headers({}), 0)).toBe(0);
  });

  test("a Content-Length that is not a number does not become NaN", () => {
    const h = headers({ "Content-Length": "unknown" });
    expect(downloadTotal(h, 0)).toBe(0);
    expect(downloadTotal(h, 151229171)).toBe(151229171);
  });
});
