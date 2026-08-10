// Wire protocol for the sync FS bridge: one SharedArrayBuffer, two threads.
// The worker (inside the emulated guest's fd methods) blocks on Atomics.wait
// while the main thread performs the async File System Access API reads. This
// file is the single definition of the layout, op codes, and JSON envelopes;
// the worker (worker-fd.ts) and the main thread (main-host.ts) both consume it,
// so the two ends cannot drift.
//
// Layout (Int32 header, then a request region, then a payload window):
//   [0] STATE    0=idle 1=req pending 2=resp ready
//   [1] ERRNO    errno of the current response
//   [2] REQLEN   request JSON byte length
//   [3] RESPLEN  response JSON byte length
//   [4] DATALEN  bytes of READ data in the payload window
//   [5] DATAOFF  payload offset of that data (always 0 for now)
//   [6..7] reserved
//
// The response JSON reuses the request region (requests are strictly
// serialized: the worker cannot issue the next one until it observed the
// response). Binary file data goes into the payload window, so multi-megabyte
// reads are copied straight through the SAB without JSON/base64 overhead.

export const BRIDGE_HEADER_INTS = 8;
export const BRIDGE_HEADER_PAD = BRIDGE_HEADER_INTS * 4;
export const BRIDGE_MAX_REQUEST = 1 << 16; // 64 KiB of request/response JSON
export const BRIDGE_PAYLOAD_SIZE = 1 << 20; // 1 MiB payload window
export const BRIDGE_TIMEOUT_MS = 60_000;

export const STATE_IDLE = 0;
export const STATE_REQ = 1;
export const STATE_RESP = 2;

const I_STATE = 0;
const I_ERRNO = 1;
const I_REQLEN = 2;
const I_RESPLEN = 3;
const I_DATALEN = 4;
const I_DATAOFF = 5;

// WASI errno/filetype values the bridge speaks. These match the
// browser_wasi_shim `wasi` constants numerically; keeping them local keeps the
// bridge testable without the shim.
export const ERRNO_SUCCESS = 0;
export const ERRNO_BADF = 8;
export const ERRNO_IO = 29;
export const ERRNO_INVAL = 28;
export const ERRNO_NOENT = 44;
export const ERRNO_NOTCAPABLE = 76;
export const ERRNO_ROFS = 69;

export const FILETYPE_DIRECTORY = 3;
export const FILETYPE_REGULAR_FILE = 4;
export const FILETYPE_SYMBOLIC_LINK = 7;

export const OpStat = "stat";
export const OpReaddir = "readdir";
export const OpRead = "read";
export const OpReadlink = "readlink";

export interface StatRequest {
  op: typeof OpStat;
  path: string;
}

export interface ReaddirRequest {
  op: typeof OpReaddir;
  path: string;
}

export interface ReadRequest {
  op: typeof OpRead;
  path: string;
  offset: number;
  len: number;
}

export interface ReadlinkRequest {
  op: typeof OpReadlink;
  path: string;
}

export type BridgeRequest = StatRequest | ReaddirRequest | ReadRequest | ReadlinkRequest;

export interface StatResponse {
  op: typeof OpStat;
  errno: number;
  filetype?: number;
  size?: number;
  /**
   * Last modification, in milliseconds since the epoch. Absent means unknown.
   *
   * The File System Access API hands this over for free — every `File` carries
   * `lastModified` — and dropping it was visible all the way out at the other
   * end of the product: the guest saw `Jan 1 1970` on every entry, `ls -lt` and
   * `find -newer`/`-mtime` had nothing to sort or compare, and a model reading
   * `ls -la` told the user their files were created in 1970. Which it did, in
   * both of the runs recorded in PLAN §10.21.
   *
   * Directories have no `File` and therefore no timestamp: absent is honest, and
   * an invented one would sort wrongly rather than not at all.
   */
  mtimeMs?: number;
  /**
   * Hard link count, or 1 meaning "this filesystem does not count links".
   *
   * WASI has a `nlink` field and the shim's Filestat constructor hardcodes it to
   * **0**, which is not a number any filesystem reports and which tools do read:
   * fts (so `find`, `ls -R`) sizes a directory's remaining subdirectories as
   * `nlink - 2`, and the conventional way to say "do not do that arithmetic" is
   * to report 1. Zero is in nobody's contract.
   */
  nlink?: number;
}

export interface ReaddirResponse {
  op: typeof OpReaddir;
  errno: number;
  entries?: Array<{ name: string; type: number }>;
}

export interface ReadResponse {
  op: typeof OpRead;
  errno: number;
  len?: number;
  data?: Uint8Array;
}

export interface ReadlinkResponse {
  op: typeof OpReadlink;
  errno: number;
  target?: string;
}

export type BridgeResponse = StatResponse | ReaddirResponse | ReadResponse | ReadlinkResponse;

export interface ReaddirEntry {
  name: string;
  type: number;
}

// The synchronous client surface BridgeFd needs. BridgeChannel is the real SAB
// implementation; unit tests substitute a fake so the Fd logic can be exercised
// without blocking on Atomics.wait.
export interface BridgeClient {
  stat(path: string): StatResponse;
  readdir(path: string): ReaddirResponse;
  read(path: string, offset: number, len: number): ReadResponse;
  readlink(path: string): ReadlinkResponse;
}

// Deterministic inode from a mount-relative path, shared by both ends so
// readdir d_ino values and filestat ino values agree without shipping them.
export function inoOf(path: string): bigint {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return BigInt(h >>> 0);
}

export function encodeRequest(req: BridgeRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

export function decodeRequest(bytes: Uint8Array): BridgeRequest {
  return JSON.parse(new TextDecoder().decode(bytes)) as BridgeRequest;
}

// READ bytes ride the payload window and are deliberately dropped from the
// envelope: JSON.stringify expands a Uint8Array into {"0":83,"1":69,...}, about
// ten bytes per file byte, so any read over ~7 KiB would overflow
// BRIDGE_MAX_REQUEST. The worker refills resp.data from the payload window.
export function encodeResponse(resp: BridgeResponse): Uint8Array {
  const wire = resp.op === OpRead && resp.data !== undefined ? { ...resp, data: undefined } : resp;
  return new TextEncoder().encode(JSON.stringify(wire));
}

export class BridgeChannel {
  readonly sab: SharedArrayBuffer;
  private ints: Int32Array;
  private req: Uint8Array;
  private payload: Uint8Array;

  constructor(sab: SharedArrayBuffer, private wake: (req: BridgeRequest) => void = bridgeWake) {
    this.sab = sab;
    this.ints = new Int32Array(sab, 0, BRIDGE_HEADER_INTS);
    this.req = new Uint8Array(sab, BRIDGE_HEADER_PAD, BRIDGE_MAX_REQUEST);
    this.payload = new Uint8Array(
      sab,
      BRIDGE_HEADER_PAD + BRIDGE_MAX_REQUEST,
      BRIDGE_PAYLOAD_SIZE,
    );
  }

  // ---- worker side (synchronous; may block) ----

  // Publish a request into the SAB and wake the main thread. Used by request()
  // (which then blocks) and by tests, which pair it with readRequest/respond on
  // a second BridgeChannel view of the same SAB.
  submitRequest(req: BridgeRequest): void {
    const json = encodeRequest(req);
    if (json.length > BRIDGE_MAX_REQUEST) {
      throw new Error(`fsbridge: ${req.op} request too large (${json.length} bytes)`);
    }
    this.req.set(json, 0);
    Atomics.store(this.ints, I_REQLEN, json.length);
    Atomics.store(this.ints, I_STATE, STATE_REQ);
    this.wake(req);
  }

  // Read the response the main thread published, resetting the channel for the
  // next request. READ responses carry their binary data in the payload window.
  readResponse(): BridgeResponse {
    const copy = this.req.slice(0, Atomics.load(this.ints, I_RESPLEN));
    Atomics.store(this.ints, I_STATE, STATE_IDLE);
    const resp = decodeResponse(copy);
    if (resp.op === OpRead && resp.errno === ERRNO_SUCCESS) {
      resp.data = this.payload.slice(0, Atomics.load(this.ints, I_DATALEN));
    }
    return resp;
  }

  // Send a request and block until the main thread answers.
  request(req: BridgeRequest): BridgeResponse {
    this.submitRequest(req);
    Atomics.wait(this.ints, I_STATE, STATE_REQ, BRIDGE_TIMEOUT_MS);
    if (Atomics.load(this.ints, I_STATE) !== STATE_RESP) {
      throw new Error(`fsbridge: ${req.op} timed out waiting for the main thread`);
    }
    return this.readResponse();
  }

  stat(path: string): StatResponse {
    return this.request({ op: OpStat, path }) as StatResponse;
  }

  readdir(path: string): ReaddirResponse {
    return this.request({ op: OpReaddir, path }) as ReaddirResponse;
  }

  read(path: string, offset: number, len: number): ReadResponse {
    return this.request({ op: OpRead, path, offset, len }) as ReadResponse;
  }

  readlink(path: string): ReadlinkResponse {
    return this.request({ op: OpReadlink, path }) as ReadlinkResponse;
  }

  // ---- main-thread side (never blocks) ----

  // Capture the pending request synchronously; the request bytes are frozen
  // before any await in the caller, so the worker cannot race us. The bytes are
  // copied out first: TextDecoder refuses to decode views over a
  // SharedArrayBuffer.
  readRequest(): BridgeRequest | null {
    if (Atomics.load(this.ints, I_STATE) !== STATE_REQ) {
      return null;
    }
    const len = Atomics.load(this.ints, I_REQLEN);
    return decodeRequest(this.req.slice(0, len));
  }

  respond(resp: BridgeResponse, data?: Uint8Array): void {
    if (data && data.length > 0) {
      const n = Math.min(data.length, BRIDGE_PAYLOAD_SIZE);
      this.payload.set(data.subarray(0, n), 0);
      Atomics.store(this.ints, I_DATAOFF, 0);
      Atomics.store(this.ints, I_DATALEN, n);
    } else {
      Atomics.store(this.ints, I_DATALEN, 0);
    }
    let json = encodeResponse(resp);
    let errno = resp.errno;
    if (json.length > BRIDGE_MAX_REQUEST) {
      // The worker is asleep in Atomics.wait and only the store below wakes it,
      // so an envelope that does not fit must degrade to an error rather than
      // throw: throwing here strands the guest until its 60s timeout fires.
      console.error(`fsbridge: ${resp.op} response too large (${json.length} bytes), replying EIO`);
      errno = ERRNO_IO;
      json = encodeResponse({ op: resp.op, errno } as BridgeResponse);
      Atomics.store(this.ints, I_DATALEN, 0);
    }
    this.req.set(json, 0);
    Atomics.store(this.ints, I_RESPLEN, json.length);
    Atomics.store(this.ints, I_ERRNO, errno);
    Atomics.store(this.ints, I_STATE, STATE_RESP);
    Atomics.notify(this.ints, I_STATE, 1);
  }
}

function decodeResponse(bytes: Uint8Array): BridgeResponse {
  return JSON.parse(new TextDecoder().decode(bytes)) as BridgeResponse;
}

export function bridgeWake(req: BridgeRequest): void {
  postMessage({ type: "fsreq", op: req.op, path: req.path });
}

// Create a fresh SAB for the bridge. Both ends must agree on the layout, so
// the size comes from the same constants this file defines.
export function createBridgeSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(BRIDGE_HEADER_PAD + BRIDGE_MAX_REQUEST + BRIDGE_PAYLOAD_SIZE);
}
