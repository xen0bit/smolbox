// M9: the multi-turn chat loop, driven end to end with a REAL VM and a SCRIPTED
// model.
//
// This is the half of the agent that CI can reach. The model is
// FakeModelClient replaying tests/agent/scripts.json — raw model output, markers
// and all — so the dialect parser, the loop, the budgets, the history policy and
// the UI all run exactly as they do on a GPU. Only the matrix multiplication is
// missing, and that is the only part a runner cannot do (PLAN §2.11.24).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { BOOT_TIMEOUT_MS, installMount, walkFixture, type FixtureNode } from "./harness.ts";

const scriptsPath = fileURLToPath(new URL("../agent/scripts.json", import.meta.url));
const mountDir = fileURLToPath(new URL("../../testdata/mount", import.meta.url));

interface AgentEvent {
  kind: string;
  text?: string;
  message?: string;
  reason?: string;
  rendered?: string;
  exitCode?: number;
  messages?: number;
  call?: { name: string; args: Record<string, unknown> };
}

type AgentGlobal = {
  __smolagent?: {
    useFake(scripts: unknown[]): void;
    loadModel(local?: boolean): Promise<{ source: string }>;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    send(text: string): Promise<AgentEvent[]>;
    cancel(): void;
    configure(patch: Record<string, number>): void;
    messages(): { role: string; content: string }[];
    reset(): void;
    close(timeoutMs?: number): Promise<void>;
  };
};

async function boot(page: import("@playwright/test").Page) {
  const scripts = JSON.parse(await readFile(scriptsPath, "utf8")).scripts as unknown[];

  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));

  const fixture = (await walkFixture(mountDir)) as FixtureNode;
  await installMount(page, fixture, "__smolagent");

  await page.evaluate((s) => (globalThis as AgentGlobal).__smolagent!.useFake(s), scripts);
  await page.evaluate(
    (t) => (globalThis as AgentGlobal).__smolagent!.bootVm(t),
    BOOT_TIMEOUT_MS,
  );
  await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.loadModel());
}

const send = (page: import("@playwright/test").Page, text: string) =>
  page.evaluate((t) => (globalThis as AgentGlobal).__smolagent!.send(t), text);

const kinds = (events: AgentEvent[]) => events.map((e) => e.kind).filter((k) => k !== "token");

test.describe("agent chat loop", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test.afterEach(async ({ page }) => {
    await page
      .evaluate(() => (globalThis as AgentGlobal).__smolagent!.close(10_000))
      .catch(() => undefined);
  });

  test("a plain answer never touches the VM", async ({ page }) => {
    const events = await send(page, "who are you?");
    expect(kinds(events)).toEqual(["user", "assistant"]);
    expect(events.find((e) => e.kind === "assistant")?.text).toContain("smolbox");
  });

  test("a tool call reaches the real guest and the answer follows", async ({ page }) => {
    const events = await send(page, "what files are in the folder?");

    expect(kinds(events)).toEqual(["user", "tool-start", "tool-end", "assistant"]);
    const toolEnd = events.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.exitCode).toBe(0);
    // Real output from the real mount, through the real bridge.
    expect(toolEnd.rendered).toContain("hello.txt");
    expect(toolEnd.rendered).toContain("link.txt");
    expect(toolEnd.rendered).toContain("sub");

    // The result is in history as a `tool` message — what the chat template
    // wraps in <|tool_response_start|> on the next turn.
    const history = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.messages());
    expect(history[0]!.role).toBe("system");
    expect(history.some((m) => m.role === "tool" && m.content.includes("hello.txt"))).toBe(true);
  });

  test("the JSON call syntax works too", async ({ page }) => {
    const events = await send(page, "json call please");
    const toolEnd = events.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.call!.args.cmd).toBe("cat /mnt/host/hello.txt");
    expect(toolEnd.exitCode).toBe(0);
  });

  test("prose before a call is shown and the call still runs", async ({ page }) => {
    const events = await send(page, "explain then look");
    expect(kinds(events)).toContain("assistant");
    expect(kinds(events)).toContain("tool-end");
  });

  test("two calls chain in order", async ({ page }) => {
    const events = await send(page, "two steps");
    const cmds = events.filter((e) => e.kind === "tool-end").map((e) => e.call!.args.cmd);
    expect(cmds).toEqual(["pwd", "echo second"]);
  });

  test("a malformed call is reported and the model recovers", async ({ page }) => {
    const events = await send(page, "malformed");
    expect(kinds(events)).toContain("error");
    // It kept going and the corrected call ran.
    const cmds = events.filter((e) => e.kind === "tool-end").map((e) => e.call!.args.cmd);
    expect(cmds).toEqual(["echo recovered"]);
  });

  test("the per-call output budget truncates a huge command", async ({ page }) => {
    await page.evaluate(() =>
      (globalThis as AgentGlobal).__smolagent!.configure({ perCallMaxOutput: 4096 }),
    );
    const events = await send(page, "big output");
    const toolEnd = events.find((e) => e.kind === "tool-end")!;

    // The cap is applied by setting Request.max_output, so the guest truncates
    // and Render says so — one truncation, one story.
    expect(toolEnd.call!.args.max_output).toBe(4096);
    expect(toolEnd.rendered).toContain("output truncated");
    expect(toolEnd.rendered!.length).toBeLessThan(20_000);
  });

  test("the iteration cap stops a model that never stops calling", async ({ page }) => {
    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.configure({ maxIterations: 3 }));
    const events = await send(page, "loop forever");

    expect(events.filter((e) => e.kind === "tool-end")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: "iteration-cap" });
  });

  test("stop interrupts a turn in flight", async ({ page }) => {
    const pending = send(page, "take your time");
    await page.waitForTimeout(500);
    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.cancel());

    const events = await pending;
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: "cancelled" });
  });

  test("the read-only mount still refuses a write the model attempts", async ({ page }) => {
    const events = await send(page, "try writing");
    const toolEnd = events.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.exitCode).not.toBe(0);
    expect(toolEnd.rendered).toContain("can't create");
  });

  test("the transcript renders into the page, not just the hook", async ({ page }) => {
    await send(page, "what files are in the folder?");
    const log = page.locator("#log");
    await expect(log.locator(".msg.user")).toHaveCount(1);
    await expect(log.locator(".msg.tool")).toHaveCount(1);
    await expect(log.locator(".msg.tool")).toContainText("hello.txt");
    await expect(log.locator(".msg.assistant").last()).toContainText("hello.txt, link.txt and sub");
    // A tool-call block must never be rendered as raw prose.
    await expect(log).not.toContainText("tool_call_start");
  });
});
