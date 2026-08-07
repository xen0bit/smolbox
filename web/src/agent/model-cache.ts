// A chunked IndexedDB cache for model weights.
//
// transformers.js ships two caching backends and neither one works at this
// size. Cache Storage refuses a single multi-hundred-megabyte entry — the put
// fails with an opaque "Unexpected internal error" — and the HTTP cache beneath
// it is worse: Chromium's disk cache will not store an entry anywhere near the
// size of an ONNX checkpoint, so the `Cache-Control: max-age` serve.ts already
// sends for /models/ buys nothing at all. The observable result was a full
// re-download of every weight on every reload, local server or hub alike.
//
// So we take the third option transformers.js offers, `env.useCustomCache` with
// an object shaped like the Cache API, and split each file into chunks small
// enough that no single IndexedDB value is unusual. That is the same shape the
// Gemma kernel bundle already uses for safetensors (its own safetensors-cache-v1
// database), which is the standing proof that this survives a reload here.
//
// Everything in this file degrades to a cache miss rather than an error. The
// caller is holding the bytes already and only asked us to remember them; a
// failure to do so must never fail a model load.

/** The subset of IndexedDB this cache uses. Structural, like web-globals.d.ts. */
export interface IdbRequestLike<T> {
  result: T;
  error: { name?: string; message?: string } | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

export interface IdbObjectStoreLike {
  get(key: unknown): IdbRequestLike<unknown>;
  getAll(query?: unknown): IdbRequestLike<unknown[]>;
  put(value: unknown): IdbRequestLike<unknown>;
  delete(key: unknown): IdbRequestLike<unknown>;
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  error: { name?: string; message?: string } | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string | string[] }): IdbObjectStoreLike;
  transaction(stores: string[], mode: "readonly" | "readwrite"): IdbTransactionLike;
  close(): void;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
  deleteDatabase(name: string): IdbRequestLike<unknown>;
}

export interface IdbKeyRangeLike {
  bound(lower: unknown, upper: unknown): unknown;
}

/** What transformers.js passes to a custom cache's `put` progress callback. */
export interface CacheProgress {
  progress: number;
  loaded: number;
  total: number;
}

/** One cached file. The chunks themselves live in their own store. */
export interface CacheEntry {
  /** The cache key transformers.js chose: a local path, or a hub URL. */
  key: string;
  size: number;
  chunks: number;
  chunkSize: number;
  /** From the response that produced this entry. Drives revalidation. */
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  storedAt: number;
}

// Bumped only when the record layout changes: the name is the schema, so a bump
// is a hard invalidate rather than a migration nobody would test.
const DB_NAME = "smolbox-model-cache-v1";
const META_STORE = "meta";
const CHUNK_STORE = "chunks";

// Large enough that a 1.4 GB checkpoint is ~45 values rather than thousands,
// small enough that no single value approaches the size that breaks Cache
// Storage. The kernel bundle's 256 KB is tuned for windowed reads; these are
// whole-file reads and want the opposite trade.
export const CHUNK_BYTES = 32 * 1024 * 1024;

// A revalidation is a nicety, not a gate. If the server does not answer quickly
// we serve what we have rather than making every reload wait on it.
const REVALIDATE_TIMEOUT_MS = 3000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(message: string): void {
  // The worker has no UI; console is where this lands, next to the
  // "[smolagent]" lines the rest of the page logs.
  console.warn(`[model-cache] ${message}`);
}

/** Await a single IndexedDB request. */
function once<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message ?? "indexeddb request failed"));
  });
}

/**
 * Run one transaction and resolve when it commits.
 *
 * `body` must not await: an IndexedDB transaction closes as soon as the
 * microtask queue drains with no request outstanding, so every await inside one
 * is a race against its own commit. Reads that need the result therefore issue
 * their requests here and read them after the commit resolves.
 */
function commit(
  db: IdbDatabaseLike,
  stores: string[],
  mode: "readonly" | "readwrite",
  body: (tx: IdbTransactionLike) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const fail = () => reject(new Error(tx.error?.message ?? "indexeddb transaction failed"));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
    try {
      body(tx);
    } catch (err) {
      reject(err);
    }
  });
}

/** Carve exactly `n` bytes off the front of a queue of buffers. */
function take(queue: Uint8Array[], n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let need = n;
  while (need > 0) {
    const head = queue[0];
    if (head === undefined) {
      break;
    }
    if (head.byteLength <= need) {
      out.push(head);
      queue.shift();
      need -= head.byteLength;
    } else {
      out.push(head.subarray(0, need));
      queue[0] = head.subarray(need);
      need = 0;
    }
  }
  return out;
}

export interface ModelCacheOptions {
  /** Injected so the unit tests can run under bun, which has no IndexedDB. */
  factory?: IdbFactoryLike;
  keyRange?: IdbKeyRangeLike;
  /** Injected so the tests can exercise revalidation without a server. */
  head?: (url: string) => Promise<{ ok: boolean; etag: string | null }>;
  chunkBytes?: number;
}

async function headRequest(url: string): Promise<{ ok: boolean; etag: string | null }> {
  const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS) });
  return { ok: resp.ok, etag: resp.headers.get("etag") };
}

/**
 * The object handed to `env.customCache`.
 *
 * transformers.js requires `match` and `put` and calls `delete` if present; see
 * getCache() in @huggingface/transformers/src/utils/cache.js.
 */
export class ModelCache {
  private readonly factory: IdbFactoryLike;
  private readonly keyRange: IdbKeyRangeLike;
  private readonly head: (url: string) => Promise<{ ok: boolean; etag: string | null }>;
  private readonly chunkBytes: number;
  private db: Promise<IdbDatabaseLike> | null = null;

  constructor(opts: ModelCacheOptions = {}) {
    this.factory = opts.factory ?? indexedDB;
    this.keyRange = opts.keyRange ?? IDBKeyRange;
    this.head = opts.head ?? headRequest;
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  }

  private open(): Promise<IdbDatabaseLike> {
    if (!this.db) {
      this.db = new Promise<IdbDatabaseLike>((resolve, reject) => {
        const request = this.factory.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains(CHUNK_STORE)) {
            db.createObjectStore(CHUNK_STORE, { keyPath: ["key", "index"] });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(request.error?.message ?? "indexeddb open failed"));
        request.onblocked = () => reject(new Error("indexeddb open blocked by another tab"));
      });
      // A model is gigabytes; without this the browser is free to evict the lot
      // under storage pressure and we are back to downloading on every reload.
      // Best-effort and fire-and-forget: a refusal changes nothing we do.
      this.db.then(() => requestPersistence()).catch(() => {});
    }
    return this.db;
  }

  /** Every chunk record for one key, as an IDBKeyRange over the compound key. */
  private range(key: string): unknown {
    return this.keyRange.bound([key, -Infinity], [key, Infinity]);
  }

  async match(key: string): Promise<Response | undefined> {
    try {
      const db = await this.open();
      const entry = await this.entry(db, key);
      if (!entry) {
        return undefined;
      }
      if (!(await this.fresh(entry))) {
        await this.delete(key);
        return undefined;
      }

      let records: { index: number; blob: Blob }[] = [];
      await commit(db, [CHUNK_STORE], "readonly", (tx) => {
        const req = tx.objectStore(CHUNK_STORE).getAll(this.range(key));
        req.onsuccess = () => {
          records = req.result as { index: number; blob: Blob }[];
        };
      });

      // getAll returns records in key order, so [key, 0], [key, 1], … already.
      // A short read means a torn write we should not have found: treat it as
      // the miss it is and let the caller re-download.
      const blob = new Blob(records.map((r) => r.blob));
      if (records.length !== entry.chunks || blob.size !== entry.size) {
        warn(`dropping incomplete entry for ${key}`);
        await this.delete(key);
        return undefined;
      }

      const headers = new Headers();
      headers.set("content-length", String(blob.size));
      if (entry.contentType) {
        headers.set("content-type", entry.contentType);
      }
      if (entry.etag) {
        headers.set("etag", entry.etag);
      }
      if (entry.lastModified) {
        headers.set("last-modified", entry.lastModified);
      }
      return new Response(blob, { headers });
    } catch (err) {
      warn(`read failed for ${key}: ${describe(err)}`);
      return undefined;
    }
  }

  async put(key: string, response: Response, progress?: (data: CacheProgress) => void): Promise<void> {
    try {
      await this.write(key, response, progress);
    } catch (err) {
      // QuotaExceededError is the expected one here, and it is not fatal: the
      // caller already has the bytes.
      warn(`not caching ${key}: ${describe(err)}`);
      await this.delete(key).catch(() => {});
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const db = await this.open();
      // Meta first, so a tear leaves orphan chunks (which the next write drops)
      // rather than a meta record pointing at chunks that are going away.
      await commit(db, [META_STORE], "readwrite", (tx) => {
        tx.objectStore(META_STORE).delete(key);
      });
      await commit(db, [CHUNK_STORE], "readwrite", (tx) => {
        tx.objectStore(CHUNK_STORE).delete(this.range(key));
      });
      return true;
    } catch (err) {
      warn(`delete failed for ${key}: ${describe(err)}`);
      return false;
    }
  }

  /** Everything currently cached, newest first. Drives the storage panel. */
  async entries(): Promise<CacheEntry[]> {
    try {
      const db = await this.open();
      let rows: CacheEntry[] = [];
      await commit(db, [META_STORE], "readonly", (tx) => {
        const req = tx.objectStore(META_STORE).getAll();
        req.onsuccess = () => {
          rows = req.result as CacheEntry[];
        };
      });
      return rows.sort((a, b) => b.storedAt - a.storedAt);
    } catch (err) {
      warn(`listing failed: ${describe(err)}`);
      return [];
    }
  }

  /** Drop every cached file. Returns how many entries went away. */
  async clear(): Promise<number> {
    const rows = await this.entries();
    let dropped = 0;
    for (const row of rows) {
      if (await this.delete(row.key)) {
        dropped++;
      }
    }
    return dropped;
  }

  private async entry(db: IdbDatabaseLike, key: string): Promise<CacheEntry | undefined> {
    let found: CacheEntry | undefined;
    await commit(db, [META_STORE], "readonly", (tx) => {
      const req = tx.objectStore(META_STORE).get(key);
      req.onsuccess = () => {
        found = req.result as CacheEntry | undefined;
      };
    });
    return found;
  }

  /**
   * Whether a cached entry still matches the server.
   *
   * This is what makes the local path correct. transformers.js keys a local
   * load by its path (/models/<repo>/onnx/model.onnx) with no revision in it,
   * so re-running `make model` would otherwise be invisible. serve.ts derives
   * its ETag from size and mtime, so a re-fetched weight changes it.
   */
  private async fresh(entry: CacheEntry): Promise<boolean> {
    if (!entry.etag) {
      return true;
    }
    try {
      const { ok, etag } = await this.head(entry.key);
      if (!ok || !etag) {
        // A 5xx, or a server that sends no validator, is not evidence of
        // staleness — and treating it as such would re-download gigabytes.
        return true;
      }
      return etag === entry.etag;
    } catch {
      // Offline, or the origin is gone. The cache is now the only copy of these
      // weights, so serving it beats failing the load.
      return true;
    }
  }

  private async write(key: string, response: Response, progress?: (data: CacheProgress) => void): Promise<void> {
    const body = response.body;
    if (!body) {
      throw new Error("response has no body to cache");
    }
    const db = await this.open();
    // Clear first: a previous write may have torn and left chunks past the end
    // of what we are about to store, and those would fail the length check on
    // the next read.
    await this.delete(key);

    const total = Number(response.headers.get("content-length")) || 0;
    const reader = body.getReader();
    const queue: Uint8Array[] = [];
    let queued = 0;
    let loaded = 0;
    let index = 0;

    // One transaction per chunk. Reading the next chunk means awaiting the
    // stream, and an IndexedDB transaction cannot survive that await.
    const flush = async (bytes: number): Promise<void> => {
      const parts = take(queue, bytes);
      queued -= bytes;
      const blob = new Blob(parts);
      const at = index++;
      await commit(db, [CHUNK_STORE], "readwrite", (tx) => {
        tx.objectStore(CHUNK_STORE).put({ key, index: at, blob });
      });
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      queue.push(value);
      queued += value.byteLength;
      loaded += value.byteLength;
      // A Response built from one big buffer hands the whole file over in a
      // single read, so slice to size rather than trusting the read boundary.
      while (queued >= this.chunkBytes) {
        await flush(this.chunkBytes);
      }
      if (progress && total > 0) {
        progress({ progress: (loaded / total) * 100, loaded, total });
      }
    }
    if (queued > 0) {
      await flush(queued);
    }

    // Meta last. An interrupted write then reads back as a plain miss instead
    // of a record advertising a file that is only half there.
    const entry: CacheEntry = {
      key,
      size: loaded,
      chunks: index,
      chunkSize: this.chunkBytes,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type"),
      storedAt: Date.now(),
    };
    await commit(db, [META_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).put(entry);
    });
  }
}

let persistenceAsked = false;

/** Ask once per page for storage that survives eviction. Best effort. */
function requestPersistence(): void {
  if (persistenceAsked) {
    return;
  }
  persistenceAsked = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    // Not available (or blocked by policy). Nothing to do about it.
  }
}
