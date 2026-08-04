import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// The emscripten (--to-js) suite, split out because it needs dist/js (built by
// `make wasm-js`) rather than dist/smolbox.wasm. Same server, same browser.
// The per-test budget is larger than the WASI suite's because this runtime is
// slower on every axis (harness.ts EMSCRIPTEN_{BOOT,EXEC}_TIMEOUT_MS). Keep it
// above those budgets so a genuinely stuck call fails with the session's own
// message rather than an opaque Playwright timeout.
//
// One retry, unlike the WASI suite: a live VM here burns ~2.4 CPU cores against
// a 4-vCPU shared runner, so a boot can lose a scheduling race that says nothing
// about the code. A real regression still fails twice and is still reported.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/emscripten.spec.ts"],
  timeout: 12 * 60 * 1000,
  retries: 1,
});
