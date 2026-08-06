// The agent against the REAL model on WebGPU.
//
// Opt-in (SMOLBOX_WEBGPU=1) and NOT in CI, because there is no CI path for it:
// headless Chromium needs a real GPU adapter here and --enable-unsafe-swiftshader
// yields none, so a runner cannot run this at any speed. It also needs
// `make model` (~1.2 GB).
//
// chat.spec.ts covers the same loop against a scripted model and DOES run in CI.
// What only this file can prove is that a real model, fed the generated tool
// schema through the real chat template, emits something the parser understands.

import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { installMount, walkFixture, type FixtureNode } from "./harness.ts";

const enabled = process.env.SMOLBOX_WEBGPU === "1";
const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));
// Which registry entry to drive. The default is what `make model` pulls; any
// other key needs its own `make model MODEL=<key>` first. This is how a new
// entry gets taken through the same loop as the ones already trusted, rather
// than being trusted because its unit tests pass.
const modelKey = process.env.SMOLBOX_MODEL;

interface AgentEvent {
  kind: string;
  text?: string;
  raw?: string;
  message?: string;
  rendered?: string;
  exitCode?: number;
  call?: { name: string; args: Record<string, unknown> };
}

type AgentGlobal = {
  __smolagent?: {
    webgpu(): Promise<{ available: boolean; adapter: boolean }>;
    setModel(key: string): void;
    loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    send(text: string): Promise<AgentEvent[]>;
    messages(): { role: string; content: string }[];
    close(timeoutMs?: number): Promise<void>;
  };
};

test.skip(!enabled, "set SMOLBOX_WEBGPU=1 to run the agent against a real model (needs a GPU and `make model`)");

// Model load dominates: ~1.2 GB of weights through ORT onto the GPU.
test.setTimeout(15 * 60 * 1000);

test("a real model on WebGPU drives the VM and answers from what it read", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(m.text().slice(0, 500)));

  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));

  const gpu = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.webgpu());
  expect(gpu.available, "navigator.gpu missing — is this a secure context?").toBe(true);
  expect(gpu.adapter, "no WebGPU adapter; see launch flags in playwright.agent.config.ts").toBe(true);

  const fixture = (await walkFixture(mountDir)) as FixtureNode;
  await installMount(page, fixture, "__smolagent");
  await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.bootVm());

  try {
    if (modelKey) {
      await page.evaluate((key) => (globalThis as AgentGlobal).__smolagent!.setModel(key), modelKey);
    }
    const ready = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.loadModel());
    expect(ready.source).toBe("local");
    console.log(`loaded ${modelKey ?? "the default entry"} in ${(ready.loadMs / 1000).toFixed(1)}s`);

    const events = await page.evaluate(() =>
      (globalThis as AgentGlobal).__smolagent!.send(
        "List the files in /mnt/host using the tool, then tell me what is there.",
      ),
    );

    // Printed whether or not the run passes. When a model makes no call, what it
    // said instead IS the finding — a dialect whose markers do not match, a
    // refusal, an empty completion and a loop that hung all fail the assertion
    // below identically and are different bugs. Only the raw text separates them.
    console.log(
      `\n--- events ---\n${events
        .map((e) => `${e.kind}: ${JSON.stringify(e.raw ?? e.text ?? e.message ?? e.call ?? "").slice(0, 600)}`)
        .join("\n")}\n`,
    );

    const toolEnds = events.filter((e) => e.kind === "tool-end");
    expect(toolEnds.length, "model made no tool call — see the events above").toBeGreaterThan(0);

    const step = toolEnds[0]!;
    expect(step.call!.name).toBe("run_terminal_command");
    expect(typeof step.call!.args.cmd).toBe("string");
    // It reached a real guest and read the real mount.
    expect(step.exitCode).toBe(0);
    expect(step.rendered).toContain("hello.txt");

    // And it answered after the tool result went back.
    const answer = events.filter((e) => e.kind === "assistant").at(-1);
    expect(answer?.text?.length ?? 0).toBeGreaterThan(0);

    console.log(
      `\n--- transcript ---\ncmd: ${JSON.stringify(step.call!.args)}\n${step.rendered}\nanswer: ${answer?.text}\n`,
    );
  } catch (err) {
    throw new Error(`${String(err)}\n\n--- page console (last 40) ---\n${log.slice(-40).join("\n")}`);
  } finally {
    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.close()).catch(() => undefined);
  }
});
