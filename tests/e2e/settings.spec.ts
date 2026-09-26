// The agent page's settings dialog.
//
// What is worth testing here is not that inputs hold text. It is the ownership
// rule in settings.ts: a knob the user has not touched follows the selected
// checkpoint, and a knob they have touched does not. Getting that backwards is
// invisible until someone switches models and quietly loses their temperature,
// or until every model inherits one model's sampling.

import { expect, test, type Page } from "@playwright/test";

interface Options {
  systemPrompt: string;
  maxIterations: number;
  maxNewTokens: number;
  promptBudgetChars: number;
  generation: Record<string, number | boolean>;
}

type AgentGlobal = { __smolagent?: { options(): Options } };

/** The one test below that asks the page which bundle it is. */
type ModelSourceGlobal = { __smolagent?: { modelSource(): string } };

async function open(page: Page): Promise<void> {
  // ?model=fake keeps this off a GPU; the settings path does not touch weights.
  await page.goto("/agent/?model=fake");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));
}

const options = (page: Page): Promise<Options> =>
  page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.options());

/** The sections are <details>, and a collapsed one has no visible inputs. */
async function expand(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).click();
}

test("opens and closes", async ({ page }) => {
  await open(page);
  await expect(page.locator("#settings")).toBeHidden();
  await page.locator("#settings-open").click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings")).toBeHidden();
});

test("shows the live values rather than blanks", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();

  const before = await options(page);
  await expect(page.locator("#opt-system")).toHaveValue(before.systemPrompt);
  await expect(page.locator("#opt-iterations")).toHaveValue(String(before.maxIterations));
  await expect(page.locator("#opt-tokens")).toHaveValue(String(before.maxNewTokens));
});

test("only the sampling knobs that were changed reach the loop", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();
  await expand(page, "sampling");

  await page.locator("#gen-temperature").fill("0.25");
  await page.locator("#gen-temperature").blur();

  // Sending the untouched knobs too would pin every future model to this one's
  // sampling, which is exactly what the override is meant to avoid.
  await expect.poll(() => options(page).then((o) => o.generation)).toEqual({ temperature: 0.25 });
  await expect(page.locator('[data-knob="temperature"]')).toHaveAttribute("data-touched", "1");
  await expect(page.locator('[data-knob="top_p"]')).toHaveAttribute("data-touched", "0");
});

test("clearing a number hands the knob back to the model", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();
  await expand(page, "sampling");

  await page.locator("#gen-temperature").fill("0.25");
  await page.locator("#gen-temperature").blur();
  await expect.poll(() => options(page).then((o) => o.generation)).toEqual({ temperature: 0.25 });

  await page.locator("#gen-temperature").fill("");
  await page.locator("#gen-temperature").blur();
  await expect.poll(() => options(page).then((o) => o.generation)).toEqual({});
  await expect(page.locator('[data-knob="temperature"]')).toHaveAttribute("data-touched", "0");
});

test("the system prompt can be replaced and reset", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();

  await page.locator("#opt-system").fill("you are a teapot");
  await expect.poll(() => options(page).then((o) => o.systemPrompt)).toBe("you are a teapot");

  await page.locator("#reset-system").click();
  await expect.poll(() => options(page).then((o) => o.systemPrompt)).toContain("smolbox");
  await expect(page.locator("#opt-system")).not.toHaveValue("you are a teapot");
});

test("overrides survive a reload", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();
  await expand(page, "sampling");
  await page.locator("#gen-temperature").fill("0.25");
  await page.locator("#gen-temperature").blur();
  await page.locator("#opt-system").fill("you are a teapot");
  await expect.poll(() => options(page).then((o) => o.systemPrompt)).toBe("you are a teapot");

  await open(page);
  const after = await options(page);
  expect(after.systemPrompt).toBe("you are a teapot");
  expect(after.generation).toEqual({ temperature: 0.25 });
});

test("switching models re-derives untouched knobs and keeps touched ones", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();
  await expand(page, "sampling");
  await page.locator("#gen-temperature").fill("0.25");
  await page.locator("#gen-temperature").blur();
  await expect.poll(() => options(page).then((o) => o.generation)).toEqual({ temperature: 0.25 });

  const before = await options(page);
  // By key rather than by index: the assertion below is about two specific
  // checkpoints disagreeing, and registry order is not a thing to depend on.
  // The default entry asks for its own max_new_tokens; LFM2.5 350M asks for
  // nothing and so falls back to the loop's default.
  await page.selectOption("#model", "lfm2.5-350m");
  const after = await options(page);

  expect(after.generation).toEqual({ temperature: 0.25 });
  // How long a turn is allowed to run is a property of the checkpoint, so it
  // has to move even though the user never asked it to.
  expect(after.maxNewTokens).not.toBe(before.maxNewTokens);
  // The prompt ceiling used to move here too, back when it was scaled by the
  // checkpoint's vocabulary to bound a full-sequence logits allocation. #16
  // chunked the prefill and took that term out, so it is now min(context,
  // AGENT_WORKING_TOKENS) and every registry entry has more context than the
  // working window. What is still worth pinning is that a model switch
  // re-derives it from the entry rather than dropping it back to the
  // no-model-selected floor in DEFAULTS.
  expect(after.promptBudgetChars).toBe(before.promptBudgetChars);
});

// The kernel entries, seen from the page rather than from a unit test.
//
// `make test-e2e` builds with the default (hub), which is what Pages deploys.
// Both kernel engines ship with the site (`make site` copies dist/kernels), so
// both entries must be selectable there — they used to be listed disabled as
// "needs a local build", which kept them out of the deployed dropdown in
// practice. PLAN §10.28.
test("the kernel entries can be chosen on either model source", async ({ page }) => {
  await open(page);
  const source = await page.evaluate(() => (globalThis as ModelSourceGlobal).__smolagent!.modelSource());
  expect(["hub", "local"]).toContain(source);
  for (const key of ["gemma4-e2b", "bonsai2-27b"]) {
    const kernels = page.locator(`#model option[value="${key}"]`);
    await expect(kernels).toHaveCount(1);
    await expect(kernels).toBeEnabled();
    await expect(kernels).not.toContainText("needs a local build");
  }
  await expect(page.locator('#model option[value="gemma4-e2b-onnx"]')).toBeEnabled();
});

test("the storage panel reports an empty cache", async ({ page }) => {
  await open(page);
  await page.locator("#settings-open").click();
  await expect(page.locator("#cache-list")).toContainText("nothing cached yet");
  await expect(page.locator("#cache-msg")).toContainText("cached");
});

test("each status chip carries its own state", async ({ page }) => {
  await open(page);
  // One chip per thing that can be up, loading or broken on its own; a single
  // badge could only ever describe one of them (web/src/agent/status.ts).
  for (const id of ["#chip-vm", "#chip-model", "#chip-folder"]) {
    await expect(page.locator(id)).toHaveAttribute("data-state", /idle|ready|loading|error/);
  }
});
