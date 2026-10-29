// Opens the LFM3 kernel engine's public wrapper onto the session inside it.
//
// The Space (webml-community/LFM3-1.7B-WebGPU-Pi) publishes the engine as a
// real module, `Lfm3ForCausalLM.js`, so unlike Bonsai's there is nothing to cut
// out. But what `Lfm3ForCausalLM.from_pretrained()` returns is a thin wrapper
// holding the loaded session in a private class field, and exposes only the
// engine's own agent API: `create_session()`, whose generate() renders the
// template itself and returns parsed messages. That is the layer this project
// replaces — the dialect parses the raw completion, special tokens and all, and
// the prompt is rendered with our tool schema (prompt-codec.ts).
//
// The session behind the wrapper already has the exact shape KernelSession
// drives — public `model`, `generationState`, `eosTokenIds`, `tokenizer`,
// `reset()` — so one getter is all that is missing. It is added to the wrapper
// class in the fetched text, the same way kernel-f32.ts rewrites Gemma's dtype
// choices: matched structurally rather than by minified name, and required to
// match exactly once, so a republished bundle fails at `make lfm3-kernels`
// rather than as an undefined property deep in a model load. PLAN §10.30.

/** The export the adapter imports. */
export const LFM3_EXPORT = "Lfm3ForCausalLM";

/** The getter the rewrite adds; lfm3-kernels.ts reads it. */
export const SESSION_ACCESSOR = "_session";

// The wrapper is the only class whose constructor stores its one argument in a
// private field and whose first method is create_session — the session classes
// define create_session much later in their bodies.
const WRAPPER = /class\{(#\w+);constructor\((\w+)\)\{this\.\1=\2\}(?=create_session\()/g;

export class Lfm3ExposeError extends Error {}

/** Returns the engine with {@link SESSION_ACCESSOR} added to its public wrapper. */
export function exposeLfm3Session(code: string): string {
  if (!code.slice(0, 200).includes(LFM3_EXPORT)) {
    throw new Lfm3ExposeError(`does not look like the ${LFM3_EXPORT} bundle (first line: ${code.split("\n")[0]})`);
  }
  const matches = [...code.matchAll(WRAPPER)];
  if (matches.length !== 1) {
    throw new Lfm3ExposeError(`expected exactly one model wrapper class, found ${matches.length}`);
  }
  const m = matches[0]!;
  const end = m.index! + m[0].length;
  return `${code.slice(0, end)}get ${SESSION_ACCESSOR}(){return this.${m[1]}}${code.slice(end)}`;
}
