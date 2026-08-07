// Reads bigger than the bridge's request region, end to end in the browser.
//
// testdata/mount holds only tiny files, so every other mount suite reads well
// under BRIDGE_MAX_REQUEST (64 KiB of envelope). That hid a real crash: the
// main thread serialized the READ payload into the JSON envelope as well as
// into the SAB payload window, and JSON.stringify turns a Uint8Array into
// {"0":83,"1":69,...} — ~10 bytes per file byte. Any single read past ~7 KiB
// overflowed the region, respond() threw RangeError, and the guest sat in
// Atomics.wait until "fsbridge: read timed out waiting for the main thread".
//
// This fixture is synthesized rather than added to testdata/mount so the shared
// conformance table and its directory-listing expectations stay untouched.

import { expect, test } from "@playwright/test";
import { boot, type FixtureNode } from "./harness.ts";

const LINE = "SELECT count(*) FROM forecasts WHERE horizon_hours = 12;\n";
const LINES = 4096; // ~229 KB: past the 64 KiB envelope and the 7 KiB cliff alike
const BIG = LINE.repeat(LINES);

const fixture: FixtureNode = {
  kind: "dir",
  children: {
    "forecaster-12-14-19.sql": { kind: "file", content: BIG },
    "small.txt": { kind: "file", content: "still fine\n" },
  },
};

test("a file larger than the bridge request region reads whole", async ({ page }) => {
  const handle = await boot(page, fixture);

  const wc = await handle.exec({ op: "exec", cmd: "wc -c -l < /mnt/host/forecaster-12-14-19.sql" });
  expect(wc.exit_code).toBe(0);
  expect(wc.stdout.trim().split(/\s+/)).toEqual([String(LINES), String(BIG.length)]);

  // cat pulls the whole file through the bridge in the guest's own read sizes.
  const cat = await handle.exec({ op: "exec", cmd: "cat /mnt/host/forecaster-12-14-19.sql | cksum" });
  expect(cat.exit_code).toBe(0);
  const direct = await handle.exec({ op: "exec", cmd: "cksum < /mnt/host/forecaster-12-14-19.sql" });
  expect(direct.stdout.split(" ")[0]).toBe(cat.stdout.split(" ")[0]);

  // The bridge must still serve the next request: a throw used to leave the
  // channel stuck mid-transaction, so everything after it timed out too.
  const after = await handle.exec({ op: "exec", cmd: "cat /mnt/host/small.txt" });
  expect(after.exit_code).toBe(0);
  expect(after.stdout).toBe("still fine\n");

  await handle.close();
});

test("a large mid-file seek and short read land on the right bytes", async ({ page }) => {
  const handle = await boot(page, fixture);

  // dd seeks past the first envelope-sized window, then reads one block.
  const dd = await handle.exec({
    op: "exec",
    cmd: "dd if=/mnt/host/forecaster-12-14-19.sql bs=1 skip=131072 count=56 2>/dev/null",
  });
  expect(dd.exit_code).toBe(0);
  expect(dd.stdout).toBe(BIG.slice(131072, 131072 + 56));

  await handle.close();
});
