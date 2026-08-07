import { defineConfig, devices } from "@playwright/test";

// The M8 agent spike, plus the weight-cache round trip. Its own config because
// these need launch flags the other suites do not, and because they must never
// run by accident: they want a real GPU and gigabytes of local weights.
//
// The flags are the minimum that yields a real adapter in headless Chromium
// (measured at M8): with neither, requestAdapter() returns null, and
// --enable-unsafe-swiftshader does NOT provide a software fallback — there is no
// adapter-less path to WebGPU here. WebGPU also requires a secure context, which
// http://localhost satisfies.
export default defineConfig({
  testDir: ".",
  testMatch: ["**/agent.spec.ts", "**/model-cache.spec.ts"],
  timeout: 15 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  // No retry: a 15-minute run whose cost is dominated by loading 1.2 GB onto the
  // GPU should fail once and be looked at, not silently doubled.
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
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
