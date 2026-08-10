// How much of a prompt to hand the forward pass, and how much of it is already
// in the KV cache.
//
// Split out of model-worker.ts because it is the part that would corrupt a
// conversation rather than fail one — feed the wrong window and the model reads
// text nobody wrote, silently — and because it needs neither a GPU nor a
// checkpoint to be wrong. Same reasoning as GemmaKernelEngine.wrap().

import { commonPrefix } from "./prefix.ts";

export interface PrefillPlan {
  /**
   * How many leading prompt tokens the existing cache still covers.
   *
   * Zero means the cache is no use, whether because there was none or because
   * the prompt diverged from it.
   */
  reuse: number;
  /**
   * Whether the caller must dispose the cache before prefilling.
   *
   * Separate from `reuse === 0` because there is nothing to dispose when there
   * was no cache to begin with, and disposal is the expensive, GPU-touching half.
   */
  drop: boolean;
  /**
   * Prompt lengths to prefill up to, in order, before the generating call.
   *
   * Each entry is an absolute length into the prompt rather than a chunk size,
   * because that is what the caller passes to `generate()`: transformers.js is
   * given the whole prefix and trims it against the cache itself. The last
   * segment is deliberately absent — the generating call prefills it — so
   * `steps` is empty whenever one call can do the job.
   */
  steps: number[];
}

/**
 * Decides what to reuse and where to break the prefill.
 *
 * Two conditions have to hold before a cache can be reused, and the second is
 * the one that is easy to miss:
 *
 *  1. The cached sequence must be a **prefix** of this prompt. Neither cache in
 *     this project can be cropped (see prefix.ts), so a prompt that diverges
 *     anywhere invalidates all of it.
 *  2. There must be at least one token left over. A prompt that is exactly what
 *     the cache already holds leaves nothing to feed the forward pass, and
 *     transformers.js reads that case as "input_ids holds only unprocessed
 *     tokens" and forwards the entire prompt again on top of a full cache —
 *     wrong output rather than an error. Starting over costs one prefill;
 *     getting this wrong costs the conversation.
 */
export function planPrefill(
  cachedIds: readonly number[],
  promptIds: readonly number[],
  chunkTokens: number,
): PrefillPlan {
  const shared = commonPrefix(cachedIds, promptIds);
  const usable = cachedIds.length > 0 && shared === cachedIds.length && shared < promptIds.length;
  const reuse = usable ? shared : 0;
  const chunk = Math.max(1, Math.floor(chunkTokens));

  const steps: number[] = [];
  for (let end = reuse + chunk; end < promptIds.length; end += chunk) {
    steps.push(end);
  }

  return { reuse, drop: cachedIds.length > 0 && !usable, steps };
}
