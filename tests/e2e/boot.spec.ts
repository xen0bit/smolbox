import { expect, test } from "@playwright/test";
import { boot, mountFixturePath, walkFixture } from "./harness.ts";

// M4 done-criteria live here: a real browser boots dist/smolbox.wasm and runs
// the framed protocol. The M5 mount smoke uses the real sync bridge against an
// OPFS directory that mirrors testdata/mount, with the fixture's symlink
// carried through the bridge's virtual symlink table.

const mountFixture = await walkFixture(mountFixturePath);

test("boots the VM and runs echo hello", async ({ page }) => {
  const handle = await boot(page);
  const resp = await handle.exec({ op: "exec", cmd: "echo hello" });
  expect(resp.exit_code).toBe(0);
  expect(resp.stdout).toBe("hello\n");
  await handle.close();
});

test("the sync bridge mount: the guest reads an OPFS directory at /mnt/host", async ({ page }) => {
  const handle = await boot(page, mountFixture);

  const cat = await handle.exec({ op: "exec", cmd: "cat /mnt/host/hello.txt" });
  expect(cat.exit_code).toBe(0);
  expect(cat.stdout).toBe("hello from the mount\n");

  const ls = await handle.exec({ op: "exec", cmd: "ls -1 /mnt/host" });
  expect(ls.exit_code).toBe(0);
  expect(ls.stdout).toBe("hello.txt\nlink.txt\nsub\n");

  const nested = await handle.exec({ op: "exec", cmd: "cat /mnt/host/sub/nested.txt" });
  expect(nested.exit_code).toBe(0);
  expect(nested.stdout).toBe("nested fixture\n");

  const link = await handle.exec({ op: "exec", cmd: "cat /mnt/host/link.txt" });
  expect(link.exit_code).toBe(0);
  expect(link.stdout).toBe("hello from the mount\n");

  await handle.close();
});
