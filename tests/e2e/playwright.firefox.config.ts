import { defineConfig, devices } from "@playwright/test";

// The cross-browser mount suite. Firefox is the browser without
// showDirectoryPicker, so it is where the <input webkitdirectory> fallback is
// real; everything else in tests/e2e stays on Chromium (the WASI config
// testIgnores this spec) rather than paying for a second full run.
export default defineConfig({
  testDir: ".",
  testMatch: "**/mount-picker.spec.ts",
  timeout: 5 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Firefox"],
    browserName: "firefox",
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
