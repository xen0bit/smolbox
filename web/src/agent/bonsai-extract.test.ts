// Cutting the Bonsai engine out of its Space's page.
//
// The synthetic cases pin the ways a republished Space could move the cut; the
// last test checks the real fetched artifact when there is one, and skips on a
// fresh checkout and in CI, exactly as kernel-f32.test.ts does for Gemma.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { BonsaiExtractError, extractBonsaiEngine } from "./bonsai-extract.ts";

const ENGINE = 'var Zl=1;class Q{static load(){return new Q}};export{Zl as DEFAULT_MODEL_ID,Q as TernaryBonsai2,Zl as default};';
const APP = 'const Fe=e=>document.getElementById(e);Fe("chat").addEventListener("click",()=>{});';

function page(...scripts: string[]): string {
  return `<!doctype html><html><head><style>x{}</style></head><body><canvas></canvas>${scripts
    .map((s) => `<script type="module">${s}</script>`)
    .join("\n")}</body></html>`;
}

describe("extractBonsaiEngine", () => {
  test("keeps the engine and drops the app code after its export", () => {
    expect(extractBonsaiEngine(page("let scene=1;", ENGINE + APP))).toBe(ENGINE);
  });

  test("ignores module scripts that do not export the engine", () => {
    // The Space's first module is its WebGPU background scene.
    const scene = "window.PrismBootReady=new Promise(()=>{});";
    expect(extractBonsaiEngine(page(scene, ENGINE + APP))).toBe(ENGINE);
  });

  test("refuses a page with no engine", () => {
    expect(() => extractBonsaiEngine(page("let a=1;"))).toThrow(BonsaiExtractError);
  });

  test("refuses two engines rather than guessing", () => {
    expect(() => extractBonsaiEngine(page(ENGINE, ENGINE))).toThrow(/found 2/);
  });

  test("refuses an export statement that moved inside the block", () => {
    const twice = ENGINE + APP + "export{Q as TernaryBonsai2};";
    expect(() => extractBonsaiEngine(page(twice))).toThrow(/export statement/);
  });

  const real = "dist/kernels/bonsai/ternary-bonsai-2.js";
  test.skipIf(!existsSync(real))("the fetched engine is a module exporting TernaryBonsai2 and nothing after it", () => {
    const code = readFileSync(real, "utf8");
    const { exports } = new Bun.Transpiler({ loader: "js" }).scan(code);
    expect(exports).toContain("TernaryBonsai2");
    expect(code.trimEnd().endsWith("};")).toBe(true);
    expect(code.slice(code.lastIndexOf("export{"))).toContain("as TernaryBonsai2");
  });
});
