import { describe, expect, test } from "bun:test";
import {
  type CacheEntry,
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbKeyRangeLike,
  type IdbObjectStoreLike,
  type IdbOpenRequestLike,
  type IdbRequestLike,
  type IdbTransactionLike,
  ModelCache,
} from "./model-cache.ts";

// An in-memory IndexedDB, because bun has none and the cache is nothing but
// transaction choreography: chunk ordering, what commits before what, and what
// a torn write looks like on the way back in. A fake that gets the ordering
// wrong would pass code that is broken in a browser, so this one keeps the two
// rules that matter — a transaction's requests resolve before its completion
// fires, and nothing is visible to a later transaction until this one commits.

interface Range {
  lower: unknown[];
  upper: unknown[];
}

function isRange(v: unknown): v is Range {
  return typeof v === "object" && v !== null && "lower" in v && "upper" in v;
}

function cmp(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) {
        return c;
      }
    }
    return 0;
  }
  if (a === b) {
    return 0;
  }
  return (a as number) < (b as number) ? -1 : 1;
}

class QuotaExceededError extends Error {
  readonly name = "QuotaExceededError";
}

class FakeStore implements IdbObjectStoreLike {
  readonly rows = new Map<string, { key: unknown; value: Record<string, unknown> }>();

  constructor(
    readonly keyPath: string | string[],
    private readonly tx: () => FakeTransaction,
  ) {}

  private keyOf(value: Record<string, unknown>): unknown {
    return Array.isArray(this.keyPath) ? this.keyPath.map((p) => value[p]) : value[this.keyPath];
  }

  get(key: unknown): IdbRequestLike<unknown> {
    return this.tx().enqueue(() => this.rows.get(JSON.stringify(key))?.value);
  }

  getAll(query?: unknown): IdbRequestLike<unknown[]> {
    return this.tx().enqueue(() => {
      const hits = [...this.rows.values()].filter(
        (r) => !isRange(query) || (cmp(r.key, query.lower) >= 0 && cmp(r.key, query.upper) <= 0),
      );
      return hits.sort((a, b) => cmp(a.key, b.key)).map((r) => r.value);
    });
  }

  put(value: unknown): IdbRequestLike<unknown> {
    return this.tx().enqueue(() => {
      const record = value as Record<string, unknown>;
      const key = this.keyOf(record);
      this.tx().db.beforePut?.(this.keyPath, record);
      this.rows.set(JSON.stringify(key), { key, value: record });
      return key;
    });
  }

  delete(key: unknown): IdbRequestLike<unknown> {
    return this.tx().enqueue(() => {
      if (isRange(key)) {
        for (const [id, row] of [...this.rows]) {
          if (cmp(row.key, key.lower) >= 0 && cmp(row.key, key.upper) <= 0) {
            this.rows.delete(id);
          }
        }
      } else {
        this.rows.delete(JSON.stringify(key));
      }
      return undefined;
    });
  }
}

class FakeTransaction implements IdbTransactionLike {
  error: { name?: string; message?: string } | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private queue: { request: IdbRequestLike<never>; run: () => unknown }[] = [];

  constructor(
    readonly db: FakeDatabase,
    private readonly names: string[],
  ) {
    // Runs after the caller's synchronous body has issued its requests, which
    // is what lets commit() attach onsuccess handlers before they fire.
    queueMicrotask(() => this.drain());
  }

  enqueue<T>(run: () => T): IdbRequestLike<T> {
    const request: IdbRequestLike<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
    this.queue.push({ request: request as IdbRequestLike<never>, run });
    return request;
  }

  objectStore(name: string): IdbObjectStoreLike {
    if (!this.names.includes(name)) {
      throw new Error(`store ${name} not in transaction`);
    }
    return this.db.store(name, () => this);
  }

  private drain(): void {
    for (const item of this.queue) {
      try {
        (item.request as { result: unknown }).result = item.run();
      } catch (err) {
        this.error = { name: (err as Error).name, message: (err as Error).message };
        this.onerror?.();
        this.onabort?.();
        return;
      }
      item.request.onsuccess?.();
    }
    this.oncomplete?.();
  }
}

class FakeDatabase implements IdbDatabaseLike {
  private readonly stores = new Map<string, FakeStore>();
  /** Test hook: throw from here to simulate a quota failure mid-write. */
  beforePut?: (keyPath: string | string[], value: Record<string, unknown>) => void;

  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

  createObjectStore(name: string, options: { keyPath: string | string[] }): IdbObjectStoreLike {
    const store = new FakeStore(options.keyPath, () => {
      throw new Error("upgrade store used outside a transaction");
    });
    this.stores.set(name, store);
    return store;
  }

  store(name: string, tx: () => FakeTransaction): FakeStore {
    const existing = this.stores.get(name);
    if (!existing) {
      throw new Error(`no store ${name}`);
    }
    // Rebind the store to the live transaction without losing its rows.
    const bound = new FakeStore(existing.keyPath, tx);
    Object.defineProperty(bound, "rows", { value: existing.rows });
    return bound;
  }

  rowsOf(name: string): Map<string, { key: unknown; value: Record<string, unknown> }> {
    const store = this.stores.get(name);
    if (!store) {
      throw new Error(`no store ${name}`);
    }
    return store.rows;
  }

  transaction(names: string[]): IdbTransactionLike {
    return new FakeTransaction(this, names);
  }

  close(): void {}
}

function fakeFactory(db: FakeDatabase): IdbFactoryLike {
  return {
    open(): IdbOpenRequestLike {
      const request: IdbOpenRequestLike = {
        result: db as unknown as IdbDatabaseLike,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(): IdbRequestLike<unknown> {
      throw new Error("not used");
    },
  };
}

const keyRange: IdbKeyRangeLike = { bound: (lower, upper) => ({ lower, upper }) };

function body(bytes: number, seed = 0): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = (i * 7 + seed) & 0xff;
  }
  return out;
}

/** Compare as plain arrays: the two sides differ only in their buffer type. */
async function bytesOf(resp: Response | undefined): Promise<number[]> {
  return [...new Uint8Array(await resp!.arrayBuffer())];
}

function response(payload: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(payload, {
    headers: { "content-length": String(payload.byteLength), ...headers },
  });
}

function build(opts: { db?: FakeDatabase; chunkBytes?: number; head?: ModelCacheHead } = {}) {
  const db = opts.db ?? new FakeDatabase();
  const cache = new ModelCache({
    factory: fakeFactory(db),
    keyRange,
    chunkBytes: opts.chunkBytes ?? 16,
    head: opts.head ?? (async () => ({ ok: true, etag: null })),
  });
  return { db, cache };
}

type ModelCacheHead = (url: string) => Promise<{ ok: boolean; etag: string | null }>;

describe("model cache round-trip", () => {
  test("splits a body into chunks and reads it back byte-identical", async () => {
    const { db, cache } = build({ chunkBytes: 16 });
    const payload = body(100);

    await cache.put("/models/x/model.onnx", response(payload));

    // 100 bytes at 16 per chunk is 6 full chunks plus a 4-byte tail. The whole
    // point is that a Response built from one buffer still gets sliced.
    expect(db.rowsOf("chunks").size).toBe(7);

    const hit = await cache.match("/models/x/model.onnx");
    expect(hit).toBeDefined();
    expect(await bytesOf(hit)).toEqual([...payload]);
  });

  test("restores content-length and content-type", async () => {
    const { cache } = build();
    const payload = body(40);
    await cache.put("/models/x/config.json", response(payload, { "content-type": "application/json" }));

    const hit = await cache.match("/models/x/config.json");
    expect(hit!.headers.get("content-length")).toBe("40");
    expect(hit!.headers.get("content-type")).toBe("application/json");
  });

  test("a body that divides evenly leaves no empty trailing chunk", async () => {
    const { db, cache } = build({ chunkBytes: 16 });
    await cache.put("/models/x/even.bin", response(body(64)));
    expect(db.rowsOf("chunks").size).toBe(4);
  });

  test("misses on a key that was never written", async () => {
    const { cache } = build();
    expect(await cache.match("/models/x/absent.onnx")).toBeUndefined();
  });

  test("rewriting a key with fewer chunks leaves no orphans behind", async () => {
    const { db, cache } = build({ chunkBytes: 16 });
    await cache.put("/models/x/w.bin", response(body(100)));
    await cache.put("/models/x/w.bin", response(body(20, 3)));

    expect(db.rowsOf("chunks").size).toBe(2);
    expect(await bytesOf(await cache.match("/models/x/w.bin"))).toEqual([...body(20, 3)]);
  });

  test("keeps entries for different keys apart", async () => {
    const { cache } = build({ chunkBytes: 16 });
    await cache.put("/models/a.bin", response(body(50, 1)));
    await cache.put("/models/b.bin", response(body(50, 2)));

    expect(await bytesOf(await cache.match("/models/a.bin"))).toEqual([...body(50, 1)]);
    expect(await bytesOf(await cache.match("/models/b.bin"))).toEqual([...body(50, 2)]);
  });
});

describe("model cache durability", () => {
  test("a write that fails mid-way is a miss, not a half-model", async () => {
    const db = new FakeDatabase();
    const { cache } = build({ db, chunkBytes: 16 });
    let chunks = 0;
    db.beforePut = (keyPath) => {
      if (Array.isArray(keyPath) && ++chunks === 3) {
        throw new QuotaExceededError("quota exceeded");
      }
    };

    // Must not throw: the caller already has the bytes and only asked us to
    // remember them.
    await cache.put("/models/x/big.onnx", response(body(100)));

    expect(await cache.match("/models/x/big.onnx")).toBeUndefined();
    expect(db.rowsOf("meta").size).toBe(0);
    expect(db.rowsOf("chunks").size).toBe(0);
  });

  test("meta is written after the chunks", async () => {
    const db = new FakeDatabase();
    const { cache } = build({ db, chunkBytes: 16 });
    const order: string[] = [];
    db.beforePut = (keyPath) => {
      order.push(Array.isArray(keyPath) ? "chunk" : "meta");
    };

    await cache.put("/models/x/order.bin", response(body(50)));

    expect(order.at(-1)).toBe("meta");
    expect(order.filter((o) => o === "meta")).toHaveLength(1);
  });

  test("an entry whose chunks went missing reads as a miss", async () => {
    const db = new FakeDatabase();
    const { cache } = build({ db, chunkBytes: 16 });
    await cache.put("/models/x/torn.bin", response(body(100)));

    // Simulate the tear the other way round: meta survived, a chunk did not.
    const chunks = db.rowsOf("chunks");
    chunks.delete([...chunks.keys()][2]!);

    expect(await cache.match("/models/x/torn.bin")).toBeUndefined();
    // And the bad entry is gone rather than failing every future read.
    expect(db.rowsOf("meta").size).toBe(0);
  });

  test("delete removes both the meta record and the chunks", async () => {
    const { db, cache } = build({ chunkBytes: 16 });
    await cache.put("/models/x/gone.bin", response(body(100)));

    expect(await cache.delete("/models/x/gone.bin")).toBe(true);
    expect(db.rowsOf("meta").size).toBe(0);
    expect(db.rowsOf("chunks").size).toBe(0);
  });
});

describe("model cache revalidation", () => {
  const etagged = (payload: Uint8Array, etag: string) => response(payload, { etag });

  test("serves the cache when the server's ETag still matches", async () => {
    const { cache } = build({ head: async () => ({ ok: true, etag: '"12-34"' }) });
    await cache.put("/models/x/w.onnx", etagged(body(40), '"12-34"'));

    expect(await cache.match("/models/x/w.onnx")).toBeDefined();
  });

  test("evicts when the server's ETag has moved on", async () => {
    // This is the `make model` case: transformers.js keys a local load by path
    // with no revision in it, so the ETag is the only thing that notices.
    const { db, cache } = build({ head: async () => ({ ok: true, etag: '"99-99"' }) });
    await cache.put("/models/x/w.onnx", etagged(body(40), '"12-34"'));

    expect(await cache.match("/models/x/w.onnx")).toBeUndefined();
    expect(db.rowsOf("meta").size).toBe(0);
    expect(db.rowsOf("chunks").size).toBe(0);
  });

  test("serves the cache when the server is unreachable", async () => {
    const { cache } = build({
      head: async () => {
        throw new Error("offline");
      },
    });
    await cache.put("/models/x/w.onnx", etagged(body(40), '"12-34"'));

    expect(await cache.match("/models/x/w.onnx")).toBeDefined();
  });

  test("serves the cache when the server answers without a validator", async () => {
    const { cache } = build({ head: async () => ({ ok: true, etag: null }) });
    await cache.put("/models/x/w.onnx", etagged(body(40), '"12-34"'));

    expect(await cache.match("/models/x/w.onnx")).toBeDefined();
  });

  test("does not revalidate an entry that was stored without an ETag", async () => {
    let asked = 0;
    const { cache } = build({
      head: async () => {
        asked++;
        return { ok: true, etag: '"different"' };
      },
    });
    await cache.put("/models/x/w.onnx", response(body(40)));

    expect(await cache.match("/models/x/w.onnx")).toBeDefined();
    expect(asked).toBe(0);
  });
});

describe("model cache housekeeping", () => {
  test("lists what is cached, newest first", async () => {
    const { cache } = build({ chunkBytes: 16 });
    await cache.put("/models/a.bin", response(body(50)));
    await cache.put("/models/b.bin", response(body(30)));

    const rows: CacheEntry[] = await cache.entries();
    expect(rows.map((r) => r.key)).toContain("/models/a.bin");
    expect(rows.map((r) => r.key)).toContain("/models/b.bin");
    expect(rows.find((r) => r.key === "/models/a.bin")!.size).toBe(50);
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.storedAt >= r.storedAt)).toBe(true);
  });

  test("clear drops every entry", async () => {
    const { db, cache } = build({ chunkBytes: 16 });
    await cache.put("/models/a.bin", response(body(50)));
    await cache.put("/models/b.bin", response(body(30)));

    expect(await cache.clear()).toBe(2);
    expect(await cache.entries()).toEqual([]);
    expect(db.rowsOf("chunks").size).toBe(0);
  });
});
