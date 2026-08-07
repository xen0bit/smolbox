import { defineConfig, devices } from "@playwright/test";

// The WASI browser suite. emscripten.spec.ts needs dist/js, which `make wasm`
// does not produce, so it runs from playwright.emscripten.config.ts instead;
// agent.spec.ts and model-cache.spec.ts need a GPU and dist/models and run from
// playwright.agent.config.ts; mount-picker.spec.ts asserts the
// no-showDirectoryPicker path and only means anything in Firefox, so it runs
// from playwright.firefox.config.ts.
export default defineConfig({
  testDir: ".",
  testIgnore: [
    "**/emscripten.spec.ts",
    "**/agent.spec.ts",
    "**/model-cache.spec.ts",
    "**/mount-picker.spec.ts",
  ],
  timeout: 5 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  // One retry for a rare boot hang seen only on CI (~2 in 48 boots, both
  // runtimes) that has never reproduced locally, including at 2.5x CPU
  // oversubscription. A retried boot carries the worker's stall reports in the
  // failure message, so a real regression still fails twice and says why.
  retries: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "bun web/serve.ts",
    cwd: "../..",
    port: 8080,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
