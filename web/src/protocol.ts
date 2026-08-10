// TS mirror of internal/protocol/protocol.go. The wire cannot drift: the
// framing, prefixes, and JSON shapes below are byte-identical to the Go side.

export const ReadyPrefix = "#SMOLBOX-READY#";
export const ReqPrefix = "#SMOLBOX-REQ#";
export const ResPrefix = "#SMOLBOX-RES#";

export const Version = "0.0.1";

export const MaxFrameSize = 4 << 20;
export const DefaultMaxOutput = 1 << 20;

export const OpExec = "exec";
export const OpPing = "ping";
export const OpInfo = "info";
export const OpShutdown = "shutdown";

export interface Caps {
  version: string;
  max_output?: number;
  max_frame?: number;
}

export interface Request {
  op: string;
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeout_ms?: number;
  max_output?: number;
}

export interface Response {
  seq: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
  error?: string;
}

export type FrameKind = "ready" | "request" | "response";

export interface Frame {
  kind: FrameKind;
  seq: number;
  json: string;
}

export class ProtocolError extends Error {}

const readyPrefix = ReadyPrefix;
const reqPrefix = ReqPrefix;
const resPrefix = ResPrefix;

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

// asciiSlice converts a base64 run of bytes to a string without touching the
// whole line at once (a max-size frame is ~5.3 MB).
function asciiSlice(line: Uint8Array, start: number, end: number): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    s += String.fromCharCode(...line.subarray(i, Math.min(i + CHUNK, end)));
  }
  return s;
}

function hasPrefix(line: Uint8Array, prefix: string): boolean {
  if (line.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (line[i] !== prefix.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function encodeFrame(prefix: string, seq: number | undefined, payload: string): Uint8Array {
  const json = encodeUtf8(payload);
  const b64 = encodeBase64(json);
  const head = seq === undefined ? prefix : `${prefix}${seq}#`;
  return encodeUtf8(head + b64 + "\n");
}

export function encodeReady(caps: Caps): Uint8Array {
  return encodeFrame(readyPrefix, undefined, JSON.stringify(caps));
}

export function encodeRequest(seq: number, req: Request): Uint8Array {
  const wire: Record<string, unknown> = { ...req };
  if (req.stdin instanceof Uint8Array) {
    wire.stdin = encodeBase64(req.stdin);
  } else if (typeof req.stdin === "string") {
    wire.stdin = encodeBase64(encodeUtf8(req.stdin));
  }
  return encodeFrame(reqPrefix, seq, JSON.stringify(wire));
}

export function encodeResponse(seq: number, resp: Response): Uint8Array {
  return encodeFrame(resPrefix, seq, JSON.stringify(resp));
}

export function decodeReady(frame: Frame): Caps {
  return JSON.parse(frame.json) as Caps;
}

export function decodeRequest(frame: Frame): Request {
  return JSON.parse(frame.json) as Request;
}

export function decodeResponse(frame: Frame): Response {
  const raw = JSON.parse(frame.json) as Record<string, unknown>;
  return {
    seq: raw.seq as number,
    exit_code: raw.exit_code as number,
    stdout: decodeBytes(raw.stdout),
    stderr: decodeBytes(raw.stderr),
    timed_out: Boolean(raw.timed_out),
    truncated: Boolean(raw.truncated),
    duration_ms: raw.duration_ms as number,
    error: (raw.error as string) ?? undefined,
  };
}

function decodeBytes(v: unknown): string {
  if (typeof v !== "string") {
    return "";
  }
  try {
    return decodeUtf8(decodeBase64(v));
  } catch {
    return "";
  }
}

function parseLine(line: Uint8Array): Frame | null {
  if (hasPrefix(line, readyPrefix)) {
    return { kind: "ready", seq: 0, json: decodeUtf8(decodeBase64(asciiSlice(line, readyPrefix.length, line.length))) };
  }
  if (hasPrefix(line, reqPrefix)) {
    return parseSeqFrame(line, reqPrefix, "request");
  }
  if (hasPrefix(line, resPrefix)) {
    return parseSeqFrame(line, resPrefix, "response");
  }
  return null;
}

function parseSeqFrame(line: Uint8Array, prefix: string, kind: FrameKind): Frame {
  const rest = line.subarray(prefix.length);
  const idx = rest.indexOf(0x23);
  if (idx < 0) {
    throw new ProtocolError(`malformed ${kind} frame: missing seq separator`);
  }
  const seq = parseInt(asciiSlice(rest, 0, idx), 10);
  if (Number.isNaN(seq)) {
    throw new ProtocolError(`malformed ${kind} frame: bad seq`);
  }
  return { kind, seq, json: decodeUtf8(decodeBase64(asciiSlice(rest, idx + 1, rest.length))) };
}

// FrameDecoder consumes arbitrary byte chunks from the guest console and
// yields complete frames, discarding non-prefixed lines (kernel noise) the way
// the Go Scanner does.
// Growth and scanning are both amortized O(1) per byte: the buffer doubles
// instead of reallocating per chunk, and `scanned` remembers how far the
// newline search already got. That is not a micro-optimization: the removed
// --to-js page fed this one byte at a time (QEMU's 16550 UART writes per
// character), and a decoder that recopied and rescanned the pending line on
// every chunk turned a 1 MiB response into minutes of quadratic work. Keep it
// amortized O(1) per byte — any console-side transport can hand over small
// chunks.
const initialCapacity = 4096;

export class FrameDecoder {
  private buf = new Uint8Array(initialCapacity);
  private start = 0; // first unconsumed byte
  private end = 0; // one past the last valid byte
  private scanned = 0; // [start, scanned) is known to hold no newline

  feed(chunk: Uint8Array): Frame[] {
    this.append(chunk);
    const frames: Frame[] = [];
    for (;;) {
      const nl = this.buf.subarray(this.scanned, this.end).indexOf(0x0a);
      if (nl < 0) {
        this.scanned = this.end;
        break;
      }
      const at = this.scanned + nl;
      const frame = parseLine(this.buf.subarray(this.start, at));
      this.start = at + 1;
      this.scanned = this.start;
      if (frame) {
        frames.push(frame);
      }
    }
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
      this.scanned = 0;
    } else if (this.end - this.start > MaxFrameSize) {
      throw new ProtocolError("frame exceeds MaxFrameSize");
    }
    return frames;
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    if (this.end + chunk.length > this.buf.length) {
      const pending = this.end - this.start;
      const needed = pending + chunk.length;
      if (needed <= this.buf.length) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        let capacity = this.buf.length;
        while (capacity < needed) {
          capacity *= 2;
        }
        const next = new Uint8Array(capacity);
        next.set(this.buf.subarray(this.start, this.end), 0);
        this.buf = next;
      }
      this.scanned -= this.start;
      this.start = 0;
      this.end = pending;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }
}
