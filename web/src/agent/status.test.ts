// The rules half of the status strip. The DOM half needs a page and a GPU,
// which CI has neither of; this is the part that can be held to anything.

import { describe, expect, test } from "bun:test";

import { PageStatus, canChat, chipText, formatBytes } from "./status.ts";

/** The two members of Element that PageStatus actually touches. */
function fakeChip() {
  const attrs: Record<string, string> = {};
  const text = { textContent: "" };
  return {
    el: {
      textContent: "",
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      querySelector: () => text,
      hidden: false,
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
    },
    attrs,
    text,
  };
}

describe("chipText", () => {
  test("names the component and its detail", () => {
    expect(chipText("vm", { state: "ready", detail: "agent v0.0.1" })).toBe("VM agent v0.0.1");
    expect(chipText("model", { state: "loading", detail: "LFM2.5 2.6B (q4)" })).toBe("model LFM2.5 2.6B (q4)");
  });

  test("falls back to the bare name", () => {
    expect(chipText("folder", { state: "idle", detail: "" })).toBe("folder");
  });
});

describe("canChat", () => {
  test("needs both halves", () => {
    expect(canChat("ready", "ready")).toBe(true);
    expect(canChat("ready", "loading")).toBe(false);
    expect(canChat("error", "ready")).toBe(false);
  });
});

describe("PageStatus", () => {
  test("starts every component idle and says so", () => {
    const vm = fakeChip();
    const status = new PageStatus({
      vm: vm.el as unknown as Element,
      model: null,
      folder: null,
      progressRow: null,
      progressBar: null,
      progressLabel: null,
    });
    expect(status.phase("vm")).toBe("idle");
    expect(vm.attrs["data-state"]).toBe("idle");
    expect(vm.text.textContent).toBe("VM not started");
  });

  test("a component's state is independent of the others", () => {
    const vm = fakeChip();
    const model = fakeChip();
    const status = new PageStatus({
      vm: vm.el as unknown as Element,
      model: model.el as unknown as Element,
      folder: null,
      progressRow: null,
      progressBar: null,
      progressLabel: null,
    });
    status.vm("ready", "agent v0.0.1");
    status.model("error", "no WebGPU adapter");

    expect(vm.attrs["data-state"]).toBe("ready");
    expect(model.attrs["data-state"]).toBe("error");
    expect(status.phase("vm")).toBe("ready");
    expect(status.phase("model")).toBe("error");
  });

  test("the long form goes in the title, not on the chip", () => {
    const model = fakeChip();
    const status = new PageStatus({
      vm: null,
      model: model.el as unknown as Element,
      folder: null,
      progressRow: null,
      progressBar: null,
      progressLabel: null,
    });
    status.model("ready", "LFM2.5 2.6B (q4)", "LFM2.5 2.6B ready (local, q4, 6231ms)");
    expect(model.text.textContent).toBe("model LFM2.5 2.6B (q4)");
    expect(model.attrs["title"]).toBe("LFM2.5 2.6B ready (local, q4, 6231ms)");
  });

  test("a download with no total leaves the bar indeterminate", () => {
    const bar = fakeChip();
    const label = fakeChip();
    const row = fakeChip();
    const status = new PageStatus({
      vm: null,
      model: null,
      folder: null,
      progressRow: row.el as unknown as Element,
      progressBar: bar.el as unknown as Element,
      progressLabel: label.el as unknown as Element,
    });

    status.progress("smolbox.wasm", 1 << 20, 4 << 20);
    expect(bar.attrs["value"]).toBe("25");
    expect(label.el.textContent).toContain("1.0 MiB of 4.0 MiB (25%)");

    // An encoded response with no X-Uncompressed-Length has no denominator, and
    // a bar frozen at the last percentage would be a lie for the rest of it.
    status.progress("smolbox.wasm", 2 << 20);
    expect(bar.attrs["value"]).toBeUndefined();
    expect(label.el.textContent).toBe("smolbox.wasm — 2.0 MiB");

    status.clearProgress();
    expect(row.el.hidden).toBe(true);
  });
});

describe("formatBytes", () => {
  test.each([
    [512, "512 B"],
    [1536, "2 KiB"],
    [150 * 1024 * 1024, "150.0 MiB"],
    [2 * 1024 * 1024 * 1024, "2.0 GiB"],
  ])("%i -> %s", (n, want) => {
    expect(formatBytes(n)).toBe(want);
  });
});
