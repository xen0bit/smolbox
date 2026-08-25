import { describe, expect, test } from "bun:test";
import { isDownloading, isWorkerPhase, vmChip, vmStatusLine, type VmPhase } from "./vm-status.ts";

const ALL: VmPhase[] = ["fetching", "instantiating", "booting", "ready", "exited", "failed"];

describe("isWorkerPhase", () => {
  test("accepts the three the worker tags its log messages with", () => {
    expect(isWorkerPhase("fetching")).toBe(true);
    expect(isWorkerPhase("instantiating")).toBe(true);
    expect(isWorkerPhase("booting")).toBe(true);
  });

  test("rejects the phases that arrive as their own message, and everything else", () => {
    // ready/exited/failed reach a page as ready/exit/error, never as a log tag,
    // so a page must not accept them from one.
    expect(isWorkerPhase("ready")).toBe(false);
    expect(isWorkerPhase("exited")).toBe(false);
    expect(isWorkerPhase("failed")).toBe(false);
    // The boot watchdog's stall report is a log message with no phase at all,
    // and the pages tell it apart from a lifecycle step by exactly this.
    expect(isWorkerPhase(undefined)).toBe(false);
    expect(isWorkerPhase("")).toBe(false);
    expect(isWorkerPhase("boot stalled: 20000ms, polls=42")).toBe(false);
    expect(isWorkerPhase(3)).toBe(false);
  });
});

describe("vmChip", () => {
  test("every phase has a state and a word", () => {
    for (const phase of ALL) {
      const chip = vmChip(phase);
      expect(chip.detail).not.toBe("");
      expect(["idle", "loading", "ready", "error"]).toContain(chip.state);
    }
  });

  test("the three loading steps are distinguishable, which is the whole point", () => {
    // The chip used to say "downloading" from the first progress message until
    // someone pressed start, so these three collapsing into one word would put
    // the bug straight back.
    const details = ["fetching", "instantiating", "booting"].map(
      (p) => vmChip(p as VmPhase).detail,
    );
    expect(new Set(details).size).toBe(3);
    for (const p of ["fetching", "instantiating", "booting"] as VmPhase[]) {
      expect(vmChip(p).state).toBe("loading");
    }
  });

  test("ready carries the agent version, and says something without one", () => {
    expect(vmChip("ready", "agent v0.0.1")).toEqual({ state: "ready", detail: "agent v0.0.1" });
    expect(vmChip("ready")).toEqual({ state: "ready", detail: "ready" });
  });

  test("a VM that is gone is an error, however it went", () => {
    expect(vmChip("exited", "code 0")).toEqual({ state: "error", detail: "exited (code 0)" });
    expect(vmChip("failed").state).toBe("error");
  });
});

describe("vmStatusLine", () => {
  test("every phase reads as a sentence", () => {
    for (const phase of ALL) {
      expect(vmStatusLine(phase)).not.toBe("");
    }
  });

  test("the line the header used to be stuck on is not the last one", () => {
    // The regression in one assertion: "booting the VM" is posted before
    // wasi.start(), and ready has to be able to follow it.
    expect(vmStatusLine("booting")).toBe("booting the VM…");
    expect(vmStatusLine("ready", "agent v0.0.1")).toBe("ready (agent v0.0.1)");
  });

  test("a failure says what failed", () => {
    expect(vmStatusLine("failed", "fetch smolbox.wasm: 404 Not Found")).toBe(
      "error: fetch smolbox.wasm: 404 Not Found",
    );
    expect(vmStatusLine("exited", "code 1")).toBe("the VM exited (code 1)");
  });
});

describe("isDownloading", () => {
  test("only the fetch keeps the bar on screen", () => {
    expect(isDownloading("fetching")).toBe(true);
    for (const phase of ALL.filter((p) => p !== "fetching")) {
      expect(isDownloading(phase)).toBe(false);
    }
  });
});
