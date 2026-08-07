import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMount, mountFixturePath, walkFixture, type SmolboxGlobal } from "./harness.ts";

// The landing page's terminal, driven the way a person drives it — through the
// input, not through window.__smolbox. Everything else in this suite goes
// through the hook, so nothing else would notice the page losing its UI.

const mountFixture = await walkFixture(mountFixturePath);

async function open(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as SmolboxGlobal).__smolbox));
  return page.locator(".term-input");
}

async function run(input: Locator, cmd: string): Promise<void> {
  await input.fill(cmd);
  await input.press("Enter");
}

test("boots on the first command and runs it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const input = await open(page);
  await run(input, "uname -a");

  // The first command pays for the boot, which pulls 113 MB of wasm cold.
  await expect(page.locator(".term-note").filter({ hasText: "ready" })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator(".term-out")).toContainText("Linux");
  expect(errors).toEqual([]);
});

test("the prompt follows the guest's working directory", async ({ page }) => {
  const input = await open(page);

  // cd runs in a shell the guest spawned, so the page cannot infer the result —
  // it reads it back over OpInfo. If that ever regresses the prompt silently
  // lies, which is worse than it looking broken.
  await run(input, "cd /tmp");
  await expect(page.locator(".term-ps1")).toHaveText("/tmp $", { timeout: 240_000 });

  await run(input, "pwd");
  await expect(page.locator(".term-out").last()).toHaveText("/tmp");
});

test("reports a non-zero exit and keeps going", async ({ page }) => {
  const input = await open(page);

  await run(input, "false");
  await expect(page.locator(".term-note").filter({ hasText: "exit 1" })).toBeVisible({ timeout: 240_000 });

  await run(input, "echo still here");
  await expect(page.locator(".term-out").last()).toHaveText("still here");
});

test("arrow keys walk the history", async ({ page }) => {
  const input = await open(page);
  await run(input, "echo one");
  await expect(page.locator(".term-out").last()).toHaveText("one", { timeout: 240_000 });
  await run(input, "echo two");
  await expect(page.locator(".term-out").last()).toHaveText("two");

  await input.press("ArrowUp");
  await expect(input).toHaveValue("echo two");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("echo one");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("echo two");
});

test("Ctrl+L clears the scrollback but not the prompt", async ({ page }) => {
  const input = await open(page);
  await run(input, "echo scrollback");
  await expect(page.locator(".term-out").last()).toHaveText("scrollback", { timeout: 240_000 });

  await input.press("Control+l");
  await expect(page.locator(".term-line")).toHaveCount(0);
  await expect(page.locator(".term-prompt")).toBeVisible();
});

test("reads the mounted folder", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as SmolboxGlobal).__smolbox));
  await installMount(page, mountFixture, "__smolbox");

  const input = page.locator(".term-input");
  await run(input, "cat /mnt/host/hello.txt");
  await expect(page.locator(".term-out").last()).toHaveText("hello from the mount", { timeout: 240_000 });
});
