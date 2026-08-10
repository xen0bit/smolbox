import { defineConfig, devices } from "@playwright/test";

// The weight cache, on Firefox.
//
// It gets its own config rather than a project inside playwright.agent.config.ts
// because the two browsers need opposite things to reach a WebGPU adapter: that
// one passes Chromium `--use-angle=vulkan`, this one has to turn WebGPU on by
// preference. Without `dom.webgpu.enabled` Firefox has no `navigator.gpu` at
// all, onnxruntime-web rejects the load with `Unsupported device: "webgpu".
// Should be one of: wasm` — and, because that throw happens inside getSession
// *before* the weights are fetched, nothing is ever written to the cache. A
// suite that ran without the pref would fail for a reason that has nothing to
// do with caching.
//
// Firefox matters here specifically: it reads a response body in ~26 KB pieces
// where Chromium uses far larger ones, so it fires an order of magnitude more
// progress callbacks per file. That is what made the missing throttle in
// model-worker.ts visible there first (28 739 events for one cold load of
// LFM2.5 2.6B, against ~2 700 in Chromium), and it is what the event-count
// assertion in model-cache.spec.ts guards.
export default defineConfig({
  testDir: ".",
  testMatch: "**/model-cache.spec.ts",
  timeout: 15 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Firefox"],
    browserName: "firefox",
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      firefoxUserPrefs: {
        // WebGPU is off by default in release Firefox on Linux. The last two are
        // belt and braces for a headless run, where the compositor decision that
        // normally gates WebGPU has not been made.
        "dom.webgpu.enabled": true,
        "dom.webgpu.workers.enabled": true,
        "gfx.webgpu.force-enabled": true,
        "gfx.webrender.all": true,
      },
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
