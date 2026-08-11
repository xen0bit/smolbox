// The agent page's status strip and its console, against a real VM and the
// scripted model — the same GPU-free arrangement as chat.spec.ts.
//
// The claim worth testing is not that a terminal renders. It is that the
// console and the model are on ONE session: a file the agent writes is a file
// the console can read back, because there is one VM and one Session behind
// both. If that ever became two, every test in chat.spec.ts would still pass.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { BOOT_TIMEOUT_MS, installMount, walkFixture, type FixtureNode } from "./harness.ts";

const scriptsPath = fileURLToPath(new URL("../agent/scripts.json", import.meta.url));
const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));

type AgentGlobal = {
  __smolagent?: {
    useFake(scripts: unknown[]): void;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    loadModel(local?: boolean): Promise<{ source: string }>;
    send(text: string): Promise<unknown[]>;
    close(timeoutMs?: number): Promise<void>;
  };
};

async function openPage(page: Page): Promise<void> {
  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));
}

async function useFakeModel(page: Page): Promise<void> {
  const scripts = JSON.parse(await readFile(scriptsPath, "utf8")).scripts as unknown[];
  await page.evaluate((s) => (globalThis as AgentGlobal).__smolagent!.useFake(s), scripts);
}

async function openConsole(page: Page) {
  await page.locator("#console-panel > summary").click();
  return page.locator("#console-panel .term-input");
}

test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => (globalThis as AgentGlobal).__smolagent?.close(10_000))
    .catch(() => undefined);
});

test("each chip follows its own half", async ({ page }) => {
  await openPage(page);

  // The VM chip may already say "downloading": the worker starts fetching the
  // wasm the moment the page loads, without waiting for anyone to press start.
  // The other two have not been asked for anything yet.
  await expect(page.locator("#chip-vm")).toHaveAttribute("data-state", /idle|loading/);
  await expect(page.locator("#chip-model")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#chip-folder")).toHaveAttribute("data-state", "idle");

  const fixture = (await walkFixture(mountDir)) as FixtureNode;
  await installMount(page, fixture, "__smolagent");
  // The folder is up while the other two are not, which is the whole reason
  // there are three chips rather than one status line.
  await expect(page.locator("#chip-folder")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#chip-vm")).not.toHaveAttribute("data-state", "ready");

  await page.evaluate((t) => (globalThis as AgentGlobal).__smolagent!.bootVm(t), BOOT_TIMEOUT_MS);
  await expect(page.locator("#chip-vm")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#chip-vm")).toContainText("agent v");
  // A VM is up and there is still no model, which the old single status line
  // could not say.
  await expect(page.locator("#chip-model")).toHaveAttribute("data-state", "idle");
});

test("a command typed in the console boots the VM and updates the chip", async ({ page }) => {
  await openPage(page);
  const input = await openConsole(page);

  await input.fill("uname -a");
  await input.press("Enter");

  await expect(page.locator("#console-panel .term-out")).toContainText("Linux", { timeout: 240_000 });
  // Boot went through the page's own bootVm, so the chip knows about a VM it
  // did not start itself.
  await expect(page.locator("#chip-vm")).toHaveAttribute("data-state", "ready");
});

test("the console and the model share one VM", async ({ page }) => {
  await openPage(page);
  await useFakeModel(page);
  await page.evaluate((t) => (globalThis as AgentGlobal).__smolagent!.bootVm(t), BOOT_TIMEOUT_MS);
  await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.loadModel());

  await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.send("leave me a file"));

  const input = await openConsole(page);
  await input.fill("cat /tmp/from-agent");
  await input.press("Enter");

  // Written by the agent's tool call, read back by a command typed into the
  // console: one guest, one session, one /tmp.
  await expect(page.locator("#console-panel .term-out")).toContainText("agent-was-here", {
    timeout: 240_000,
  });
});

test("the console's working directory is the one the agent's next command inherits", async ({ page }) => {
  await openPage(page);
  const input = await openConsole(page);

  await input.fill("cd /tmp");
  await input.press("Enter");
  // The prompt reads the cwd back from the guest rather than guessing it, so a
  // prompt saying /tmp is the guest agreeing that it moved.
  await expect(page.locator("#console-panel .term-ps1")).toHaveText("/tmp $", { timeout: 240_000 });
});
