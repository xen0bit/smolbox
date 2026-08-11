// `:get` — a file leaving the VM, driven the way a person drives it.
//
// The unit tests (web/src/export.test.ts) cover the chunk arithmetic against a
// scripted session. What they cannot cover is the part that is only true in a
// browser against a real guest: that `dd | base64` through the response frame
// preserves every byte, that the download the browser writes is the file the
// guest hashed, and that a file spanning several chunks reassembles in order.
//
// So the fixture is 1.2 MB of every byte value in sequence — binary, larger
// than one chunk, and self-describing about any offset error — and the
// assertion is a hash comparison rather than a glance at the text.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { boot, type SmolboxGlobal } from "./harness.ts";

const BLOB = "/tmp/blob";
// 256 × 4800 = 1,228,800 bytes: two full 512 KiB chunks and a 180 KiB
// remainder, so both the full-chunk and the ragged-tail paths run. Written by
// the guest's own python3, which is also the first thing here that uses it.
const MAKE_BLOB = `python3 -c "open('${BLOB}','wb').write(bytes(range(256))*4800)"`;

test("`:get` downloads a multi-chunk binary file byte for byte", async ({ page }) => {
  const vm = await boot(page);

  expect((await vm.exec({ op: "exec", cmd: MAKE_BLOB })).exit_code).toBe(0);

  const hashed = await vm.exec({ op: "exec", cmd: `sha256sum ${BLOB}` });
  const guestSha = hashed.stdout.trim().split(/\s+/)[0]!;
  expect(guestSha).toMatch(/^[0-9a-f]{64}$/);

  const input = page.locator(".term-input");
  await input.fill(`:get ${BLOB}`);
  const [download] = await Promise.all([page.waitForEvent("download"), input.press("Enter")]);

  expect(download.suggestedFilename()).toBe("blob");
  const path = await download.path();
  const bytes = await readFile(path);
  expect(bytes.length).toBe(256 * 4800);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(guestSha);
  // Not just the right hash — the right bytes in the right places, which is
  // what a chunk read at the wrong offset breaks.
  expect(bytes[0]).toBe(0);
  expect(bytes[255]).toBe(255);
  expect(bytes[600_000]).toBe(600_000 % 256);

  // The page says it checked, and it checked against the guest's own hash.
  await expect(page.locator(".term-note").filter({ hasText: guestSha })).toBeVisible();
});

test("`:get` on a directory says what to do instead", async ({ page }) => {
  await boot(page);

  const input = page.locator(".term-input");
  await input.fill(":get /tmp");
  await input.press("Enter");

  await expect(page.locator(".term-err").filter({ hasText: "is a directory" })).toBeVisible({
    timeout: 240_000,
  });
});

test(":help lists the page's own commands without touching the guest", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as SmolboxGlobal).__smolbox));

  const input = page.locator(".term-input");
  await input.fill(":help");
  await input.press("Enter");

  // No boot: :help is answered before the VM is asked for, which is the point
  // of it being the one builtin that does not need a session.
  await expect(page.locator(".term-note").filter({ hasText: ":get <path>" }).first()).toBeVisible();
  await expect(page.locator(".term-note").filter({ hasText: "booting…" })).toHaveCount(0);
});
