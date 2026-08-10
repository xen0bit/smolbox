// Worker-side half of the sync FS bridge: an Fd subclass that satisfies the
// browser_wasi_shim's synchronous Fd contract while the real filesystem lives
// on the main thread. Every method blocks on Atomics.wait while the main
// thread performs the async handle read, then returns. It is stateless except
// for the position/readdir cursor the Fd contract itself requires; all content
// caching lives in the MountHost on the main thread.

import { Fd, wasi } from "@bjorn3/browser_wasi_shim";
import {
  BRIDGE_PAYLOAD_SIZE,
  BridgeClient,
  StatResponse,
  inoOf,
} from "./protocol.ts";

// Normalize a WASI-relative path against an fd's base path, mirroring the
// shim's Path.from: absolute paths and `..` above the mount root are rejected
// (the guest's own VFS resolves `..` above the bind mount before any 9p
// request reaches us, so this is a defensive boundary, not the primary one).
function normalizePath(rel: string, base: string): { errno: number; path: string } {
  if (rel.startsWith("/")) {
    return { errno: wasi.ERRNO_NOTCAPABLE, path: "" };
  }
  if (rel.includes("\0")) {
    return { errno: wasi.ERRNO_INVAL, path: "" };
  }
  const parts = base === "/" ? [] : base.split("/").filter((p) => p.length > 0);
  for (const comp of rel.split("/")) {
    if (comp === "" || comp === ".") {
      continue;
    }
    if (comp === "..") {
      if (parts.length === 0) {
        return { errno: wasi.ERRNO_NOTCAPABLE, path: "" };
      }
      parts.pop();
      continue;
    }
    parts.push(comp);
  }
  return { errno: wasi.ERRNO_SUCCESS, path: "/" + parts.join("/") };
}

// Resolve a symlink target against the directory containing the symlink.
// Absolute targets are treated as mount-root-relative. Escapes are rejected.
function resolveLink(symPath: string, target: string): string | null {
  const parent = symPath.slice(0, symPath.lastIndexOf("/"));
  const base = parent === "" ? "/" : parent;
  const norm = normalizePath(target, base);
  return norm.errno === wasi.ERRNO_SUCCESS ? norm.path : null;
}

function toFilestat(st: StatResponse, path: string): wasi.Filestat {
  return new wasi.Filestat(inoOf(path), st.filetype ?? 0, BigInt(st.size ?? 0));
}

export type BridgeFdKind = "dir" | "file";

export class BridgeFd extends Fd {
  private filePos = 0n;
  private dirEntries: Array<{ name: string; type: number }> | null = null;
  private statCache: StatResponse | null;

  constructor(
    private channel: BridgeClient,
    readonly basePath: string,
    private kind: BridgeFdKind,
    private prestatName?: string,
    openingStat?: StatResponse,
  ) {
    super();
    this.statCache = openingStat ?? null;
  }

  // The mount is read-only at the bridge boundary: every write op returns
  // EROFS without touching the main thread at all. The guest therefore sees
  // the same "Invalid argument" a wazero WithReadOnlyDirMount surfaces.
  fd_allocate(_offset: bigint, _len: bigint): number {
    return wasi.ERRNO_ROFS;
  }

  fd_fdstat_get() {
    const type = this.kind === "dir" ? wasi.FILETYPE_DIRECTORY : wasi.FILETYPE_REGULAR_FILE;
    return { ret: wasi.ERRNO_SUCCESS, fdstat: new wasi.Fdstat(type, 0) };
  }

  fd_filestat_get() {
    const st = this.stat(this.basePath);
    if (st.errno !== 0) {
      return { ret: st.errno, filestat: null };
    }
    return { ret: wasi.ERRNO_SUCCESS, filestat: toFilestat(st, this.basePath) };
  }

  fd_prestat_get() {
    if (!this.prestatName) {
      return { ret: wasi.ERRNO_BADF, prestat: null };
    }
    return { ret: wasi.ERRNO_SUCCESS, prestat: wasi.Prestat.dir(this.prestatName) };
  }

  fd_read(size: number) {
    if (this.kind !== "file") {
      return { ret: wasi.ERRNO_BADF, data: new Uint8Array(0) };
    }
    const { ret, data } = this.preadChunked(size, this.filePos);
    if (ret !== 0) {
      return { ret, data: new Uint8Array(0) };
    }
    this.filePos += BigInt(data.length);
    return { ret: wasi.ERRNO_SUCCESS, data };
  }

  fd_pread(size: number, offset: bigint) {
    if (this.kind !== "file") {
      return { ret: wasi.ERRNO_BADF, data: new Uint8Array(0) };
    }
    return this.preadChunked(size, offset);
  }

  // Cookie protocol: 0 is `.`, 1 is `..`, then real entries start at 2. The
  // entry list for the directory is fetched once (one readdir op) and cached
  // on this Fd for the readdir iteration; the next cookie is the `next` field
  // WASI expects. Inodes come from the shared deterministic inoOf(path) so
  // d_ino agrees with filestat.ino across the two ends without shipping them.
  fd_readdir_single(cookie: bigint) {
    if (this.kind !== "dir") {
      return { ret: wasi.ERRNO_BADF, dirent: null };
    }
    if (cookie === 0n) {
      return {
        ret: wasi.ERRNO_SUCCESS,
        dirent: new wasi.Dirent(1n, inoOf(this.basePath), ".", wasi.FILETYPE_DIRECTORY),
      };
    }
    if (cookie === 1n) {
      const parent = this.basePath === "/" ? "/" : this.basePath.slice(0, this.basePath.lastIndexOf("/"));
      return {
        ret: wasi.ERRNO_SUCCESS,
        dirent: new wasi.Dirent(2n, inoOf(parent), "..", wasi.FILETYPE_DIRECTORY),
      };
    }
    if (this.dirEntries === null) {
      const resp = this.channel.readdir(this.basePath);
      if (resp.errno !== 0) {
        return { ret: resp.errno, dirent: null };
      }
      this.dirEntries = resp.entries ?? [];
    }
    const i = Number(cookie - 2n);
    if (i >= this.dirEntries.length) {
      return { ret: wasi.ERRNO_SUCCESS, dirent: null };
    }
    const e = this.dirEntries[i];
    const p = this.basePath === "/" ? "/" + e.name : `${this.basePath}/${e.name}`;
    return {
      ret: wasi.ERRNO_SUCCESS,
      dirent: new wasi.Dirent(cookie + 1n, inoOf(p), e.name, e.type),
    };
  }

  fd_seek(offset: bigint, whence: number) {
    if (this.kind !== "file") {
      return { ret: wasi.ERRNO_BADF, offset: 0n };
    }
    let calc: bigint;
    switch (whence) {
      case wasi.WHENCE_SET:
        calc = offset;
        break;
      case wasi.WHENCE_CUR:
        calc = this.filePos + offset;
        break;
      case wasi.WHENCE_END: {
        const st = this.stat(this.basePath);
        if (st.errno !== 0) {
          return { ret: st.errno, offset: 0n };
        }
        calc = BigInt(st.size ?? 0) + offset;
        break;
      }
      default:
        return { ret: wasi.ERRNO_INVAL, offset: 0n };
    }
    if (calc < 0n) {
      return { ret: wasi.ERRNO_INVAL, offset: 0n };
    }
    this.filePos = calc;
    return { ret: wasi.ERRNO_SUCCESS, offset: this.filePos };
  }

  fd_tell() {
    if (this.kind !== "file") {
      return { ret: wasi.ERRNO_BADF, offset: 0n };
    }
    return { ret: wasi.ERRNO_SUCCESS, offset: this.filePos };
  }

  path_filestat_get(_flags: number, path: string) {
    const norm = normalizePath(path, this.basePath);
    if (norm.errno !== 0) {
      return { ret: norm.errno, filestat: null };
    }
    const st = this.stat(norm.path);
    if (st.errno !== 0) {
      return { ret: st.errno, filestat: null };
    }
    return { ret: wasi.ERRNO_SUCCESS, filestat: toFilestat(st, norm.path) };
  }

  path_readlink(path: string) {
    const norm = normalizePath(path, this.basePath);
    if (norm.errno !== 0) {
      return { ret: norm.errno, data: null };
    }
    const resp = this.channel.readlink(norm.path);
    if (resp.errno !== 0) {
      return { ret: resp.errno, data: null };
    }
    return { ret: wasi.ERRNO_SUCCESS, data: resp.target ?? "" };
  }

  path_open(
    dirflags: number,
    path: string,
    oflags: number,
    fs_rights_base: bigint,
    _fs_rights_inheriting: bigint,
    _fd_flags: number,
  ) {
    if (this.kind !== "dir") {
      return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    }
    const norm = normalizePath(path, this.basePath);
    if (norm.errno !== 0) {
      return { ret: norm.errno, fd_obj: null };
    }
    if ((oflags & (wasi.OFLAGS_CREAT | wasi.OFLAGS_TRUNC)) !== 0) {
      return { ret: wasi.ERRNO_ROFS, fd_obj: null };
    }
    if ((fs_rights_base & BigInt(wasi.RIGHTS_FD_WRITE)) !== 0n) {
      return { ret: wasi.ERRNO_ROFS, fd_obj: null };
    }
    // Symlinks (the bridge's virtual table) resolve here, on the open path:
    // readlink once, normalize the target against the symlink's directory
    // (absolute targets are mount-root-relative; escapes rejected), then stat
    // the resolved path and open that instead. Unresolvable -> ELOOP.
    let target = norm.path;
    let st = this.stat(target);
    if (st.errno !== 0) {
      return { ret: st.errno, fd_obj: null };
    }
    if (st.filetype === wasi.FILETYPE_SYMBOLIC_LINK) {
      const rl = this.channel.readlink(target);
      if (rl.errno !== 0) {
        return { ret: rl.errno, fd_obj: null };
      }
      const resolved = resolveLink(target, rl.target ?? "");
      if (!resolved) {
        return { ret: wasi.ERRNO_LOOP, fd_obj: null };
      }
      st = this.stat(resolved);
      if (st.errno !== 0) {
        return { ret: st.errno, fd_obj: null };
      }
      target = resolved;
    }
    if ((oflags & wasi.OFLAGS_DIRECTORY) !== 0 && st.filetype !== wasi.FILETYPE_DIRECTORY) {
      return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    }
    const kind: BridgeFdKind = st.filetype === wasi.FILETYPE_DIRECTORY ? "dir" : "file";
    return {
      ret: wasi.ERRNO_SUCCESS,
      fd_obj: new BridgeFd(this.channel, target, kind, undefined, st),
    };
  }

  // ---- read-only: all mutations rejected at the boundary ----
  fd_write(_data: Uint8Array) {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  fd_pwrite(_data: Uint8Array, _offset: bigint) {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  fd_filestat_set_size(_size: bigint): number {
    return wasi.ERRNO_ROFS;
  }

  fd_filestat_set_times(_atim: bigint, _mtim: bigint, _fst_flags: number): number {
    return wasi.ERRNO_ROFS;
  }

  fd_fdstat_set_flags(_flags: number): number {
    return wasi.ERRNO_ROFS;
  }

  fd_fdstat_set_rights(_fs_rights_base: bigint, _fs_rights_inheriting: bigint): number {
    return wasi.ERRNO_ROFS;
  }

  path_create_directory(_path: string): number {
    return wasi.ERRNO_ROFS;
  }

  path_link(_path: string, _inode: unknown, _allow_dir: boolean): number {
    return wasi.ERRNO_ROFS;
  }

  path_unlink(_path: string) {
    return { ret: wasi.ERRNO_ROFS, inode_obj: null };
  }

  path_unlink_file(_path: string): number {
    return wasi.ERRNO_ROFS;
  }

  path_remove_directory(_path: string): number {
    return wasi.ERRNO_ROFS;
  }

  path_rename(_old_path: string, _new_fd: number, _new_path: string): number {
    return wasi.ERRNO_ROFS;
  }

  path_filestat_set_times(
    _flags: number,
    _path: string,
    _atim: bigint,
    _mtim: bigint,
    _fst_flags: number,
  ): number {
    return wasi.ERRNO_ROFS;
  }

  // A read larger than the bridge payload window is issued as repeated
  // BRIDGE_PAYLOAD_SIZE (1 MiB) ops and concatenated. A mid-read error with
  // partial data returns what was read rather than failing; a short chunk ends
  // the loop (EOF).
  private preadChunked(size: number, offset: bigint): { ret: number; data: Uint8Array } {
    const parts: Uint8Array[] = [];
    let pos = offset;
    let remaining = size;
    while (remaining > 0) {
      const want = Math.min(remaining, BRIDGE_PAYLOAD_SIZE);
      const resp = this.channel.read(this.basePath, Number(pos), want);
      if (resp.errno !== 0) {
        if (parts.length === 0) {
          return { ret: resp.errno, data: new Uint8Array(0) };
        }
        break;
      }
      const chunk = resp.data ?? new Uint8Array(0);
      parts.push(chunk);
      if (chunk.length === 0) {
        break;
      }
      pos += BigInt(chunk.length);
      remaining -= chunk.length;
      if (chunk.length < want) {
        break;
      }
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { ret: wasi.ERRNO_SUCCESS, data: out };
  }

  // stat consults the opening stat (the one captured when this Fd was opened)
  // for the path itself, avoiding a round trip on the common case; every other
  // path goes to the main thread, whose MountHost memoizes STAT results.
  private stat(path: string): StatResponse {
    if (this.statCache && path === this.basePath) {
      return this.statCache;
    }
    return this.channel.stat(path);
  }
}

// Build the root preopen Fd for a mount. basePath "/" is the mount root; the
// prestat name is what the guest sees as the preopen directory name.
export function createBridgeFd(channel: BridgeClient, guestPath: string): BridgeFd {
  return new BridgeFd(channel, "/", "dir", guestPath);
}
