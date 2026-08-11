// Main-thread half of the sync FS bridge. Holds the File System Access handle
// (the only place that touch is legal — the main thread is the one that can
// perform async reads), all caching, and the virtual symlink table. Never
// blocks: it serves each bridge request from an onmessage callback, awaiting
// the handle operations while the worker sleeps in Atomics.wait.
//
// All caching lives here, not in the worker. The worker cannot receive
// postMessage while the module runs, so worker-side cache invalidation on
// remount() would need an epoch dance through the SAB; keeping the caches and
// the handle on this thread makes remount() a plain cache clear.

import {
  BridgeChannel,
  BridgeRequest,
  BridgeResponse,
  ERRNO_IO,
  ERRNO_NOENT,
  ERRNO_SUCCESS,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  FILETYPE_SYMBOLIC_LINK,
  OpRead,
  OpReaddir,
  OpReadlink,
  OpStat,
  ReadRequest,
  ReadResponse,
  ReaddirEntry,
  ReaddirRequest,
  ReaddirResponse,
  ReadlinkRequest,
  ReadlinkResponse,
  StatRequest,
  StatResponse,
} from "./protocol.ts";

// Structural types for the File System Access API. The browser's real
// FileSystemDirectoryHandle/FileSystemFileHandle satisfy these; the fake
// backends in the unit tests do too. No DOM lib required.
export interface BlobLike {
  readonly size: number;
  /**
   * Milliseconds since the epoch, as `File` reports it.
   *
   * Optional because this shape is deliberately narrower than `File` — the tests
   * satisfy it with a plain object — and because a Blob that is not a File has
   * no date. Absent reaches the guest as an unknown mtime rather than as 1970.
   */
  readonly lastModified?: number;
  slice(start?: number, end?: number): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileHandleLike {
  readonly kind: "file";
  getFile(): Promise<BlobLike>;
}

export interface DirectoryHandleLike {
  readonly kind: "directory";
  getFileHandle(name: string): Promise<FileHandleLike>;
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>;
  entries(): AsyncIterable<[string, FileHandleLike | DirectoryHandleLike]>;
}

export type HandleLike = FileHandleLike | DirectoryHandleLike;

export interface StorageManagerLike {
  getDirectory(): Promise<DirectoryHandleLike>;
  /** Not everywhere, and refusable. The model cache asks and moves on. */
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

/**
 * The mount, as the guest sees it.
 *
 * Every cache below is unbounded in time and invalidated only by `setHandle` or
 * `setVirtualLinks`, which is a deliberate choice and a real limitation: a file
 * edited on disk *during* a session keeps its old size, date and contents inside
 * the guest until the folder is picked again. The alternative is re-stat'ing on
 * every syscall, and the guest issues a lot of them — `cat` of a large file is
 * hundreds of reads through this class — so a session-consistent view is what
 * gets bought with it. Re-picking the folder is the refresh, and it is one
 * click.
 */
export class MountHost {
  private channel: BridgeChannel | null = null;
  private handle: DirectoryHandleLike | null = null;
  private virtualLinks = new Map<string, string>();
  private statCache = new Map<string, StatResponse>();
  private dirCache = new Map<string, ReaddirEntry[]>();
  private handleCache = new Map<string, HandleLike | null>();
  private fileCache = new Map<string, BlobLike>();
  private chunkCache = new LRU<string, Uint8Array>(512);

  // Wire the worker's fsbridge SAB (received as {type:"fschannel"}).
  attach(sab: SharedArrayBuffer): void {
    this.channel = new BridgeChannel(sab);
  }

  // Called when the worker's {type:"fsreq"} wake arrives.
  serve(): void {
    const ch = this.channel;
    if (!ch) {
      return;
    }
    void this.serveAsync(ch);
  }

  // Swap the mounted directory. Clears every cache; the next request resolves
  // against the new handle. A null handle turns the mount into an empty dir.
  setHandle(handle: DirectoryHandleLike | null): void {
    this.clear();
    this.handle = handle;
  }

  // Register virtual symlinks (path -> target). The File System Access API has
  // no symlink concept, so the bridge presents them itself; the conformance
  // fixture derives this table from testdata/mount's real symlink.
  setVirtualLinks(links: Record<string, string>): void {
    this.clear();
    this.virtualLinks = new Map(
      Object.entries(links).filter(([, target]) => typeof target === "string") as [string, string][],
    );
  }

  remount(handle: DirectoryHandleLike | null, links?: Record<string, string>): void {
    this.clear();
    this.handle = handle;
    this.virtualLinks = new Map(
      Object.entries(links ?? {}).filter(([, target]) => typeof target === "string") as [
        string,
        string,
      ][],
    );
  }

  mounted(): boolean {
    return this.handle !== null;
  }

  private async serveAsync(ch: BridgeChannel): Promise<void> {
    const req = ch.readRequest();
    if (!req) {
      return;
    }
    let resp: BridgeResponse;
    try {
      resp = await this.dispatch(req);
    } catch (err) {
      console.error("fsbridge: dispatch failed", err);
      resp = { op: req.op, errno: ERRNO_IO } as BridgeResponse;
    }
    ch.respond(resp, resp.op === OpRead ? resp.data : undefined);
  }

  // Serve one pending bridge request (called from the fsreq wake). The request
  // bytes are read synchronously before any await, so the worker cannot race.
  // A dispatch exception becomes an EIO response rather than throwing: the
  // worker is asleep in Atomics.wait and only the response store wakes it, so
  // an unhandled error here would strand the guest for the full bridge timeout.
  dispatch(req: StatRequest): Promise<StatResponse>;
  dispatch(req: ReaddirRequest): Promise<ReaddirResponse>;
  dispatch(req: ReadRequest): Promise<ReadResponse>;
  dispatch(req: ReadlinkRequest): Promise<ReadlinkResponse>;
  dispatch(req: BridgeRequest): Promise<BridgeResponse>;
  async dispatch(req: BridgeRequest): Promise<BridgeResponse> {
    switch (req.op) {
      case OpStat:
        return this.stat(req.path);
      case OpReaddir:
        return this.readdir(req.path);
      case OpRead:
        return this.read(req.path, req.offset, req.len);
      case OpReadlink:
        return this.readlink(req.path);
    }
  }

  // stat resolves virtual symlinks first (no handle involved), then the mount
  // root, then a memoized STAT; misses are not cached (a later remount can
  // create them), hits are. A file's size comes from getFile.
  private async stat(path: string): Promise<StatResponse> {
    // nlink is 1 everywhere here, and that is a claim rather than a count: this
    // filesystem has no hard links to count, and 1 is the conventional way to
    // tell fts not to derive a subdirectory count from it. See StatResponse.
    if (this.virtualLinks.has(path)) {
      return { op: OpStat, errno: ERRNO_SUCCESS, filetype: FILETYPE_SYMBOLIC_LINK, size: 0, nlink: 1 };
    }
    if (path === "/") {
      return { op: OpStat, errno: ERRNO_SUCCESS, filetype: FILETYPE_DIRECTORY, size: 0, nlink: 1 };
    }
    const cached = this.statCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const handle = await this.lookup(path);
    if (!handle) {
      return { op: OpStat, errno: ERRNO_NOENT };
    }
    if (handle.kind === "directory") {
      // A directory handle carries no timestamp — the File System Access API
      // only dates files — so it has none to report. Absent beats invented: a
      // fabricated mtime sorts wrongly, where a missing one sorts last.
      const st: StatResponse = {
        op: OpStat,
        errno: ERRNO_SUCCESS,
        filetype: FILETYPE_DIRECTORY,
        size: 0,
        nlink: 1,
      };
      this.statCache.set(path, st);
      return st;
    }
    const file = await this.getFile(path);
    if (!file) {
      return { op: OpStat, errno: ERRNO_NOENT };
    }
    const st: StatResponse = {
      op: OpStat,
      errno: ERRNO_SUCCESS,
      filetype: FILETYPE_REGULAR_FILE,
      size: file.size,
      // Free, and the whole reason mtimeMs exists: the picker already read this
      // File, and its date is the one the user sees in their own file manager.
      mtimeMs: file.lastModified,
      nlink: 1,
    };
    this.statCache.set(path, st);
    return st;
  }

  // readdir is memoized per path. With no mount attached, the root still lists
  // its virtual symlinks (the VM boots with an empty mount; the symlink table
  // is registered separately from the handle). Real entries are enumerated
  // from the handle and prefixed by this directory's virtual links.
  private async readdir(path: string): Promise<ReaddirResponse> {
    const cached = this.dirCache.get(path);
    if (cached !== undefined) {
      return { op: OpReaddir, errno: ERRNO_SUCCESS, entries: cached };
    }
    if (path === "/" && !this.handle) {
      const onlyVirtual = this.virtualInDir(path);
      this.dirCache.set(path, onlyVirtual);
      return { op: OpReaddir, errno: ERRNO_SUCCESS, entries: onlyVirtual };
    }
    const dir = await this.lookup(path);
    if (!dir || dir.kind !== "directory") {
      return { op: OpReaddir, errno: ERRNO_NOENT };
    }
    const entries: ReaddirEntry[] = [];
    for await (const [name, child] of (dir as DirectoryHandleLike).entries()) {
      entries.push({
        name,
        type: child.kind === "directory" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE,
      });
    }
    const all = [...this.virtualInDir(path), ...entries];
    this.dirCache.set(path, all);
    return { op: OpReaddir, errno: ERRNO_SUCCESS, entries: all };
  }

  // read serves a byte window of a file. Chunks are cached in an LRU keyed by
  // exact `path@offset:len`, which is what makes sequential `cat` of a large
  // file cheap without caching the whole file. The window is clamped to the
  // file's size; reads beyond EOF return zero bytes.
  private async read(path: string, offset: number, len: number): Promise<ReadResponse> {
    const file = await this.getFile(path);
    if (!file) {
      return { op: OpRead, errno: ERRNO_NOENT };
    }
    const key = `${path}@${offset}:${len}`;
    const cached = this.chunkCache.get(key);
    if (cached !== undefined) {
      return { op: OpRead, errno: ERRNO_SUCCESS, len: cached.length, data: cached };
    }
    const end = Math.min(file.size, offset + len);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    if (bytes.length > 0) {
      this.chunkCache.set(key, bytes);
    }
    return { op: OpRead, errno: ERRNO_SUCCESS, len: bytes.length, data: bytes };
  }

  private readlink(path: string): ReadlinkResponse {
    const target = this.virtualLinks.get(path);
    if (target !== undefined) {
      return { op: OpReadlink, errno: ERRNO_SUCCESS, target };
    }
    return { op: OpReadlink, errno: ERRNO_NOENT };
  }

  // virtualInDir finds the virtual links that are direct children of a
  // directory — a path under the prefix with no further `/`. readdir reports
  // them as FILETYPE_SYMBOLIC_LINK, so the guest sees a symlink even though
  // the File System Access API cannot represent one.
  private virtualInDir(parent: string): ReaddirEntry[] {
    const out: ReaddirEntry[] = [];
    const prefix = parent === "/" ? "/" : `${parent}/`;
    for (const [p] of this.virtualLinks) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) {
          out.push({ name: rest, type: FILETYPE_SYMBOLIC_LINK });
        }
      }
    }
    return out;
  }

  // lookup walks a path segment by segment to a handle. The final segment
  // accepts either kind (getFileHandle first, then getDirectoryHandle);
  // intermediates must be directories. Results — including null misses — are
  // memoized so a repeated missing path does not re-probe the handle.
  private async lookup(path: string): Promise<HandleLike | null> {
    const cached = this.handleCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    let h: HandleLike | null = this.handle;
    const parts = path.split("/").filter((p) => p.length > 0);
    for (let i = 0; i < parts.length && h !== null; i++) {
      const name = parts[i];
      if (h.kind !== "directory") {
        h = null;
        break;
      }
      const dir = h as DirectoryHandleLike;
      if (i === parts.length - 1) {
        h = await getEntry(dir, name);
      } else {
        try {
          h = await dir.getDirectoryHandle(name);
        } catch {
          h = null;
        }
      }
    }
    this.handleCache.set(path, h);
    return h;
  }

  private async getFile(path: string): Promise<BlobLike | null> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const h = await this.lookup(path);
    if (!h || h.kind !== "file") {
      return null;
    }
    const file = await (h as FileHandleLike).getFile();
    this.fileCache.set(path, file);
    return file;
  }

  private clear(): void {
    this.statCache.clear();
    this.dirCache.clear();
    this.handleCache.clear();
    this.fileCache.clear();
    this.chunkCache.clear();
  }
}

// getEntry resolves one name to a handle of either kind, probing file first
// then directory. The File System Access API has no "does this name exist"
// call that returns both kinds, so this is the structural seam a fake handle
// (unit tests) and the webkitdirectory rebuild must both satisfy.
async function getEntry(dir: DirectoryHandleLike, name: string): Promise<HandleLike | null> {
  try {
    return await dir.getFileHandle(name);
  } catch {
    // not a file (missing, or a directory under that name)
  }
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    // not a directory either
  }
  return null;
}

class LRU<K, V> {
  private map = new Map<K, V>();

  constructor(private cap: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next().value as K;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
