// The GPU path, asserted down to what does not depend on the model's judgement.
//
// agent.spec.ts asks a real model to list a real folder and checks that the
// output contains `hello.txt` — which is the right assertion for that suite and
// the wrong one for this one, because it is a claim about the model rather than
// about this project's code. A small checkpoint that emits a perfect tool call
// and then runs `ls` on `/` instead of the path it was given fails it (PLAN
// §10.20 records exactly that, twice), and a lane that is red for a reason
// nobody can fix is a lane nobody reads.
//
// So everything here is a claim about the code under test: the worker loads, the
// VM boots, the chat template carries the tool schema, the dialect parses what
// comes back, the call crosses into the guest, a result comes back through the
// protocol, and the loop feeds it to a second turn that produces prose. Which
// command the model picked is not this file's business.
//
// It runs on the smallest entry in the registry for that reason — the model only
// has to be well-formed, not good — which is what makes this ~20 s instead of
// ~15 minutes. See playwright.agent-smoke.config.ts.

import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { installMount, walkFixture, type FixtureNode } from "./harness.ts";

const enabled = process.env.SMOLBOX_WEBGPU === "1";
const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));
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
    close(timeoutMs?: number): Promise<void>;
  };
};

test.skip(!enabled, "set SMOLBOX_WEBGPU=1 to run the agent against a real model (needs a GPU and `make model`)");

test("the whole GPU path works end to end, whatever the model decides to run", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(m.text().slice(0, 500)));

  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));

  const gpu = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.webgpu());
  expect(gpu.available, "navigator.gpu missing — is this a secure context?").toBe(true);
  expect(gpu.adapter, "no WebGPU adapter; see launch flags in the config").toBe(true);

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

    // Printed whether or not it passes: when a model makes no call, what it said
    // instead IS the finding, and a dialect mismatch, a refusal and an empty
    // completion all fail the next assertion identically.
    console.log(
      `\n--- events ---\n${events
        .map((e) => `${e.kind}: ${JSON.stringify(e.raw ?? e.text ?? e.message ?? e.call ?? "").slice(0, 400)}`)
        .join("\n")}\n`,
    );

    // A parseable call reached the registry. This is the chat template, the tool
    // schema and the dialect, all three.
    const toolEnds = events.filter((e) => e.kind === "tool-end");
    expect(toolEnds.length, "model made no tool call — see the events above").toBeGreaterThan(0);
    const step = toolEnds[0]!;
    expect(step.call!.name).toBe("run_terminal_command");
    expect(typeof step.call!.args.cmd).toBe("string");

    // It crossed into a real guest and a real result came back. NOT which
    // result: `ls /` is a working round trip and a bad idea, and only one of
    // those is this file's problem.
    expect(step.exitCode, `the guest refused \`${String(step.call!.args.cmd)}\``).toBe(0);
    expect((step.rendered ?? "").length, "tool result was empty").toBeGreaterThan(0);

    // And the loop fed that back for a second turn that produced prose, which is
    // the half that a device loss or a poisoned session takes out.
    const answer = events.filter((e) => e.kind === "assistant").at(-1);
    expect(answer?.text?.length ?? 0, "no answer after the tool result went back").toBeGreaterThan(0);

    // Nothing may have gone wrong quietly along the way.
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.map((e) => e.message ?? "")).toEqual([]);

    console.log(`\ncmd: ${JSON.stringify(step.call!.args)}\nanswer: ${answer?.text?.slice(0, 300)}\n`);
  } catch (err) {
    throw new Error(`${String(err)}\n\n--- page console (last 40) ---\n${log.slice(-40).join("\n")}`);
  } finally {
    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.close()).catch(() => undefined);
  }
});
