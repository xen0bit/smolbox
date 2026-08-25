import { expect, test } from "@playwright/test";

// The other half of web/coi-serviceworker.js.
//
// That file exists for GitHub Pages, which cannot send COOP/COEP and so needs a
// service worker to add them. It ships in every build, including this one — so
// the thing worth pinning here is that it stays *dormant* when a real server
// already sends the headers. A worker that registered anyway would sit in front
// of every request in local development and in the container image, quietly
// serving whatever it had cached the last time these suites ran.

test("serve.ts isolates the page itself, and the fallback stays out of the way", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  // Registration is skipped, not merely ineffective: the script checks
  // crossOriginIsolated before it asks for anything.
  const registrations = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).length,
  );
  expect(registrations).toBe(0);
});

test("the agent page reaches the same conclusion one directory down", async ({ page }) => {
  await page.goto("/agent/?model=fake");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
});
