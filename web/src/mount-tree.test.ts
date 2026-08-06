import { describe, expect, test } from "bun:test";

import { MountHost } from "./fsbridge/main-host.ts";
import {
  ERRNO_NOENT,
  ERRNO_SUCCESS,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  OpRead,
  OpReaddir,
  OpStat,
} from "./fsbridge/protocol.ts";
import { directoryHandleFromFiles, type PickedFile } from "./mount-tree.ts";

// A stand-in for a browser File: a Blob with a name and the relative path an
// <input webkitdirectory> pick carries.
function pickedFile(relativePath: string, content: string): PickedFile {
  const bytes = new TextEncoder().encode(content);
  const blob = new Blob([bytes]) as unknown as PickedFile;
  return Object.assign(blob, {
    name: relativePath.split("/").pop() ?? relativePath,
    webkitRelativePath: relativePath,
  });
}

async function names(dir: Awaited<ReturnType<typeof directoryHandleFromFiles>>): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of dir.entries()) {
    out.push(name);
  }
  return out.sort();
}

describe("directoryHandleFromFiles", () => {
  test("strips the picked folder and rebuilds the tree", async () => {
    const root = directoryHandleFromFiles([
      pickedFile("mount/hello.txt", "hi\n"),
      pickedFile("mount/sub/nested.txt", "deep\n"),
      pickedFile("mount/sub/deeper/leaf.txt", "leaf\n"),
    ]);

    expect(await names(root)).toEqual(["hello.txt", "sub"]);
    const sub = await root.getDirectoryHandle("sub");
    expect(await names(sub)).toEqual(["deeper", "nested.txt"]);
    const file = await (await sub.getFileHandle("nested.txt")).getFile();
    expect(await new Response(file as unknown as Blob).text()).toBe("deep\n");
  });

  test("keeps a flat multi-file selection at the root", async () => {
    const root = directoryHandleFromFiles([
      pickedFile("a.txt", "a"),
      pickedFile("b.txt", "b"),
    ]);
    expect(await names(root)).toEqual(["a.txt", "b.txt"]);
  });

  test("does not strip when the selections have different roots", async () => {
    const root = directoryHandleFromFiles([
      pickedFile("one/a.txt", "a"),
      pickedFile("two/b.txt", "b"),
    ]);
    expect(await names(root)).toEqual(["one", "two"]);
  });

  test("empty selection is an empty directory", async () => {
    const root = directoryHandleFromFiles([]);
    expect(await names(root)).toEqual([]);
  });

  test("rejects the wrong kind the way the real handles do", async () => {
    const root = directoryHandleFromFiles([pickedFile("mount/sub/a.txt", "a")]);
    await expect(root.getFileHandle("sub")).rejects.toThrow();
    await expect(root.getDirectoryHandle("missing")).rejects.toThrow();
  });

  test("falls back to the file name when there is no relative path", async () => {
    const blob = new Blob([new TextEncoder().encode("x")]) as unknown as PickedFile;
    const root = directoryHandleFromFiles([Object.assign(blob, { name: "solo.txt" })]);
    expect(await names(root)).toEqual(["solo.txt"]);
  });
});

// The point of the builder is that MountHost cannot tell it from a real
// FileSystemDirectoryHandle, so drive it through the bridge's own dispatch.
describe("MountHost over a picked file list", () => {
  const host = new MountHost();
  host.setHandle(
    directoryHandleFromFiles([
      pickedFile("mount/hello.txt", "hello\n"),
      pickedFile("mount/sub/nested.txt", "nested\n"),
    ]),
  );

  test("stat reports files and directories", async () => {
    expect(await host.dispatch({ op: OpStat, path: "/hello.txt" })).toEqual({
      op: OpStat,
      errno: ERRNO_SUCCESS,
      filetype: FILETYPE_REGULAR_FILE,
      size: 6,
    });
    expect(await host.dispatch({ op: OpStat, path: "/sub" })).toEqual({
      op: OpStat,
      errno: ERRNO_SUCCESS,
      filetype: FILETYPE_DIRECTORY,
      size: 0,
    });
    expect((await host.dispatch({ op: OpStat, path: "/nope" })).errno).toBe(ERRNO_NOENT);
  });

  test("readdir lists the rebuilt tree", async () => {
    const resp = await host.dispatch({ op: OpReaddir, path: "/" });
    expect(resp.errno).toBe(ERRNO_SUCCESS);
    expect((resp.entries ?? []).map((e) => e.name).sort()).toEqual(["hello.txt", "sub"]);
  });

  test("read returns the file bytes", async () => {
    const resp = await host.dispatch({ op: OpRead, path: "/sub/nested.txt", offset: 0, len: 64 });
    expect(resp.errno).toBe(ERRNO_SUCCESS);
    expect(new TextDecoder().decode(resp.data)).toBe("nested\n");
  });
});
