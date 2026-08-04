// The browser conformance driver: runs the SAME tests/conformance/cases.json
// that the Go/wazero driver runs, through the page's window.__smolbox hook with
// an OPFS-backed mount. M5's done-when is "browser passes the same conformance
// table as Go" — this file is the browser half of that guarantee.
//
// Each case boots a fresh session (a fresh page -> fresh worker -> fresh VM),
// mirroring the Go driver's per-case boot so state never leaks between cases.
// The mount fixture is walked from testdata/mount on the Node side and rebuilt
// in OPFS, with its real symlink presented through the bridge's virtual
// symlink table — the same bytes the Go driver mounts.

import { expect, test } from "@playwright/test";
import { boot, checkExpect, loadCases, mountFixturePath, walkFixture } from "./harness.ts";

const cases = await loadCases();
const mountFixture = await walkFixture(mountFixturePath);

for (const c of cases) {
  test(`conformance: ${c.name}`, async ({ page }) => {
    const handle = await boot(page, mountFixture);
    const diffs: string[] = [];
    for (const step of c.steps) {
      const resp = await handle.exec({ op: "exec", ...step.request });
      diffs.push(...checkExpect(step.expect, resp));
    }
    expect(diffs).toEqual([]);
    await handle.close();
  });
}
