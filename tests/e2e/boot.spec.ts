import { expect, test } from "@playwright/test";

// The M4 done-criteria: a real browser boots dist/smolbox.wasm and runs the
// framed protocol. boot()/exec() are driven through the same window.__smolbox
// hook the page exposes, so the headless VM and the visible console share one
// code path.

interface Caps {
  version: string;
}

interface Request {
  op: string;
  cmd?: string;
  cwd?: string;
  timeout_ms?: number;
}

interface Response {
  seq: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

interface Handle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
}

type SmolboxGlobal = { __smolbox?: Handle };

const BOOT_TIMEOUT_MS = 180_000;
const EXEC_TIMEOUT_MS = 120_000;

async function boot(page: import("@playwright/test").Page): Promise<Handle> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as SmolboxGlobal).__smolbox));
  const caps = await page.evaluate(
    (timeout) => (globalThis as SmolboxGlobal).__smolbox!.boot(timeout),
    BOOT_TIMEOUT_MS,
  );
  expect(caps.version).toBe("0.0.1");
  return { boot: () => Promise.resolve(caps), exec: execOn(page), close: closeOn(page) };
}

function execOn(page: import("@playwright/test").Page): Handle["exec"] {
  return (req, timeoutMs) =>
    page.evaluate(
      ({ req, timeoutMs }) => (globalThis as SmolboxGlobal).__smolbox!.exec(req, timeoutMs),
      { req, timeoutMs: timeoutMs ?? EXEC_TIMEOUT_MS },
    );
}

function closeOn(page: import("@playwright/test").Page): Handle["close"] {
  return (timeoutMs) =>
    page.evaluate(
      (timeoutMs) => (globalThis as SmolboxGlobal).__smolbox!.close(timeoutMs),
      timeoutMs ?? 15_000,
    );
}

test("boots the VM and runs echo hello", async ({ page }) => {
  const handle = await boot(page);
  const resp = await handle.exec({ op: "exec", cmd: "echo hello" });
  expect(resp.exit_code).toBe(0);
  expect(resp.stdout).toBe("hello\n");
  await handle.close();
});

test("the preopen spike: the guest reads the in-memory /mnt/host mount", async ({ page }) => {
  const handle = await boot(page);

  const cat = await handle.exec({ op: "exec", cmd: "cat /mnt/host/hello.txt" });
  expect(cat.exit_code).toBe(0);
  expect(cat.stdout).toBe("hello from the mount\n");

  const ls = await handle.exec({ op: "exec", cmd: "ls -1 /mnt/host" });
  expect(ls.exit_code).toBe(0);
  expect(ls.stdout).toBe("hello.txt\nlink.txt\nsub\n");

  const nested = await handle.exec({ op: "exec", cmd: "cat /mnt/host/sub/nested.txt" });
  expect(nested.exit_code).toBe(0);
  expect(nested.stdout).toBe("nested fixture\n");

  await handle.close();
});
