import { describe, expect, test } from "bun:test";

import { errorChain, flattenMessage, isDeviceLoss } from "./device-loss.ts";

class DeviceLostError extends Error {
  override name = "DeviceLostError";
}

// The shape the LFM3 engine threw on an AMD RDNA 3 adapter (PLAN §10.33): the
// outer message names no cause, and the loss is only inside it.
function pipelinedFailure(inner: unknown[]): AggregateError {
  return new AggregateError(inner, "Pipelined generation and in-flight cleanup both failed");
}

describe("isDeviceLoss", () => {
  test("finds a loss inside the engine's AggregateError", () => {
    const err = pipelinedFailure([
      new DeviceLostError("the GPU device was lost (unknown): vkQueueSubmit failed with VK_ERROR_DEVICE_LOST"),
      new Error("mapAsync failed"),
    ]);
    expect(isDeviceLoss(err)).toBe(true);
  });

  test("control: the outer message alone does not say so", () => {
    expect(isDeviceLoss(new Error(pipelinedFailure([]).message))).toBe(false);
  });

  test("recognises the engine's error by name, whatever it says", () => {
    expect(isDeviceLoss(pipelinedFailure([new DeviceLostError("gone")]))).toBe(true);
  });

  test("follows cause", () => {
    expect(isDeviceLoss(new Error("step failed", { cause: new Error("Device is lost") }))).toBe(true);
  });

  test("still recognises onnxruntime's messages", () => {
    expect(isDeviceLoss(new Error("[Invalid Buffer] is invalid due to a previous error"))).toBe(true);
    expect(isDeviceLoss("failed to allocate a buffer")).toBe(true);
  });

  test("an ordinary failure is not a loss", () => {
    expect(isDeviceLoss(pipelinedFailure([new Error("cache length 10 exceeds maxLength 8")]))).toBe(false);
    expect(isDeviceLoss(new Error("generate before ready"))).toBe(false);
  });
});

describe("errorChain", () => {
  test("terminates on a cause that points back at itself", () => {
    const err = new Error("loop");
    (err as { cause?: unknown }).cause = err;
    expect(errorChain(err)).toEqual([err]);
  });
});

describe("flattenMessage", () => {
  test("names what was inside, once each", () => {
    const err = pipelinedFailure([new DeviceLostError("the GPU device was lost"), new Error("the GPU device was lost")]);
    expect(flattenMessage(err)).toBe("Pipelined generation and in-flight cleanup both failed: the GPU device was lost");
  });
});
