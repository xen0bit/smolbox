import { defineConfig, devices } from "@playwright/test";

// The GPU path, small enough to actually run.
//
// playwright.agent.config.ts is the thorough one: the default entry, 1.8 GB of
// weights, a 15-minute ceiling, and in practice the suite nobody runs between
// changes because of it. This is the same page, the same loop and the same real
// WebGPU adapter, driven against the smallest entry in the registry — LFM2.5
// 350M at ~294 MB, which loads in ~1.6 s (PLAN §10.20) — so the whole thing
// finishes in about the time a unit run takes.
//
// It runs agent-smoke.spec.ts rather than agent.spec.ts, and the difference is
// the point: the thorough spec asserts that the model listed the folder it was
// asked about, which is a claim about the model. This one asserts only what the
// code under test controls. That is what makes a 350M checkpoint — which emits
// a perfect call and then runs `ls` on `/` — a perfectly good smoke model.

export default defineConfig({
  testDir: ".",
  testMatch: ["**/agent-smoke.spec.ts"],
  // Two minutes rather than fifteen. If this entry takes longer than that,
  // something is wrong and waiting will not fix it.
  timeout: 2 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    // The minimum that yields a real adapter in headless Chromium (measured at
    // M8); there is no software fallback for WebGPU here.
    launchOptions: {
      args: ["--use-angle=vulkan", "--enable-features=Vulkan"],
    },
  },
  webServer: {
    command: "bun web/serve.ts",
    cwd: "../..",
    port: 8080,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
