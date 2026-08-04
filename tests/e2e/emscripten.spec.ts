// The emscripten (--to-js) driver: the third runtime over the shared
// tests/conformance/cases.json, after the Go/wazero driver and the WASI browser
// driver. This build runs the same guest under QEMU with JIT instead of Bochs
// under browser_wasi_shim, and reuses the whole framed protocol stack — only
// the console transport differs (Module['pty'] instead of a patched fd_read).
//
// It has no host mount (upstream scopes directory sharing to the WASI target),
// so the cases tagged `requires: ["mount"]` are skipped and the no-mount
// contract is pinned by its own case below.

import { expect, test } from "@playwright/test";
import { bootJs, checkExpect, loadCases } from "./harness.ts";

const cases = (await loadCases()).filter((c) => !c.requires?.includes("mount"));

test("boots the VM and runs echo hello", async ({ page }) => {
  const handle = await bootJs(page);
  const resp = await handle.exec({ op: "exec", cmd: "echo hello" });
  expect(resp.exit_code).toBe(0);
  expect(resp.stdout).toBe("hello\n");
  await handle.close();
});

test("/mnt/host is empty: the emscripten build has no host mount", async ({ page }) => {
  const handle = await bootJs(page);
  const ls = await handle.exec({ op: "exec", cmd: "ls -A /mnt/host" });
  expect(ls.exit_code).toBe(0);
  expect(ls.stdout).toBe("");
  await handle.close();
});

for (const c of cases) {
  test(`conformance: ${c.name}`, async ({ page }) => {
    const handle = await bootJs(page);
    const diffs: string[] = [];
    for (const step of c.steps) {
      const resp = await handle.exec({ op: "exec", ...step.request });
      diffs.push(...checkExpect(step.expect, resp));
    }
    expect(diffs).toEqual([]);
    await handle.close();
  });
}
