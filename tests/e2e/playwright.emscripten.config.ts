import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// The emscripten (--to-js) suite, split out because it needs dist/js (built by
// `make wasm-js`) rather than dist/smolbox.wasm. Same server, same browser.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["**/emscripten.spec.ts"],
});
