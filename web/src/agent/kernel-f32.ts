// Running the Gemma 4 kernel engine on an adapter without `shader-f16`.
//
// PLAN §10.14 established that this machine's NVIDIA adapter does not expose
// `shader-f16` in any browser, behind any flag, and that the driver is not the
// reason — Dawn withholds it per-adapter. That finding stands; nothing here
// argues with it. What it got wrong was the conclusion drawn from it, which was
// that the kernel build is therefore unrunnable on this hardware.
//
// It is not, because the engine barely needs f16. Read its op manifests: every
// op declares `typeConstraints: {T: ["float32", "float16"]}` and every
// `shader-f16` guard in every `when` clause is of the form
//
//     (tensorDtypes.aT != "float16" and ...) or device.features.has("shader-f16")
//
// — that is, the guard excludes f16 *tensors*, not the op. The WGSL is generated
// from Jinja templates that emit `enable f16;` only under `{% if usesF16 %}`.
// The whole engine is dtype-generic and has a complete f32 path already; the
// f16 requirement comes entirely from three hardcoded choices in the model
// builder, which is what this file rewrites:
//
//   1. `per_layer_model_projection.weight` is converted from the checkpoint's
//      BF16 to float16 on upload. Every other weight in the builder takes the
//      helper's `"float32"` default. (The checkpoint itself has no f16 in it at
//      all — it is F32/BF16/I8/U8.)
//   2. the `g4d-ffnormed` activation buffer is allocated float16.
//   3. the `g4d-gelu` activation buffer is allocated float16.
//
// Three tokens. With them flipped to float32, no shader in the graph sets
// `usesF16`, no `enable f16;` is emitted, and every `when` guard passes without
// the feature.
//
// The cost is real but small, and it is paid only on adapters that need it:
// those two activation buffers and one 31 MB weight double, and the arithmetic
// runs at f32 rate. The 2.1 GB of U8 4-bit weights — nearly all of the model —
// are untouched, because they were never f16 to begin with.
//
// WHY REWRITE RATHER THAN FORK. The engine is a pinned, downloaded artifact
// (web/fetch-kernels.ts explains why it is not vendored: the Space declares no
// license). `Gemma4Mobile.load()` exposes no dtype option, so there is no seam
// to pass this through. Rewriting the fetched text keeps the artifact on disk
// byte-identical to what the Space published, keeps the f16 fast path exactly as
// it was on adapters that have the feature, and confines the change to three
// assertions that fail loudly if the upstream revision moves under us.

/** A single rewrite: what it is for, and how to find it. */
interface Rewrite {
  what: string;
  find: RegExp;
  replace: string;
}

/**
 * The three sites, anchored on names that survive minification.
 *
 * `perLayerModelProjection` is a property of the builder's model object and
 * `g4d-ffnormed` / `g4d-gelu` are buffer labels, so all three are string-ish
 * content rather than identifiers a minifier is free to rename. Each pattern
 * must match exactly once — see {@link rewriteKernelsToF32}.
 */
const REWRITES: readonly Rewrite[] = [
  {
    what: "per_layer_model_projection weight upload",
    // ...,assign:m=>{l.perLayerModelProjection=c},"float16")
    find: /(perLayerModelProjection\s*=\s*[A-Za-z_$][\w$]*\s*\}\s*,\s*)"float16"/g,
    replace: '$1"float32"',
  },
  {
    what: "g4d-ffnormed activation buffer",
    find: /("g4d-ffnormed"\s*,\s*)"float16"/g,
    replace: '$1"float32"',
  },
  {
    what: "g4d-gelu activation buffer",
    find: /("g4d-gelu"\s*,\s*)"float16"/g,
    replace: '$1"float32"',
  },
];

/**
 * Thrown when the bundle does not look like the one these rewrites were written
 * against — a bumped REVISION in fetch-kernels.ts, or a re-minified upload.
 *
 * This is deliberately fatal rather than best-effort. A partial rewrite would
 * produce an engine that still allocates one f16 buffer, loads 2.5 GB, and dies
 * on the first forward pass with "No supported WebGPU variant" — the exact
 * failure this whole path exists to remove, but now with a confusing cause.
 */
export class KernelRewriteError extends Error {
  constructor(message: string) {
    super(
      `${message}. The pinned kernel bundle has changed shape; re-check the three f16 sites ` +
        `in web/src/agent/kernel-f32.ts against the revision in web/fetch-kernels.ts.`,
    );
    this.name = "KernelRewriteError";
  }
}

/**
 * Rewrites the kernel bundle's three f16 choices to f32.
 *
 * Pure string-in, string-out, so the interesting half of this path is testable
 * on the real 540 KB artifact with no GPU and no browser in the loop.
 *
 * @throws {KernelRewriteError} if any site does not appear exactly once, or if
 * the result still contains an f16 tensor allocation.
 */
export function rewriteKernelsToF32(source: string): string {
  let out = source;
  for (const { what, find, replace } of REWRITES) {
    // Counted on `out` rather than `source` so the number asserted is the number
    // about to be replaced. The three anchors are independent — none can create
    // or destroy another — but tying the count to the operation keeps that a
    // property of the code rather than of a comment.
    const hits = out.match(find)?.length ?? 0;
    if (hits !== 1) {
      throw new KernelRewriteError(`expected exactly 1 match for the ${what}, found ${hits}`);
    }
    out = out.replace(find, replace);
  }
  // Belt and braces: the rewrites above are the only known f16 sites, but a new
  // revision could add a fourth, and it would fail at the first forward pass
  // rather than here. `"float16"` also appears throughout the op manifests as a
  // permitted type — those are `typeConstraints` and `when` clauses, never a
  // choice — so only the two shapes that ALLOCATE are worth checking.
  const leftover = out.match(/(?:allocOwned\([^)]*|targetDtype:\s*)"float16"/g);
  if (leftover) {
    throw new KernelRewriteError(
      `${leftover.length} f16 allocation(s) remain after rewriting: ${leftover.join("; ")}`,
    );
  }
  return out;
}

/**
 * True when this adapter can run the engine as published.
 *
 * Asked of the adapter rather than the device because the page has not created
 * a device yet at import time, and because `requestAdapter()` is cheap and
 * idempotent. A missing `navigator.gpu` answers "no" and lets the real WebGPU
 * error come from the engine, which words it better than this file could.
 */
export async function adapterHasShaderF16(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> } }).gpu;
  if (!gpu) {
    return false;
  }
  const adapter = await gpu.requestAdapter();
  return adapter?.features.has("shader-f16") ?? false;
}
