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
  reasoning?: string;
  message?: string;
  reason?: string;
  rendered?: string;
  exitCode?: number;
  messages?: number;
  call?: { name: string; args: Record<string, unknown> };
  request?: { cmd?: string; max_output?: number };
}

type AgentGlobal = {
  __smolagent?: {
    useFake(scripts: unknown[]): void;
    setModel(key: string): void;
    loadModel(local?: boolean): Promise<{ source: string }>;
    bootVm(timeoutMs?: number): Promise<{ version: string }>;
    send(text: string): Promise<AgentEvent[]>;
    tools(): { name: string; source: string; enabled: boolean }[];
    addTool(tool: unknown): void;
    enableTool(name: string, on: boolean): void;
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

    // The cap is applied to the request (never to the model's arguments, which a
    // template tool would reject), so the guest truncates and Render says so —
    // one truncation, one story.
    expect(toolEnd.request!.max_output).toBe(4096);
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

  // M11: a tool the user invented, executed against the real guest. The model
  // is scripted, but everything from the call onward is the real path:
  // template compilation, shell quoting, the exec request, the guest.
  test("a user-defined tool compiles, runs against the guest, and returns real output", async ({ page }) => {
    await page.evaluate(() => {
      const api = (globalThis as AgentGlobal).__smolagent!;
      api.addTool({
        name: "find_in_folder",
        description: "Find a pattern in the mounted folder.",
        params: [{ name: "pattern", type: "string", description: "what to look for", required: true }],
        template: "grep -rn -- {pattern} /mnt/host",
      });
    });

    const tools = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.tools());
    expect(tools.find((t) => t.name === "find_in_folder")).toMatchObject({ source: "user", enabled: true });

    const events = await send(page, "user tool");
    const toolEnd = events.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.call!.name).toBe("find_in_folder");
    expect(toolEnd.exitCode).toBe(0);
    // hello.txt in testdata/mount contains "hello", found by the real grep.
    expect(toolEnd.rendered).toContain("hello.txt");
  });

  test("narrow tools are off until enabled, and the model cannot call one that is not", async ({ page }) => {
    const before = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.tools());
    expect(before.find((t) => t.name === "list_dir")).toMatchObject({ source: "builtin", enabled: false });

    // Calling a disabled tool comes back as a correctable error, not a crash.
    const events = await send(page, "disabled tool");
    expect(events.some((e) => e.kind === "error")).toBe(true);

    await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.enableTool("list_dir", true));
    const after = await send(page, "disabled tool");
    const toolEnd = after.find((e) => e.kind === "tool-end")!;
    expect(toolEnd.call!.name).toBe("list_dir");
    expect(toolEnd.exitCode).toBe(0);
    expect(toolEnd.rendered).toContain("hello.txt");
  });

  test("shell metacharacters in a tool argument are inert", async ({ page }) => {
    await page.evaluate(() => {
      (globalThis as AgentGlobal).__smolagent!.addTool({
        name: "echo_it",
        description: "Echo a value.",
        params: [{ name: "value", type: "string", description: "what to echo", required: true }],
        template: "echo {value}",
      });
    });

    const events = await send(page, "injection attempt");
    const toolEnd = events.find((e) => e.kind === "tool-end")!;
    // The metacharacters came back as text; the second command never ran.
    expect(toolEnd.rendered).toContain("hi; echo PWNED");
    expect(toolEnd.rendered!.match(/PWNED/g)).toHaveLength(1);
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

  // A turn that was only a tool call used to leave an empty assistant bubble
  // behind — a "MODEL" label with nothing under it, once per call.
  test("a turn that is only a tool call leaves no empty bubble", async ({ page }) => {
    await send(page, "what files are in the folder?");
    const log = page.locator("#log");
    await expect(log.locator(".msg.assistant")).toHaveCount(1);
    await expect(log.locator(".msg.assistant").first()).toContainText("hello.txt, link.txt and sub");
  });

  test("prose before a call is its own bubble and the markers stay out of it", async ({ page }) => {
    await send(page, "explain then look");
    const log = page.locator("#log");
    await expect(log.locator(".msg.assistant").first()).toContainText("Let me check the folder first.");
    await expect(log).not.toContainText("tool_call");
  });

  test("a failed command is labelled by its exit code", async ({ page }) => {
    await send(page, "try writing to the mount");
    const log = page.locator("#log");
    await expect(log.locator(".msg.tool.bad")).toHaveCount(1);
    await expect(log.locator(".msg.tool.bad .who")).not.toContainText("exit 0");
  });

  test.describe("a reasoning model", () => {
    test.beforeEach(async ({ page }) => {
      // The dialect is what decides how a turn is split, and it moves with the
      // model. No weights are loaded — the scripted client ignores them.
      await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.setModel("lfm2.5-2.6b"));
    });

    test("the scratchpad is collapsed under the answer, not shown as one", async ({ page }) => {
      const events = await send(page, "think first about this");
      const log = page.locator("#log");

      // The answer is the answer.
      await expect(log.locator(".msg.assistant").last()).toContainText("There are three entries.");
      // The reasoning is present, in its own collapsed block, and closed.
      const think = log.locator(".msg.assistant .think").last();
      await expect(think).toHaveCount(1);
      await expect(think).not.toHaveAttribute("open", /.*/);
      await expect(think.locator(".think-body")).toContainText("Now I have the listing");
      // And it is not part of the prose.
      await expect(log.locator(".msg.assistant .prose").last()).not.toContainText(
        "Now I have the listing",
      );
      await expect(log).not.toContainText("</think>");

      const answer = events.filter((e) => e.kind === "assistant").at(-1);
      expect(answer?.text).toBe("There are three entries.");
      expect(answer?.reasoning).toContain("Now I have the listing");
    });

    test("a turn that never leaves the scratchpad says so instead of looking empty", async ({ page }) => {
      await send(page, "think forever please");
      const log = page.locator("#log");
      const bubble = log.locator(".msg.assistant").last();
      await expect(bubble.locator(".think summary")).toContainText("without answering");
      await expect(bubble.locator(".think-body")).toContainText("Let me consider");
      // The deliberation is not presented in the same voice as an answer.
      await expect(bubble.locator(".prose")).toHaveText("");
    });
  });
});
