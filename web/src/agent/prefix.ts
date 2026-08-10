// The one rule both KV caches live under.
//
// Neither backend's cache can be cropped: the Gemma engine's generation state
// truncates only from the end it grew, and transformers.js' DynamicCache has no
// crop at all. So a cache is either still describing a prefix of what is about
// to be prefilled, in which case the rest can be fed to it, or it describes
// something else and has to be thrown away.
//
// That makes the agent loop's history policy part of the cache's correctness.
// Appending a tool result extends the prompt, so the cache survives; eliding an
// older message rewrites text the cache has already absorbed, so it does not.
// The reuse therefore helps most within a turn — which is exactly where the loop
// does its re-prefilling — and stops helping the moment elide() fires.

/** How many leading elements the two sequences agree on. */
export function commonPrefix(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i++;
  }
  return i;
}
