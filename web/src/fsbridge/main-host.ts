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
}

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

  private async stat(path: string): Promise<StatResponse> {
    if (this.virtualLinks.has(path)) {
      return { op: OpStat, errno: ERRNO_SUCCESS, filetype: FILETYPE_SYMBOLIC_LINK, size: 0 };
    }
    if (path === "/") {
      return { op: OpStat, errno: ERRNO_SUCCESS, filetype: FILETYPE_DIRECTORY, size: 0 };
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
      const st: StatResponse = { op: OpStat, errno: ERRNO_SUCCESS, filetype: FILETYPE_DIRECTORY, size: 0 };
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
    };
    this.statCache.set(path, st);
    return st;
  }

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
