import { describe, expect, test } from "bun:test";
import { wasi } from "@bjorn3/browser_wasi_shim";
import {
  ERRNO_BADF,
  ERRNO_INVAL,
  ERRNO_NOENT,
  ERRNO_NOTCAPABLE,
  ERRNO_ROFS,
  ERRNO_SUCCESS,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  FILETYPE_SYMBOLIC_LINK,
} from "./protocol.ts";
import { FAKE_MTIME_MS, FakeChannel, fixtureTree } from "./test-util.ts";
import { BridgeFd, createBridgeFd } from "./worker-fd.ts";

function root(): BridgeFd {
  return createBridgeFd(new FakeChannel(fixtureTree()), "/mnt/host");
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("BridgeFd path_open", () => {
  test("opens a regular file read-only", () => {
    const { ret, fd_obj } = root().path_open(0, "hello.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(fd_obj).not.toBeNull();
  });

  test("opens a subdirectory and resolves nested paths against it", () => {
    const sub = root().path_open(0, "sub", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(sub).not.toBeNull();
    const nested = sub.path_open(0, "nested.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(nested).not.toBeNull();
    const { ret, data } = nested.fd_read(100);
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(decode(data)).toBe("nested fixture\n");
  });

  test("opening the mount root via '.' resolves to itself", () => {
    const { ret, fd_obj } = root().path_open(0, ".", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(fd_obj).not.toBeNull();
  });

  test("missing path is ENOENT", () => {
    const { ret } = root().path_open(0, "nope.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_NOENT);
  });

  test("write intent (O_CREAT / O_TRUNC) is rejected EROFS", () => {
    expect(root().path_open(0, "hello.txt", wasi.OFLAGS_CREAT, 0n, 0n, 0).ret).toBe(ERRNO_ROFS);
    expect(root().path_open(0, "hello.txt", wasi.OFLAGS_TRUNC, 0n, 0n, 0).ret).toBe(ERRNO_ROFS);
  });

  test("write rights are rejected EROFS", () => {
    const { ret } = root().path_open(0, "hello.txt", 0, BigInt(wasi.RIGHTS_FD_WRITE), 0n, 0);
    expect(ret).toBe(ERRNO_ROFS);
  });

  test(".. above the mount root is NOTCAPABLE", () => {
    const { ret } = root().path_open(0, "../secret.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_NOTCAPABLE);
  });

  test("absolute paths are NOTCAPABLE", () => {
    const { ret } = root().path_open(0, "/hello.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_NOTCAPABLE);
  });

  test("virtual symlink opens resolve to the target file", () => {
    const { ret, fd_obj } = root().path_open(0, "link.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_SUCCESS);
    const { ret: r2, data } = (fd_obj as BridgeFd).fd_read(100);
    expect(r2).toBe(ERRNO_SUCCESS);
    expect(decode(data)).toBe("hello from the mount\n");
  });
});

describe("BridgeFd reads and seeks", () => {
  test("fd_read advances the file position", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const a = file.fd_read(5);
    const b = file.fd_read(100);
    expect(decode(a.data)).toBe("hello");
    expect(decode(b.data)).toBe(" from the mount\n");
  });

  test("fd_pread is positional and does not move the cursor", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const r = file.fd_pread(5, 6n);
    expect(decode(r.data)).toBe("from ");
    expect(file.fd_tell().offset).toBe(0n);
  });

  test("fd_seek to a past-end position yields an empty read (EOF)", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(file.fd_seek(999n, wasi.WHENCE_SET).ret).toBe(ERRNO_SUCCESS);
    const { ret, data } = file.fd_read(100);
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(data.length).toBe(0);
  });

  test("fd_seek from the end works", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const { offset } = file.fd_seek(-6n, wasi.WHENCE_END);
    expect(offset).toBe(BigInt("hello from the mount\n".length - 6));
    const { data } = file.fd_read(100);
    expect(decode(data)).toBe("mount\n");
  });

  test("fd_seek negative is INVAL", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(file.fd_seek(-1n, wasi.WHENCE_SET).ret).toBe(ERRNO_INVAL);
  });

  test("directory fd_read is BADF", () => {
    const dir = root().path_open(0, "sub", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(dir.fd_read(100).ret).toBe(ERRNO_BADF);
  });
});

describe("BridgeFd readdir", () => {
  test("lists ., .., then the fixture entries", () => {
    const dir = root().path_open(0, ".", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const names: Array<[string, number]> = [];
    let cookie = 0n;
    for (;;) {
      const { ret, dirent } = dir.fd_readdir_single(cookie);
      expect(ret).toBe(ERRNO_SUCCESS);
      if (!dirent) {
        break;
      }
      names.push([dirent.dir_name !== undefined ? new TextDecoder().decode(dirent.dir_name) : "", dirent.d_type]);
      cookie = dirent.d_next;
    }
    expect(names.map(([n]) => n).sort()).toEqual([".", "..", "hello.txt", "link.txt", "sub"]);
  });

  test("reports the symlink entry as a symlink", () => {
    const dir = root().path_open(0, ".", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const seen: Array<[string, number]> = [];
    let cookie = 0n;
    for (;;) {
      const { dirent } = dir.fd_readdir_single(cookie);
      if (!dirent) {
        break;
      }
      seen.push([new TextDecoder().decode(dirent.dir_name), dirent.d_type]);
      cookie = dirent.d_next;
    }
    const link = seen.find(([n]) => n === "link.txt");
    expect(link?.[1]).toBe(FILETYPE_SYMBOLIC_LINK);
  });
});

describe("BridgeFd stat", () => {
  test("path_filestat_get of a file", () => {
    const { ret, filestat } = root().path_filestat_get(0, "hello.txt");
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(filestat?.filetype).toBe(FILETYPE_REGULAR_FILE);
  });

  test("path_filestat_get of a directory", () => {
    const { filestat } = root().path_filestat_get(0, "sub");
    expect(filestat?.filetype).toBe(FILETYPE_DIRECTORY);
  });

  test("path_filestat_get of a virtual symlink reports symlink type", () => {
    const { filestat } = root().path_filestat_get(0, "link.txt");
    expect(filestat?.filetype).toBe(FILETYPE_SYMBOLIC_LINK);
  });

  test("path_filestat_get of a missing path is ENOENT", () => {
    expect(root().path_filestat_get(0, "missing").ret).toBe(ERRNO_NOENT);
  });

  test("fd_filestat_get of an opened file", () => {
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    const { ret, filestat } = file.fd_filestat_get();
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(filestat?.filetype).toBe(FILETYPE_REGULAR_FILE);
  });
});

describe("BridgeFd readlink", () => {
  test("resolves a virtual symlink", () => {
    const { ret, data } = root().path_readlink("link.txt");
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(data).toBe("hello.txt");
  });

  test("regular file is INVAL", () => {
    const { ret } = root().path_readlink("hello.txt");
    expect(ret).toBe(ERRNO_NOENT);
  });
});

describe("BridgeFd writes are rejected EROFS", () => {
  const file = () => root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
  const dir = () => root().path_open(0, "sub", 0, 0n, 0n, 0).fd_obj as BridgeFd;

  test("fd_write / fd_pwrite", () => {
    expect(file().fd_write(new Uint8Array([1])).ret).toBe(ERRNO_ROFS);
    expect(file().fd_pwrite(new Uint8Array([1]), 0n).ret).toBe(ERRNO_ROFS);
  });

  test("fd_filestat_set_size / times / flags", () => {
    expect(file().fd_filestat_set_size(10n)).toBe(ERRNO_ROFS);
    expect(file().fd_filestat_set_times(0n, 0n, 0)).toBe(ERRNO_ROFS);
    expect(file().fd_fdstat_set_flags(0)).toBe(ERRNO_ROFS);
  });

  test("path mutations on a directory", () => {
    expect(dir().path_create_directory("x")).toBe(ERRNO_ROFS);
    expect(dir().path_unlink_file("hello.txt")).toBe(ERRNO_ROFS);
    expect(dir().path_remove_directory("sub")).toBe(ERRNO_ROFS);
    expect(dir().path_rename("hello.txt", 0, "x.txt")).toBe(ERRNO_ROFS);
    expect(dir().path_unlink("hello.txt").ret).toBe(ERRNO_ROFS);
  });
});

describe("BridgeFd fdstat and prestat", () => {
  test("prestat names the guest path on the root only", () => {
    const r = root();
    const { ret, prestat } = r.fd_prestat_get();
    expect(ret).toBe(ERRNO_SUCCESS);
    expect(new TextDecoder().decode(prestat?.inner.pr_name)).toBe("/mnt/host");

    const sub = r.path_open(0, "sub", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(sub.fd_prestat_get().ret).toBe(ERRNO_BADF);
  });

  test("fd_fdstat_get reports directory vs regular file", () => {
    expect(root().fd_fdstat_get().fdstat?.fs_filetype).toBe(FILETYPE_DIRECTORY);
    const file = root().path_open(0, "hello.txt", 0, 0n, 0n, 0).fd_obj as BridgeFd;
    expect(file.fd_fdstat_get().fdstat?.fs_filetype).toBe(FILETYPE_REGULAR_FILE);
  });
});

// Two fields the shim's Filestat constructor does not take, both of which
// escape the bridge when they are left at their defaults: a mtime of 0 reaches
// the guest as `Jan  1  1970` on every entry — which a model then reports to the
// user as the file's creation date (PLAN §10.21) — and an nlink of 0 is a
// number no filesystem produces, which fts reads as a subdirectory count.
describe("BridgeFd filestat metadata", () => {
  test("a file carries its modification time, in nanoseconds", () => {
    const { ret, fd_obj } = root().path_open(0, "hello.txt", 0, 0n, 0n, 0);
    expect(ret).toBe(ERRNO_SUCCESS);
    const { filestat } = fd_obj!.fd_filestat_get();
    expect(filestat!.mtim).toBe(BigInt(FAKE_MTIME_MS) * 1_000_000n);
    // atim and ctim repeat it rather than staying at the epoch: this filesystem
    // knows one timestamp, and answering 1970 for the other two would make
    // `ls -lu` and `find -newer` confidently wrong.
    expect(filestat!.atim).toBe(filestat!.mtim);
    expect(filestat!.ctim).toBe(filestat!.mtim);
  });

  test("nothing reports a link count of zero", () => {
    const dir = root();
    expect(dir.fd_filestat_get().filestat!.nlink).toBe(1n);
    const { fd_obj } = dir.path_open(0, "hello.txt", 0, 0n, 0n, 0);
    expect(fd_obj!.fd_filestat_get().filestat!.nlink).toBe(1n);
  });

  test("an entry with no known time is left unknown rather than dated to 1970", () => {
    // Directories have no File and therefore no date. Absent is honest; an
    // invented one sorts wrongly where a missing one sorts last.
    const { fd_obj } = root().path_open(0, "sub", 0, 0n, 0n, 0);
    expect(fd_obj!.fd_filestat_get().filestat!.mtim).toBe(0n);
    expect(fd_obj!.fd_filestat_get().filestat!.nlink).toBe(1n);
  });
});
