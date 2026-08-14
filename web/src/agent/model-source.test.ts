import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_SOURCE,
  parseModelSource,
  selectableModels,
  unavailableReason,
} from "./model-source.ts";
import { DEFAULT_MODEL_KEY, modelFor, models } from "./models.ts";

describe("the model source flag", () => {
  test("an absent flag is the hub, which is what a deployment gets", () => {
    expect(DEFAULT_MODEL_SOURCE).toBe("hub");
    expect(parseModelSource(undefined)).toBe("hub");
    expect(parseModelSource(null)).toBe("hub");
    expect(parseModelSource("")).toBe("hub");
  });

  test("only the exact word opts into local weights", () => {
    expect(parseModelSource("local")).toBe("local");
    // The `web` target rejects these before a bundle exists; this pins what
    // happens if one ever reaches the page anyway, and it is not "local".
    for (const typo of ["Local", "locl", "LOCAL", "dist/models", "hub"]) {
      expect(parseModelSource(typo), `${typo} must not enable local weights`).toBe("hub");
    }
  });
});

describe("what each source can offer", () => {
  test("a local build offers the whole registry", () => {
    expect(selectableModels("local").map((m) => m.key)).toEqual(models.map((m) => m.key));
  });

  test("a hub build offers everything that does not need something built here", () => {
    const offered = selectableModels("hub");
    expect(offered.length).toBeGreaterThan(0);
    for (const m of offered) {
      expect(m.requiresLocalBuild, `${m.key} needs a local build and must not be offered`).toBeUndefined();
    }
  });

  test("the Gemma kernel entry is the one a hub build holds back", () => {
    // Its weights are on the hub like everyone else's — it is the engine that
    // is not. If this ever changes, the entry loses requiresLocalBuild rather
    // than this test losing its assertion.
    expect(unavailableReason(modelFor("gemma4-e2b"), "hub")).toBeDefined();
    expect(unavailableReason(modelFor("gemma4-e2b"), "local")).toBeUndefined();
    expect(unavailableReason(modelFor("gemma4-e2b-onnx"), "hub")).toBeUndefined();
  });

  test("the reason names something to run, since it is shown to a reader", () => {
    for (const m of models.filter((e) => e.requiresLocalBuild)) {
      expect(m.requiresLocalBuild).toMatch(/make |SMOLBOX_MODEL_SOURCE/);
    }
  });

  test("the default entry loads on either source, so the page opens on it", () => {
    // agent-main falls back to the first selectable entry when it does not, but
    // a default that needs a fallback is a registry mistake rather than a
    // feature.
    expect(unavailableReason(modelFor(DEFAULT_MODEL_KEY), "hub")).toBeUndefined();
  });
});
