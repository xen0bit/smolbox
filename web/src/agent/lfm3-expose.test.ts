// Opening the LFM3 engine's wrapper onto its session.
//
// The synthetic cases pin the ways a republished bundle could move the anchor;
// the last test checks the real fetched artifact when there is one, and skips
// on a fresh checkout and in CI, as bonsai-extract.test.ts does.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { LFM3_EXPORT, Lfm3ExposeError, SESSION_ACCESSOR, exposeLfm3Session } from "./lfm3-expose.ts";

const HEADER = `// ${LFM3_EXPORT} WebGPU library (model hints: lfm3).\n`;
const WRAPPER = "var Qo=class{#e;constructor(t){this.#e=t}create_session(t={}){return this.#e.create_session(t)}};";
const SESSION = "var fo=class{#e;#t;constructor(t){this.#e=t.runtime}reset(){}create_session(t={}){return 1}};";
const TAIL = `export{Qo as ${LFM3_EXPORT}};`;

/** Evaluates a rewritten bundle's wrapper class and returns what its getter hands back. */
function unwrap(code: string, inner: unknown): unknown {
  const body = code.replace(HEADER, "").replace(TAIL, "");
  const Wrapper = new Function(`${body}; return Qo;`)() as new (x: unknown) => Record<string, unknown>;
  return new Wrapper(inner)[SESSION_ACCESSOR];
}

describe("exposeLfm3Session", () => {
  test("adds a getter that returns the wrapped session, and only to the wrapper", () => {
    const out = exposeLfm3Session(HEADER + SESSION + WRAPPER + TAIL);
    expect(out.split(`get ${SESSION_ACCESSOR}(`)).toHaveLength(2);
    const inner = { model: 1 };
    expect(unwrap(out, inner)).toBe(inner);
  });

  test("follows the private field's name rather than assuming it", () => {
    const renamed = WRAPPER.replaceAll("#e", "#q").replaceAll("(t)", "(z)").replace("this.#q=t", "this.#q=z");
    const out = exposeLfm3Session(HEADER + renamed + TAIL);
    expect(out).toContain(`get ${SESSION_ACCESSOR}(){return this.#q}create_session(`);
  });

  test("refuses a file that is not the engine", () => {
    expect(() => exposeLfm3Session("<!doctype html><html></html>")).toThrow(Lfm3ExposeError);
  });

  test("refuses a bundle with no wrapper", () => {
    expect(() => exposeLfm3Session(HEADER + SESSION + TAIL)).toThrow(/found 0/);
  });

  test("refuses two candidates rather than guessing", () => {
    expect(() => exposeLfm3Session(HEADER + WRAPPER + WRAPPER.replace("Qo", "Qp") + TAIL)).toThrow(/found 2/);
  });

  const real = "dist/kernels/lfm3/Lfm3ForCausalLM.js";
  test.skipIf(!existsSync(real))("the fetched engine exports the model class and carries the getter once", () => {
    const code = readFileSync(real, "utf8");
    const { exports } = new Bun.Transpiler({ loader: "js" }).scan(code);
    expect(exports).toContain(LFM3_EXPORT);
    expect(code.split(`get ${SESSION_ACCESSOR}(`)).toHaveLength(2);
  });
});
