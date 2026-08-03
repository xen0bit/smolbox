import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 5 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
