// Shared helpers for the Playwright e2e suites: boot the VM through the page's
// window.__smolbox hook, install a mount into OPFS (the File System Access API
// without a native dialog), and apply the conformance expect matchers — the TS
// twin of tests/conformance/driver.go's expect.check.

import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const casesPath = fileURLToPath(new URL("../../tests/conformance/cases.json", import.meta.url));

export interface Caps {
  version: string;
}

export interface Request {
  op: string;
  cmd?: string;
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  max_output?: number;
}

export interface Response {
  seq: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

export interface Handle {
  boot(timeoutMs?: number): Promise<Caps>;
  exec(req: Request, timeoutMs?: number): Promise<Response>;
  close(timeoutMs?: number): Promise<void>;
}

export type SmolboxGlobal = { __smolbox?: unknown };

export const BOOT_TIMEOUT_MS = 180_000;
export const EXEC_TIMEOUT_MS = 120_000;

// A mount fixture as a serializable tree; symlinks are carried separately so
// the browser bridge can present them as virtual entries.
export type FixtureNode =
  | { kind: "file"; content: string }
  | { kind: "dir"; children: Record<string, FixtureNode> }
  | { kind: "symlink"; target: string };

// Walk a host directory (e.g. testdata/mount) into a FixtureNode. This is the
// single source of truth for the browser mount: it mirrors exactly what the
// wazero driver mounts on the Go side.
export async function walkFixture(dir: string): Promise<FixtureNode> {
  const children: Record<string, FixtureNode> = {};
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      children[name] = { kind: "symlink", target: await readlink(p) };
    } else if (st.isDirectory()) {
      children[name] = await walkFixture(p);
    } else {
      children[name] = { kind: "file", content: await readFile(p, "utf8") };
    }
  }
  return { kind: "dir", children };
}

// Populate OPFS with the fixture and mount it via the page's setMount, then
// boot the VM. OPFS persists per origin, so the root is cleared first; real
// symlinks become the bridge's virtual symlink table. If fixture is omitted,
// the mount is left empty (the preopen still resolves as an empty directory).
export async function boot(page: Page, fixture?: FixtureNode): Promise<Handle> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((globalThis as SmolboxGlobal).__smolbox));

  if (fixture) {
    await installMount(page, fixture, "__smolbox");
  }

  return attach(page);
}

// Write the fixture into OPFS and hand it to the page's setMount. Parameterised
// by hook name so the agent page (__smolagent) mounts through the identical code
// path as the VM page (__smolbox) — same bridge, same virtual symlink table.
export async function installMount(
  page: Page,
  fixture: FixtureNode,
  hook: "__smolbox" | "__smolagent",
): Promise<void> {
  await page.evaluate(
    async ({ tree, hook }) => {
      const links: Record<string, string> = {};
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true });
      }

      const writeNode = async (
        dir: FileSystemDirectoryHandle,
        node: FixtureNode,
        abs: string,
      ): Promise<void> => {
        if (node.kind === "symlink") {
          links[abs] = node.target;
          return;
        }
        if (node.kind === "dir") {
          for (const [name, child] of Object.entries(node.children)) {
            const childAbs = abs === "/" ? `/${name}` : `${abs}/${name}`;
            if (child.kind === "file") {
              const fh = await dir.getFileHandle(name, { create: true });
              const writable = await fh.createWritable();
              await writable.write(child.content);
              await writable.close();
            } else if (child.kind === "dir") {
              const sub = await dir.getDirectoryHandle(name, { create: true });
              await writeNode(sub, child, childAbs);
            } else if (typeof child.target === "string") {
              links[childAbs] = child.target;
            }
          }
        }
      };

      await writeNode(root, tree as FixtureNode, "/");
      const api = (globalThis as unknown as Record<string, { setMount(h: unknown, l?: Record<string, string>): void } | undefined>)[hook];
      api?.setMount(root, links);
    },
    { tree: fixture, hook },
  );
}

// Mount a real host directory through the page's folder picker rather than
// through setMount. In a browser without showDirectoryPicker this exercises the
// <input webkitdirectory> fallback end to end — the file chooser is the same
// dialog a user gets, and the page rebuilds the tree from the FileList.
export async function pickHostFolder(page: Page, dir: string, selector = "#pick"): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.click(selector);
  await (await chooser).setFiles(dir);
  await page.waitForFunction(
    (hook) => Boolean((globalThis as Record<string, any>)[hook]?.mountStatus?.()),
    "__smolbox",
    { timeout: 30_000 },
  );
}

// Drive window.__smolbox.boot and wrap the remaining session calls.
export async function attach(
  page: Page,
  execTimeoutMs = EXEC_TIMEOUT_MS,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
): Promise<Handle> {
  // Boot hangs are rare and so far only seen on CI, so a failure has to carry
  // its own evidence: the worker's stall reports (see web/src/worker.ts) arrive
  // as console lines, and silence in them is as informative as their contents.
  const log: string[] = [];
  const onConsole = (m: { text(): string }): void => {
    log.push(`${new Date().toISOString()} ${m.text()}`.slice(0, 300));
  };
  page.on("console", onConsole);

  let caps: Caps;
  try {
    caps = await page.evaluate(
      (timeout) => (globalThis as SmolboxGlobal).__smolbox!.boot(timeout),
      bootTimeoutMs,
    );
  } catch (err) {
    const tail = log.slice(-40).join("\n") || "(no console output at all)";
    throw new Error(`${String(err)}\n\n--- page console (last 40 lines) ---\n${tail}`);
  } finally {
    page.off("console", onConsole);
  }

  return {
    boot: () => Promise.resolve(caps),
    exec: (req, timeoutMs) =>
      page.evaluate(
        ({ req, timeoutMs }) => (globalThis as SmolboxGlobal).__smolbox!.exec(req, timeoutMs),
        { req, timeoutMs: timeoutMs ?? execTimeoutMs },
      ),
    close: (timeoutMs) =>
      page.evaluate(
        (timeoutMs) => (globalThis as SmolboxGlobal).__smolbox!.close(timeoutMs),
        timeoutMs ?? 15_000,
      ),
  };
}

// Partial matcher, mirroring tests/conformance/driver.go's expect.check. Only
// the fields that are set are asserted; returns a list of human-readable diffs.
export interface Expect {
  exit_code?: number;
  stdout?: string;
  stdout_contains?: string;
  stdout_not_contains?: string;
  stdout_len?: number;
  stderr?: string;
  stderr_contains?: string;
  timed_out?: boolean;
  truncated?: boolean;
}

export function checkExpect(e: Expect, r: Response): string[] {
  const diffs: string[] = [];
  if (e.exit_code !== undefined && r.exit_code !== e.exit_code) {
    diffs.push(`exit_code = ${r.exit_code}, want ${e.exit_code}`);
  }
  if (e.stdout !== undefined && r.stdout !== e.stdout) {
    diffs.push(`stdout = ${JSON.stringify(r.stdout)}, want ${JSON.stringify(e.stdout)}`);
  }
  if (e.stdout_contains !== undefined && !r.stdout.includes(e.stdout_contains)) {
    diffs.push(`stdout ${JSON.stringify(r.stdout)} missing ${JSON.stringify(e.stdout_contains)}`);
  }
  if (e.stdout_not_contains !== undefined && r.stdout.includes(e.stdout_not_contains)) {
    diffs.push(`stdout must not contain ${JSON.stringify(e.stdout_not_contains)}`);
  }
  if (e.stdout_len !== undefined && r.stdout.length !== e.stdout_len) {
    diffs.push(`stdout len = ${r.stdout.length}, want ${e.stdout_len}`);
  }
  if (e.stderr !== undefined && r.stderr !== e.stderr) {
    diffs.push(`stderr = ${JSON.stringify(r.stderr)}, want ${JSON.stringify(e.stderr)}`);
  }
  if (e.stderr_contains !== undefined && !r.stderr.includes(e.stderr_contains)) {
    diffs.push(`stderr ${JSON.stringify(r.stderr)} missing ${JSON.stringify(e.stderr_contains)}`);
  }
  if (e.timed_out !== undefined && r.timed_out !== e.timed_out) {
    diffs.push(`timed_out = ${r.timed_out}, want ${e.timed_out}`);
  }
  if (e.truncated !== undefined && r.truncated !== e.truncated) {
    diffs.push(`truncated = ${r.truncated}, want ${e.truncated}`);
  }
  return diffs;
}

export const mountFixturePath = fileURLToPath(new URL("../../testdata/mount", import.meta.url));

// The shared conformance table. `requires` tags a case with the capabilities it
// needs; the Go driver and the browser driver both run everything.
export interface CaseSpec {
  name: string;
  requires?: string[];
  steps: Array<{ request: Request; expect: Expect }>;
}

export async function loadCases(): Promise<CaseSpec[]> {
  const table = JSON.parse(await readFile(casesPath, "utf8")) as { cases: CaseSpec[] };
  return table.cases;
}
