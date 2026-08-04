import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// The emscripten (--to-js) suite, split out because it needs dist/js (built by
// `make wasm-js`) rather than dist/smolbox.wasm. Same server, same browser.
// The per-test budget is larger than the WASI suite's because this runtime's
// console is ~10x slower (harness.ts EMSCRIPTEN_EXEC_TIMEOUT_MS). Keep it above
// that exec budget so a genuinely stuck call fails with the session's own
// message rather than an opaque Playwright timeout.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/emscripten.spec.ts"],
  timeout: 10 * 60 * 1000,
});
