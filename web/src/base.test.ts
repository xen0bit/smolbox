import { describe, expect, test } from "bun:test";

import { asset, BASE, DEFAULT_BASE, parseBase } from "./base.ts";

describe("the base path flag", () => {
  test("an absent flag is the root, which is what `make serve` hosts", () => {
    expect(DEFAULT_BASE).toBe("/");
    expect(parseBase(undefined)).toBe("/");
    expect(parseBase(null)).toBe("/");
    expect(parseBase("")).toBe("/");
    expect(parseBase("   ")).toBe("/");
  });

  test("every spelling of a subdirectory normalises to one form", () => {
    // What someone would actually type on the command line, in each of the
    // four ways they might think to type it.
    for (const raw of ["/smolbox/", "/smolbox", "smolbox/", "smolbox"]) {
      expect(parseBase(raw), `${raw} must normalise`).toBe("/smolbox/");
    }
  });

  test("a nested base survives too", () => {
    expect(parseBase("a/b")).toBe("/a/b/");
  });

  test("this bundle was built for the root", () => {
    // The unit suite runs without --define, so it sees the default. A build
    // that does pass one is covered by parseBase above; this pins that an
    // unflagged build does not somehow acquire a prefix.
    expect(BASE).toBe("/");
  });
});

describe("asset()", () => {
  test("names a path relative to the site root", () => {
    expect(asset("worker.js")).toBe("/worker.js");
    expect(asset("ort/")).toBe("/ort/");
    expect(asset("kernels/gemma4/gemma-4-e2b.js")).toBe("/kernels/gemma4/gemma-4-e2b.js");
  });

  test("a leading slash is tolerated rather than doubled", () => {
    // The spelling every call site used before this module existed.
    expect(asset("/worker.js")).toBe("/worker.js");
  });
});
