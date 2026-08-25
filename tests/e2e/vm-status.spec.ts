import { expect, test } from "@playwright/test";
import { BOOT_TIMEOUT_MS } from "./harness.ts";

// Both pages tell you what the VM is doing while it comes up, and both of them
// used to stop telling you the moment the download ended.
//
// The worker fetches ~150 MB, instantiates it and starts it, and the pages
// worked out which of those they were in by comparing the worker's log line
// against the string "fetching wasm". Nothing after that moved either display:
// the VM page's header froze on "booting the VM" — a message posted *before*
// wasi.start(), so a working VM's last word about itself was that it was still
// starting — and the agent page's chip froze on "downloading", because the only
// other thing that set it was bootVm(), whose only caller is the start button.
//
// What both tests turn on is that nobody touches the page. The worker boots the
// VM on its own, so a display that needs a command typed or a button pressed
// before it catches up is the bug, not the fix.

test("the VM page's header ends at ready, with nothing typed into it", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toContainText("ready (agent v", {
    timeout: BOOT_TIMEOUT_MS,
  });
  // The regression in one line: the phase before the last one must not be the
  // one left on screen.
  await expect(page.locator("#status")).not.toContainText("booting the VM");
  // And the bar that fronted the download is gone rather than sitting full.
  await expect(page.locator("#wasm-progress")).toBeHidden();

  await page.evaluate(() =>
    (globalThis as { __smolbox?: { close(t: number): Promise<void> } }).__smolbox?.close(10_000),
  ).catch(() => undefined);
});

test("the VM page's header holds both facts at once", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("ready (agent v", {
    timeout: BOOT_TIMEOUT_MS,
  });

  // Mounting a folder used to overwrite the header, which is how a page that
  // knew the VM was up could go back to saying nothing about it.
  await page.evaluate(() =>
    (globalThis as { __smolbox?: { setMount(h: null): void } }).__smolbox?.setMount(null),
  );
  await expect(page.locator("#status")).toContainText("mount: none");
  await expect(page.locator("#status")).toContainText("ready (agent v");
});

test("the agent page's VM chip reaches ready without the start button", async ({ page }) => {
  // No ?model=fake: that swaps in a scripted model and marks it ready, and the
  // point here is the VM chip moving while the model chip has been asked for
  // nothing at all.
  await page.goto("/agent/");

  await expect(page.locator("#chip-vm")).toHaveAttribute("data-state", "ready", {
    timeout: BOOT_TIMEOUT_MS,
  });
  await expect(page.locator("#chip-vm")).toContainText("agent v");
  // "downloading" is what it used to be stuck on, and the download is long over.
  await expect(page.locator("#chip-vm")).not.toContainText("downloading");
  await expect(page.locator("#progress-row")).toBeHidden();

  // The model is a separate fact and nobody has asked for it, which is why
  // there are three chips.
  await expect(page.locator("#chip-model")).toHaveAttribute("data-state", "idle");

  await page.evaluate(() =>
    (globalThis as { __smolagent?: { close(t: number): Promise<void> } }).__smolagent?.close(10_000),
  ).catch(() => undefined);
});
