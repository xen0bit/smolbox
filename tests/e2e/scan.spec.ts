// M14: the Antares localization page, driven end to end with a REAL VM and a
// SCRIPTED model.
//
// Same trick as chat.spec.ts and the same reason: a GPU-less runner can run
// every part of this except the matrix multiplication (PLAN §2.11.24). So the
// page, the localize loop, the tool profile, the host tools, the antares
// dialect and a real mounted tree all run exactly as they do on a GPU.
//
// The scripts here are the raw strings antares-1b actually emitted during M12
// (PLAN §11.10) — flattened arguments and all.

import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { BOOT_TIMEOUT_MS, installMount, walkFixture, type FixtureNode } from "./harness.ts";

const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));

interface ScanEvent {
  kind: string;
  text?: string;
  message?: string;
  reason?: string;
  rendered?: string;
  exitCode?: number;
  remaining?: number;
  call?: { name: string; args: Record<string, unknown> };
}

interface ScanResult {
  submitted: boolean;
  findings: { path: string; rank: number }[];
  rejected: string[];
  terminalCallsUsed: number;
  stoppedBecause: string;
}

type ScanGlobal = {
  __smolscan?: {
    useFake(scripts: unknown[]): void;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    scan(cwe: string, budget?: number): Promise<ScanResult>;
    events(): ScanEvent[];
    cancel(): void;
    close(timeoutMs?: number): Promise<void>;
  };
};

/** A <tool_call> with arguments FLATTENED, which is what antares-1b emits. */
const terminal = (command: string) =>
  `<tool_call>\n{"name": "terminal", "command": ${JSON.stringify(command)}}\n</tool_call>`;
const submit = (files: string[]) =>
  `<tool_call>\n{"name": "submit_vulnerable_files", "ranked_files": ${JSON.stringify(files)}}\n</tool_call>`;

async function open(page: import("@playwright/test").Page, turns: string[]) {
  await page.goto("/scan/");
  await page.waitForFunction(() => Boolean((globalThis as ScanGlobal).__smolscan));

  const fixture = (await walkFixture(mountDir)) as FixtureNode;
  await installMount(page, fixture, "__smolscan");

  await page.evaluate(
    (t) =>
      (globalThis as ScanGlobal).__smolscan!.useFake([
        { name: "localize", turns: (t as string[]).map((text) => ({ text })) },
      ]),
    turns,
  );
  await page.evaluate((t) => (globalThis as ScanGlobal).__smolscan!.bootVm(t), BOOT_TIMEOUT_MS);
}

const scan = (page: import("@playwright/test").Page, cwe = "CWE-89", budget?: number) =>
  page.evaluate(
    ([c, b]) => (globalThis as ScanGlobal).__smolscan!.scan(c as string, b as number | undefined),
    [cwe, budget] as const,
  );

const events = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (globalThis as ScanGlobal).__smolscan!.events());

test.describe("antares localization page", () => {
  test.afterEach(async ({ page }) => {
    await page
      .evaluate(() => (globalThis as ScanGlobal).__smolscan!.close(10_000))
      .catch(() => undefined);
  });

  test("explores the real mount and submits a file that exists", async ({ page }) => {
    await open(page, [terminal("ls /mnt/host"), submit(["hello.txt"])]);
    const result = await scan(page);

    expect(result.submitted).toBe(true);
    expect(result.findings.map((f) => f.path)).toEqual(["hello.txt"]);
    expect(result.terminalCallsUsed).toBe(1);

    // Real output, from the real mount, through the real sync bridge.
    const evs = await events(page);
    const toolEnd = evs.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.exitCode).toBe(0);
    expect(toolEnd.rendered).toContain("hello.txt");
    // The budget footer the model was trained to read (PLAN §11.1.13).
    expect(toolEnd.rendered).toContain("tool-calls remaining");

    // And it reached the page, not just the event stream.
    await expect(page.locator("#findings")).toContainText("hello.txt");
  });

  test("a hallucinated path is checked against the mount and dropped", async ({ page }) => {
    // The behaviour that matters most: at 0.135 File F1 this is routine output,
    // and an unverifiable path reads exactly like a real one.
    await open(page, [submit(["hello.txt", "src/invented.py"])]);
    const result = await scan(page);

    expect(result.findings.map((f) => f.path)).toEqual(["hello.txt"]);
    expect(result.rejected).toEqual(["src/invented.py"]);
    await expect(page.locator("#findings")).toContainText("did not exist");
  });

  test("grep -r works on the mount, which is what the prompt now steers to", async ({ page }) => {
    // find and rg do not traverse this mount (PLAN §11.11), so the working
    // recursive search has to keep working.
    await open(page, [terminal("grep -rn nested /mnt/host"), submit(["sub/nested.txt"])]);
    const result = await scan(page);

    const evs = await events(page);
    const toolEnd = evs.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.rendered).toContain("nested fixture");
    expect(result.findings.map((f) => f.path)).toEqual(["sub/nested.txt"]);
  });

  test("the terminal budget is enforced against a real session", async ({ page }) => {
    await open(page, [
      terminal("ls /mnt/host"),
      terminal("cat /mnt/host/hello.txt"),
      terminal("pwd"),
      submit([]),
    ]);
    const result = await scan(page, "CWE-22", 2);

    expect(result.terminalCallsUsed).toBe(2);
    const evs = await events(page);
    expect(evs.some((e) => e.kind === "nudge" && e.reason === "budget")).toBe(true);
  });

  test("submit_no_vulnerability_found is a real answer, not a failure", async ({ page }) => {
    await open(page, [`<tool_call>\n{"name": "submit_no_vulnerability_found"}\n</tool_call>`]);
    const result = await scan(page, "CWE-502");

    expect(result.submitted).toBe(true);
    expect(result.findings).toHaveLength(0);
    await expect(page.locator("#findings")).toContainText("no vulnerable files");
  });

  test("a model that never calls a tool is nudged and the run ends without a submission", async ({
    page,
  }) => {
    await open(page, Array(8).fill("I will inspect the repository for SQL injection."));
    const result = await scan(page);

    expect(result.submitted).toBe(false);
    const evs = await events(page);
    expect(evs.some((e) => e.kind === "nudge" && e.reason === "no-tool")).toBe(true);
    await expect(page.locator("#findings")).toContainText("No submission");
  });

  test("a finding shows the command that named it", async ({ page }) => {
    // PLAN §11.5: the trace is how a person checks a finding, so the evidence
    // has to reach the panel, not just the event stream.
    await open(page, [terminal("grep -rn nested /mnt/host"), submit(["sub/nested.txt"])]);
    await scan(page);

    const evidence = page.locator("#findings .evidence");
    await expect(evidence).toContainText("grep -rn nested /mnt/host");
    // And the matching output line, which is what makes it checkable.
    await expect(evidence).toContainText("nested fixture");
  });

  test("the readiness strip and run counters reflect real progress", async ({ page }) => {
    await open(page, [terminal("ls /mnt/host"), submit(["hello.txt"])]);
    // Booting and mounting happened in open(); the strip should already say so.
    await expect(page.locator("#step-vm")).toHaveAttribute("data-state", "done");
    await expect(page.locator("#step-folder")).toHaveAttribute("data-state", "done");
    await expect(page.locator("#step-model")).toHaveAttribute("data-state", "done");

    await scan(page, "CWE-89", 15);
    await expect(page.locator("#runbar")).toHaveAttribute("data-on", "1");
    await expect(page.locator("#calls")).toHaveText("1");
    await expect(page.locator("#calls-max")).toHaveText("15");
    await expect(page.locator("#phase")).toHaveText("submitted");
  });

  test("export is only offered once there is something to export", async ({ page }) => {
    await open(page, [submit(["hello.txt"])]);
    await expect(page.locator("#export")).toBeDisabled();
    await scan(page);
    await expect(page.locator("#export")).toBeEnabled();
  });

  test("the accuracy caveat is on the page, not buried", async ({ page }) => {
    // Part of the milestone's scope, not polish (PLAN §11.5): a clean ranked
    // list from this model reads like a scanner's output and is not one.
    await open(page, [submit([])]);
    const caveat = page.locator(".caveat");
    await expect(caveat).toBeVisible();
    // The benchmark number and the "not proof" framing, asserted by meaning
    // rather than exact wording — the copy should be free to improve, but not
    // free to drop either of these.
    await expect(caveat).toContainText("0.135");
    await expect(caveat).toContainText(/leads for review/i);
    await expect(caveat).toContainText(/not evidence|not proof/i);
  });
});
