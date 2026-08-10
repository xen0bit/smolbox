// The IndexedDB weight cache, against a real checkpoint.
//
// This is the only place the cache is exercised end to end. model-cache.test.ts
// covers the transaction choreography against a fake IndexedDB, but it cannot
// answer the question that actually mattered: does transformers.js route a real
// load through env.customCache, and does a 786 MB file survive the round trip?
// Both had to be true for the reload to stop re-downloading, and neither is
// visible from a unit test.
//
// Like agent.spec.ts, this needs a GPU and local weights, which is why it lives
// in playwright.agent.config.ts and never runs by accident.

import { expect, test } from "@playwright/test";

const MODEL_KEY = "qwen2.5-0.5b-instruct";
const REPO = "onnx-community/Qwen2.5-0.5B-Instruct";

type AgentGlobal = {
  __smolagent?: {
    setModel(key: string): void;
    loadModel(local?: boolean): Promise<{ source: string; loadMs: number }>;
  };
};

interface CacheDump {
  entries: { key: string; size: number; chunks: number }[];
  chunks: number;
}

/** Read the cache database from the page, without going through our own code. */
async function dump(page: import("@playwright/test").Page): Promise<CacheDump> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("smolbox-model-cache-v1", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const read = <T>(store: string, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const req = run(db.transaction([store], "readonly").objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const rows = await read("meta", (s) => s.getAll());
    const chunks = await read("chunks", (s) => s.count());
    return {
      entries: (rows as { key: string; size: number; chunks: number }[]).map((e) => ({
        key: e.key,
        size: e.size,
        chunks: e.chunks,
      })),
      chunks,
    };
  });
}

async function load(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/agent/");
  await page.waitForFunction(() => Boolean((globalThis as AgentGlobal).__smolagent));
  await page.evaluate((key) => (globalThis as AgentGlobal).__smolagent!.setModel(key), MODEL_KEY);
  const result = await page.evaluate(() => (globalThis as AgentGlobal).__smolagent!.loadModel(true));
  return result.loadMs;
}

/** Counts the per-file download lines the status bar logs, e.g. "…: 42%". */
function countProgressLines(page: import("@playwright/test").Page): () => number {
  let n = 0;
  page.on("console", (m) => {
    if (/\[smolagent\] loading \S+: \d+%$/.test(m.text())) {
      n++;
    }
  });
  return () => n;
}

test("a reload serves the weights from IndexedDB instead of the network", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/models/")) {
      requests.push(`${r.method()} ${r.url()}`);
    }
  });
  const progressLines = countProgressLines(page);

  const firstMs = await load(page);
  expect(requests.some((r) => r.startsWith("GET") && r.includes("model_q4.onnx"))).toBe(true);

  // One GET per weight file, not two. transformers.js runs a metadata pre-pass
  // over every expected file before it loads anything, and on the local path
  // that pre-pass is a full GET whose body it reads Content-Length off and then
  // abandons — so a cold load fetched this 786 MB checkpoint twice, with the
  // two transfers racing. model-worker.ts shares one in-flight response per URL
  // to collapse them; this is what says so.
  const weightGets = requests.filter((r) => r.startsWith("GET") && /\.onnx(_data)?$/.test(r));
  expect(weightGets.length).toBe(new Set(weightGets).size);

  // The download flooded the page before it was throttled: transformers.js
  // calls its progress callback once per network read, which for a checkpoint
  // this size is tens of thousands of postMessages, console.logs and DOM
  // writes — enough that the page could not drain them as fast as the worker
  // produced them and the load appeared to hang (Firefox worst, since it reads
  // in ~26 KB pieces). The worker now emits at most one message per whole
  // percent per file; this bound is loose enough to survive another file being
  // added to the repo and tight enough that losing the throttle fails here.
  expect(progressLines()).toBeLessThan(1000);

  const cached = await dump(page);
  const weights = cached.entries.find((e) => e.key.endsWith("model_q4.onnx"));
  expect(weights).toBeDefined();
  // The point of the whole exercise: this file is far past what Cache Storage
  // will take as one entry, and it is here as two dozen of them.
  expect(weights!.size).toBeGreaterThan(500e6);
  expect(weights!.chunks).toBeGreaterThan(1);
  expect(cached.entries.some((e) => e.key.startsWith(`/models/${REPO}/`))).toBe(true);

  requests.length = 0;
  const secondMs = await load(page);

  // HEAD revalidations are expected and are the reason `make model` is not
  // invisible. A GET for a weight body is the regression this test exists for.
  const bodies = requests.filter((r) => r.startsWith("GET") && /\.onnx(_data)?$/.test(r));
  expect(bodies).toEqual([]);
  expect(requests.every((r) => r.startsWith("HEAD"))).toBe(true);
  console.log(`load: ${firstMs}ms cold, ${secondMs}ms cached, ${cached.chunks} chunks stored`);
});

test("clearing the cache makes the next load fetch again", async ({ page }) => {
  await load(page);
  expect((await dump(page)).entries.length).toBeGreaterThan(0);

  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("smolbox-model-cache-v1");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      }),
  );

  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/models/")) {
      requests.push(`${r.method()} ${r.url()}`);
    }
  });
  await load(page);
  expect(requests.some((r) => r.startsWith("GET") && r.includes("model_q4.onnx"))).toBe(true);
});
