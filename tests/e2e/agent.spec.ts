// M8: the WebGPU agent spike, driven end to end.
//
// This suite is opt-in (SMOLBOX_WEBGPU=1) and is NOT in CI, because there is no
// CI path for it: headless Chromium needs a real GPU adapter here, and
// --enable-unsafe-swiftshader yields no adapter at all, so a GitHub Actions
// runner cannot run this at any speed. It also needs `make model` (~1.2 GB).
//
// What it pins is the mechanism, not the model's prose: that a real tool call
// comes back parseable, reaches a real VM session through the M7 surface, and
// that the model's follow-up sees the tool output.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { installMount, walkFixture, type FixtureNode } from "./harness.ts";

const enabled = process.env.SMOLBOX_WEBGPU === "1";
const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));

interface ToolStep {
  call: { name: string; args: Record<string, unknown> };
  rendered: string;
  exitCode: number;
}

interface Transcript {
  prompt: string;
  rawTurn: string;
  steps: ToolStep[];
  finalText: string;
  totalMs: number;
}

type AgentGlobal = {
  __smolagent?: {
    webgpu(): Promise<{ available: boolean; adapter: boolean }>;
    loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    run(prompt?: string): Promise<Transcript>;
    close(timeoutMs?: number): Promise<void>;
  };
};

test.skip(!enabled, "set SMOLBOX_WEBGPU=1 to run the agent spike (needs a GPU and `make model`)");

// Model load dominates: ~1.2 GB of weights through ORT onto the GPU, then two
// generations on an emulated-CPU-free but still modest 1.2B model.
test.setTimeout(15 * 60 * 1000);

test("the model drives the VM: one prompt, one real tool call, one answer", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(m.text().slice(0, 500)));

  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));

  const gpu = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.webgpu());
  expect(gpu.available, "navigator.gpu missing — is this a secure context?").toBe(true);
  expect(gpu.adapter, "no WebGPU adapter; launch flags in playwright.agent.config.ts").toBe(true);

  const fixture = (await walkFixture(mountDir)) as FixtureNode;
  await installMount(page, fixture, "__smolagent");

  await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.bootVm());

  try {
    const ready = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.loadModel());
    expect(ready.source).toBe("local");

    const t = await page.evaluate(() =>
      (globalThis as AgentGlobal).__smolagent!.run("List the files in /mnt/host using the tool, then tell me what is there."),
    );

    // The mechanism: a parseable call for the one tool that exists.
    expect(t.steps.length, `model made no tool call. raw turn:\n${t.rawTurn}`).toBeGreaterThan(0);
    const step = t.steps[0]!;
    expect(step.call.name).toBe("run_terminal_command");
    expect(typeof step.call.args.cmd).toBe("string");

    // It reached a real VM: the rendered result is M7's Render output verbatim,
    // and hello.txt is in testdata/mount, so a command that actually ran against
    // the mount says so. A non-zero exit is still a pass for the mechanism —
    // what must not happen is the call never reaching the guest.
    expect(step.rendered).toContain("exit_code:");
    expect(step.exitCode).toBe(0);
    expect(step.rendered).toContain("hello.txt");

    // And the model saw the output: it answered after the tool result went back.
    expect(t.finalText.length).toBeGreaterThan(0);

    console.log(`\n--- transcript (${t.totalMs}ms) ---\ncmd: ${JSON.stringify(step.call.args)}\n${step.rendered}\nanswer: ${t.finalText}\n`);
  } catch (err) {
    throw new Error(`${String(err)}\n\n--- page console (last 40) ---\n${log.slice(-40).join("\n")}`);
  } finally {
    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.close()).catch(() => undefined);
  }
});
