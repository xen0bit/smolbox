// The f32 rewrite of the kernel bundle.
//
// Two kinds of test here, and the second is the one that matters. The synthetic
// cases pin the failure modes — a site that moved, a site that appeared twice, a
// fourth f16 allocation nobody knew about — because each of them, left
// unchecked, produces the same downstream symptom: 2.5 GB streams onto the GPU
// and the first forward pass dies with "No supported WebGPU variant".
//
// The last test runs the real thing: the actual pinned 540 KB artifact from
// dist/kernels, rewritten, asserted on. That is the regression guard with teeth,
// because the bundle is a downloaded artifact rather than source — nothing else
// in this repo would notice if bumping REVISION in web/fetch-kernels.ts moved
// the three sites. It skips rather than fails when the bundle has not been
// downloaded, which is the state of a fresh checkout and of CI.

import { describe, expect, test } from "bun:test";

import { KernelRewriteError, rewriteKernelsToF32 } from "./kernel-f32.ts";

/** A miniature stand-in with all three sites, in the shapes the bundle uses. */
function fakeBundle(): string {
  return (
    `var x=(c,d,p,f="float32")=>{a.push(Xs({name:c,sourceDtype:"BF16",targetDtype:f}))};` +
    'x(`${gn}.per_layer_model_projection.weight`,[1,2],c=>{l.perLayerModelProjection=c},"float16"),' +
    'x(`${gn}.per_layer_projection_norm.weight`,[3],c=>{l.perLayerProjectionNorm=c});' +
    'let j=this.allocOwned([b,o],"g4d-ffnormed","float16"),' +
    'ne=this.allocOwned([b,E],"g4d-gelu","float16"),' +
    'Q=this.allocOwned([b,u],"g4d-ple-gelu");' +
    // manifest noise: "float16" as a permitted type, which must NOT be touched
    'var m={typeConstraints:{T:["float32","float16"]},when:\'tensorDtypes.aT != "float16" or device.features.has("shader-f16")\'};'
  );
}

describe("rewriteKernelsToF32", () => {
  test("flips all three f16 sites to f32", () => {
    const out = rewriteKernelsToF32(fakeBundle());
    expect(out).toContain('l.perLayerModelProjection=c},"float32"');
    expect(out).toContain('"g4d-ffnormed","float32"');
    expect(out).toContain('"g4d-gelu","float32"');
  });

  test("leaves the op manifests alone", () => {
    // The manifests mention float16 constantly — as a permitted type and in the
    // guards that skip f16 tensors. Rewriting those would change which variant
    // the engine selects, which is not this file's business.
    const out = rewriteKernelsToF32(fakeBundle());
    expect(out).toContain('typeConstraints:{T:["float32","float16"]}');
    expect(out).toContain('tensorDtypes.aT != "float16"');
    // Untouched buffers keep the allocator's default rather than gaining an arg.
    expect(out).toContain('"g4d-ple-gelu"');
  });

  test("preserves everything else byte for byte", () => {
    const src = fakeBundle();
    const out = rewriteKernelsToF32(src);
    // Three sites, "float16" -> "float32": same length, and the only characters
    // that move are the two digits at each site.
    expect(out.length).toBe(src.length);
    const differing: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== out[i]) {
        differing.push(i);
      }
    }
    expect(differing.length).toBe(6);
    expect(differing.map((i) => `${src[i]}${out[i]}`)).toEqual(["13", "62", "13", "62", "13", "62"]);
  });

  test("refuses a bundle where a site is missing", () => {
    const src = fakeBundle().replace('"g4d-gelu","float16"', '"g4d-gelu"');
    expect(() => rewriteKernelsToF32(src)).toThrow(KernelRewriteError);
    expect(() => rewriteKernelsToF32(src)).toThrow(/found 0/);
  });

  test("refuses a bundle where a site appears twice", () => {
    // Ambiguity is as dangerous as absence: a second match means the anchor no
    // longer identifies one decision, so "which one did we just change?" has no
    // answer and the rewrite cannot be trusted.
    const src = `${fakeBundle()}later=this.allocOwned([b,o],"g4d-ffnormed","float16");`;
    expect(() => rewriteKernelsToF32(src)).toThrow(/found 2/);
  });

  test("refuses a bundle that still allocates f16 after rewriting", () => {
    const src = `${fakeBundle()}z=this.allocOwned([b,q],"g4d-something-new","float16");`;
    expect(() => rewriteKernelsToF32(src)).toThrow(/f16 allocation\(s\) remain/);
  });

  test("refuses a bundle that still uploads a weight as f16", () => {
    const src = `${fakeBundle()}Xs({name:"w",sourceDtype:"BF16",targetDtype:"float16"});`;
    expect(() => rewriteKernelsToF32(src)).toThrow(/f16 allocation\(s\) remain/);
  });

  test("is not idempotent, on purpose", () => {
    // Running it twice means the caller lost track of which bundle it holds.
    // Failing is more useful than quietly succeeding.
    const once = rewriteKernelsToF32(fakeBundle());
    expect(() => rewriteKernelsToF32(once)).toThrow(KernelRewriteError);
  });
});

describe("the real pinned bundle", () => {
  const path = "dist/kernels/gemma4/gemma-4-e2b.js";
  const file = Bun.file(path);
  const present = file.size > 0;

  test.skipIf(!present)("has exactly the three f16 sites this file knows about", async () => {
    const src = await file.text();
    const out = rewriteKernelsToF32(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toBe(src);
  });

  test.skipIf(!present)("still declares f16 as a permitted type everywhere it did", async () => {
    // The rewrite must not narrow the engine: on an adapter WITH shader-f16 the
    // unmodified bundle is what gets imported, and these manifests are shared.
    const src = await file.text();
    const out = rewriteKernelsToF32(src);
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    expect(count(out, /typeConstraints/g)).toBe(count(src, /typeConstraints/g));
    expect(count(out, /shader-f16/g)).toBe(count(src, /shader-f16/g));
    expect(count(out, /enable f16;/g)).toBe(count(src, /enable f16;/g));
  });
});
