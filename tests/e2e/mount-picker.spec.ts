import { expect, test } from "@playwright/test";
import { attach, mountFixturePath, pickHostFolder } from "./harness.ts";

// The cross-browser mount. Firefox (and Safari) have no showDirectoryPicker, so
// web/src/mount.ts falls back to <input type="file" webkitdirectory> and
// mount-tree.ts rebuilds a directory handle from the flat FileList. Everything
// below that — MountHost, the SAB bridge, the guest — is the same code the
// Chromium suite runs, so this asserts the one thing that differs: a folder
// chosen through the real dialog reaches the guest.
//
// This is the only suite that runs in Firefox. It skips link.txt: a file input
// cannot report a symlink, so the virtual-link table has nothing to carry (the
// OPFS suite covers that path).

test("a folder picked without showDirectoryPicker mounts at /mnt/host", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__smolbox));

  expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>).showDirectoryPicker)).toBe(
    "undefined",
  );

  await pickHostFolder(page, mountFixturePath);
  const handle = await attach(page);

  const ls = await handle.exec({ op: "exec", cmd: "ls -1 /mnt/host" });
  expect(ls.exit_code).toBe(0);
  expect(ls.stdout).toBe("hello.txt\nsub\n");

  const cat = await handle.exec({ op: "exec", cmd: "cat /mnt/host/hello.txt" });
  expect(cat.exit_code).toBe(0);
  expect(cat.stdout).toBe("hello from the mount\n");

  const nested = await handle.exec({ op: "exec", cmd: "cat /mnt/host/sub/nested.txt" });
  expect(nested.exit_code).toBe(0);
  expect(nested.stdout).toBe("nested fixture\n");

  const write = await handle.exec({ op: "exec", cmd: "touch /mnt/host/nope" });
  expect(write.exit_code).not.toBe(0);

  await handle.close();
});
