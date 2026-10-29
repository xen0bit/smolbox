// Telling a dead WebGPU device apart from an ordinary failed run.
//
// The worker's recovery — drop the session, rebuild it on the next request,
// let the loop retry the turn once — only runs for a failure classified as a
// device loss, so a loss that is not recognised strands the page on a session
// whose every later run fails the same way.
//
// onnxruntime-web reports a loss in the message itself. The kernel engines do
// not always: their pipelined decode wraps the step that failed and the
// cleanup that failed after it in one AggregateError ("Pipelined generation and
// in-flight cleanup both failed"), and the reason is only in the errors inside
// it. So the whole tree is searched, `errors` and `cause` both. PLAN §10.33.

const LOSS_PATTERN = /previous error|device (is |was )?lost|failed to allocate|mapAsync|OrtRun/i;

/** Every error in the tree, the outer one first. Bounded, since a cause can point back at itself. */
export function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const queue: unknown[] = [err];
  while (queue.length > 0 && out.length < 32) {
    const e = queue.shift();
    if (out.includes(e)) {
      continue;
    }
    out.push(e);
    if (e instanceof AggregateError) {
      queue.push(...e.errors);
    }
    if (e instanceof Error && e.cause !== undefined) {
      queue.push(e.cause);
    }
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether anything in the error's tree says the GPU device is gone. */
export function isDeviceLoss(err: unknown): boolean {
  return errorChain(err).some(
    (e) => (e instanceof Error && e.name === "DeviceLostError") || LOSS_PATTERN.test(messageOf(e)),
  );
}

/**
 * One line naming every distinct message in the tree.
 *
 * The outer message of an AggregateError is a summary that names no cause, and
 * that summary is all a reader saw when the device was lost under LFM3.
 */
export function flattenMessage(err: unknown): string {
  const seen: string[] = [];
  for (const e of errorChain(err)) {
    const m = messageOf(e);
    if (m && !seen.includes(m)) {
      seen.push(m);
    }
  }
  return seen.join(": ");
}
