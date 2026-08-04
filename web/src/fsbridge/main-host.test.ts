import { describe, expect, test } from "bun:test";
import { MountHost } from "./main-host.ts";
import {
  ERRNO_NOENT,
  ERRNO_SUCCESS,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  FILETYPE_SYMBOLIC_LINK,
  createBridgeSab,
} from "./protocol.ts";
import { FakeDirectoryHandle, fixtureTree } from "./test-util.ts";

const mountTree: Record<string, string | Record<string, string>> = {
  "hello.txt": "hello from the mount\n",
  sub: { "nested.txt": "nested fixture\n" },
};

function makeHost() {
  const host = new MountHost();
  host.attach(createBridgeSab());
  host.setHandle(FakeDirectoryHandle.fromTree(mountTree));
  host.setVirtualLinks({ "/link.txt": "hello.txt" });
  return host;
}

describe("MountHost.dispatch", () => {
  test("stat: regular file reports type and size", async () => {
    const host = makeHost();
    const st = await host.dispatch({ op: "stat", path: "/hello.txt" });
    expect(st).toEqual({
      op: "stat",
      errno: ERRNO_SUCCESS,
      filetype: FILETYPE_REGULAR_FILE,
      size: "hello from the mount\n".length,
    });
  });

  test("stat: directory reports directory type", async () => {
    const host = makeHost();
    const st = await host.dispatch({ op: "stat", path: "/sub" });
    expect(st.filetype).toBe(FILETYPE_DIRECTORY);
  });

  test("stat: virtual symlink reports symbolic link type", async () => {
    const host = makeHost();
    const st = await host.dispatch({ op: "stat", path: "/link.txt" });
    expect(st.filetype).toBe(FILETYPE_SYMBOLIC_LINK);
  });

  test("stat: missing path is ENOENT", async () => {
    const host = makeHost();
    const st = await host.dispatch({ op: "stat", path: "/nope.txt" });
    expect(st.errno).toBe(ERRNO_NOENT);
  });

  test("readdir: lists files, dirs, and virtual symlinks", async () => {
    const host = makeHost();
    const rd = await host.dispatch({ op: "readdir", path: "/" });
    expect(rd.errno).toBe(ERRNO_SUCCESS);
    expect(new Set((rd.entries ?? []).map((e) => e.name))).toEqual(
      new Set(["hello.txt", "sub", "link.txt"]),
    );
  });

  test("readdir: nested directory lists its children", async () => {
    const host = makeHost();
    const rd = await host.dispatch({ op: "readdir", path: "/sub" });
    expect((rd.entries ?? []).map((e) => e.name)).toEqual(["nested.txt"]);
  });

  test("readdir: missing path is ENOENT", async () => {
    const host = makeHost();
    const rd = await host.dispatch({ op: "readdir", path: "/missing" });
    expect(rd.errno).toBe(ERRNO_NOENT);
  });

  test("read: returns the requested window of a file", async () => {
    const host = makeHost();
    const r = await host.dispatch({ op: "read", path: "/hello.txt", offset: 0, len: 5 });
    expect(r.errno).toBe(ERRNO_SUCCESS);
    expect(new TextDecoder().decode(r.data)).toBe("hello");
  });

  test("read: offset mid-file and past-end short read", async () => {
    const host = makeHost();
    const r = await host.dispatch({ op: "read", path: "/hello.txt", offset: 6, len: 4 });
    expect(new TextDecoder().decode(r.data)).toBe("from");
    const past = await host.dispatch({ op: "read", path: "/hello.txt", offset: 999, len: 4 });
    expect(past.data?.length).toBe(0);
  });

  test("readlink: virtual symlink returns its target", async () => {
    const host = makeHost();
    const rl = await host.dispatch({ op: "readlink", path: "/link.txt" });
    expect(rl).toEqual({ op: "readlink", errno: ERRNO_SUCCESS, target: "hello.txt" });
  });

  test("readlink: regular file is ENOENT", async () => {
    const host = makeHost();
    const rl = await host.dispatch({ op: "readlink", path: "/hello.txt" });
    expect(rl.errno).toBe(ERRNO_NOENT);
  });

  test("chunked reads of a file larger than one slice work", async () => {
    const host = new MountHost();
    host.attach(createBridgeSab());
    const big = "x".repeat(4096);
    host.setHandle(FakeDirectoryHandle.fromTree({ "big.txt": big }));
    const first = await host.dispatch({ op: "read", path: "/big.txt", offset: 0, len: 2048 });
    const second = await host.dispatch({ op: "read", path: "/big.txt", offset: 2048, len: 2048 });
    expect(first.data?.length).toBe(2048);
    expect(second.data?.length).toBe(2048);
    expect(new TextDecoder().decode(first.data)).toBe("x".repeat(2048));
    expect(new TextDecoder().decode(second.data)).toBe("x".repeat(2048));
  });
});

describe("MountHost remount", () => {
  test("setHandle(null) empties the mount, setHandle restores", async () => {
    const host = new MountHost();
    host.attach(createBridgeSab());
    host.setHandle(FakeDirectoryHandle.fromTree(mountTree));
    host.setHandle(null);
    const st = await host.dispatch({ op: "stat", path: "/hello.txt" });
    expect(st.errno).toBe(ERRNO_NOENT);
    const rd = await host.dispatch({ op: "readdir", path: "/" });
    expect(rd.entries ?? []).toEqual([]);

    host.setHandle(FakeDirectoryHandle.fromTree(mountTree));
    const st2 = await host.dispatch({ op: "stat", path: "/hello.txt" });
    expect(st2.errno).toBe(ERRNO_SUCCESS);
  });

  test("remount clears the memoized readdir and stat caches", async () => {
    const host = new MountHost();
    host.attach(createBridgeSab());
    host.setHandle(FakeDirectoryHandle.fromTree({ "a.txt": "one" }));

    await host.dispatch({ op: "readdir", path: "/" });
    await host.dispatch({ op: "stat", path: "/a.txt" });

    // Swap to a different tree; caches must not serve the old contents.
    host.setHandle(FakeDirectoryHandle.fromTree({ "b.txt": "two" }));
    const rd = await host.dispatch({ op: "readdir", path: "/" });
    expect((rd.entries ?? []).map((e) => e.name)).toEqual(["b.txt"]);
    const st = await host.dispatch({ op: "stat", path: "/a.txt" });
    expect(st.errno).toBe(ERRNO_NOENT);
    const st2 = await host.dispatch({ op: "stat", path: "/b.txt" });
    expect(st2.errno).toBe(ERRNO_SUCCESS);
  });

  test("remount swaps the virtual symlink table", async () => {
    const host = makeHost();
    host.remount(FakeDirectoryHandle.fromTree(mountTree), { "/newlink.txt": "hello.txt" });
    const rl = await host.dispatch({ op: "readlink", path: "/newlink.txt" });
    expect(rl.target).toBe("hello.txt");
    const old = await host.dispatch({ op: "readlink", path: "/link.txt" });
    expect(old.errno).toBe(ERRNO_NOENT);
  });
});

describe("MountHost edge behaviour", () => {
  test("root always stats as a directory even when unmounted", async () => {
    const host = new MountHost();
    host.attach(createBridgeSab());
    const st = await host.dispatch({ op: "stat", path: "/" });
    expect(st.filetype).toBe(FILETYPE_DIRECTORY);
  });

  test("unmounted children are ENOENT", async () => {
    const host = new MountHost();
    host.attach(createBridgeSab());
    const st = await host.dispatch({ op: "stat", path: "/anything" });
    expect(st.errno).toBe(ERRNO_NOENT);
  });

  test("fixtureTree mirrors testdata/mount (drift guard)", () => {
    const entries = fixtureTree();
    expect(entries.get("/hello.txt")).toEqual({ kind: "file", content: "hello from the mount\n" });
    expect(entries.get("/sub/nested.txt")).toEqual({ kind: "file", content: "nested fixture\n" });
    expect(entries.get("/link.txt")).toEqual({ kind: "symlink", target: "hello.txt" });
  });
});
