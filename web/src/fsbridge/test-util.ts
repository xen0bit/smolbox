// Shared fakes for fsbridge unit tests: an in-memory File System Access tree
// (exercises MountHost's dispatch) and a synchronous BridgeClient backed by the
// same tree (exercises BridgeFd without blocking on Atomics.wait).

import type {
  BlobLike,
  DirectoryHandleLike,
  FileHandleLike,
  HandleLike,
} from "./main-host.ts";
import {
  BridgeClient,
  ERRNO_NOENT,
  ERRNO_SUCCESS,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  FILETYPE_SYMBOLIC_LINK,
  ReaddirEntry,
} from "./protocol.ts";

/**
 * A fixed date for every fake file: 2026-08-10T00:00:00Z.
 *
 * Deliberately not `Date.now()` and deliberately not 0. Not now, because an
 * assertion against a moving value has to be written loosely enough to pass
 * whatever it is handed; not 0, because 0 is exactly the wrong answer this
 * bridge used to give and a test that cannot tell it from a right one is not
 * covering anything.
 */
export const FAKE_MTIME_MS = 1_786_060_800_000;

export class FakeBlob implements BlobLike {
  readonly size: number;
  readonly lastModified = FAKE_MTIME_MS;

  constructor(private data: Uint8Array) {
    this.size = data.length;
  }

  static fromString(s: string): FakeBlob {
    return new FakeBlob(new TextEncoder().encode(s));
  }

  slice(start = 0, end = this.size): FakeBlob {
    const s = Math.max(0, start);
    const e = Math.min(this.size, Math.max(s, end));
    return new FakeBlob(this.data.subarray(s, e));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer;
  }
}

export class FakeFileHandle implements FileHandleLike {
  readonly kind = "file" as const;

  constructor(private blob: FakeBlob) {}

  getFile(): Promise<FakeBlob> {
    return Promise.resolve(this.blob);
  }
}

export class FakeDirectoryHandle implements DirectoryHandleLike {
  readonly kind = "directory" as const;

  constructor(private children: Map<string, HandleLike>) {}

  static fromTree(tree: Record<string, string | Record<string, string>>): FakeDirectoryHandle {
    const children = new Map<string, HandleLike>();
    for (const [name, value] of Object.entries(tree)) {
      if (typeof value === "string") {
        children.set(name, new FakeFileHandle(FakeBlob.fromString(value)));
      } else {
        children.set(name, FakeDirectoryHandle.fromTree(value));
      }
    }
    return new FakeDirectoryHandle(children);
  }

  getFileHandle(name: string): Promise<FakeFileHandle> {
    const child = this.children.get(name);
    if (!child) {
      return Promise.reject(Object.assign(new Error("not found"), { name: "NotFoundError" }));
    }
    if (child.kind !== "file") {
      return Promise.reject(new TypeError("not a file"));
    }
    return Promise.resolve(child as FakeFileHandle);
  }

  getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
    const child = this.children.get(name);
    if (!child) {
      return Promise.reject(Object.assign(new Error("not found"), { name: "NotFoundError" }));
    }
    if (child.kind !== "directory") {
      return Promise.reject(new TypeError("not a directory"));
    }
    return Promise.resolve(child as FakeDirectoryHandle);
  }

  async *entries(): AsyncIterable<[string, HandleLike]> {
    for (const [name, child] of this.children) {
      yield [name, child];
    }
  }
}

export type FakeFsEntry =
  | { kind: "file"; content: string }
  | { kind: "dir" }
  | { kind: "symlink"; target: string };

// A synchronous stand-in for BridgeChannel, mirroring the mount fixture the
// conformance tests use (testdata/mount): hello.txt, sub/nested.txt, and a
// virtual symlink link.txt -> hello.txt.
export const fixtureTree = (): Map<string, FakeFsEntry> =>
  new Map<string, FakeFsEntry>([
    ["/hello.txt", { kind: "file", content: "hello from the mount\n" }],
    ["/sub", { kind: "dir" }],
    ["/sub/nested.txt", { kind: "file", content: "nested fixture\n" }],
    ["/link.txt", { kind: "symlink", target: "hello.txt" }],
  ]);

export class FakeChannel implements BridgeClient {
  constructor(private entries: Map<string, FakeFsEntry>) {}

  stat(path: string) {
    if (path === "/") {
      return { op: "stat" as const, errno: ERRNO_SUCCESS, filetype: FILETYPE_DIRECTORY, size: 0 };
    }
    const e = this.entries.get(path);
    if (!e) {
      return { op: "stat" as const, errno: ERRNO_NOENT };
    }
    if (e.kind === "dir") {
      return { op: "stat" as const, errno: ERRNO_SUCCESS, filetype: FILETYPE_DIRECTORY, size: 0 };
    }
    if (e.kind === "symlink") {
      return { op: "stat" as const, errno: ERRNO_SUCCESS, filetype: FILETYPE_SYMBOLIC_LINK, size: 0 };
    }
    return {
      op: "stat" as const,
      errno: ERRNO_SUCCESS,
      filetype: FILETYPE_REGULAR_FILE,
      size: new TextEncoder().encode(e.content).length,
      mtimeMs: FAKE_MTIME_MS,
      nlink: 1,
    };
  }

  readdir(path: string) {
    const prefix = path === "/" ? "/" : `${path}/`;
    const entries: ReaddirEntry[] = [];
    for (const [p, e] of this.entries) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) {
          entries.push({ name: rest, type: filetypeOf(e) });
        }
      }
    }
    return { op: "readdir" as const, errno: ERRNO_SUCCESS, entries };
  }

  read(path: string, offset: number, len: number) {
    const e = this.entries.get(path);
    if (!e || e.kind !== "file") {
      return { op: "read" as const, errno: ERRNO_NOENT };
    }
    const bytes = new TextEncoder().encode(e.content);
    const data = bytes.subarray(offset, offset + len);
    return { op: "read" as const, errno: ERRNO_SUCCESS, len: data.length, data };
  }

  readlink(path: string) {
    const e = this.entries.get(path);
    if (e && e.kind === "symlink") {
      return { op: "readlink" as const, errno: ERRNO_SUCCESS, target: e.target };
    }
    return { op: "readlink" as const, errno: ERRNO_NOENT };
  }
}

function filetypeOf(e: FakeFsEntry): number {
  if (e.kind === "dir") {
    return FILETYPE_DIRECTORY;
  }
  if (e.kind === "symlink") {
    return FILETYPE_SYMBOLIC_LINK;
  }
  return FILETYPE_REGULAR_FILE;
}
