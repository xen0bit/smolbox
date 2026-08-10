import { describe, expect, test } from "bun:test";
import {
  FrameDecoder,
  MaxFrameSize,
  OpExec,
  ProtocolError,
  decodeReady,
  decodeResponse,
  encodeReady,
  encodeRequest,
} from "./protocol.ts";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decodeB64(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

describe("frame encoding", () => {
  test("request frame carries prefix and seq", () => {
    const line = encodeRequest(7, { op: OpExec, cmd: "echo hello" });
    const text = new TextDecoder().decode(line);
    expect(text.startsWith("#SMOLBOX-REQ#7#")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("request stdin is base64 of utf8 on the wire", () => {
    const line = encodeRequest(1, { op: OpExec, cmd: "cat", stdin: "héllo" });
    const text = new TextDecoder().decode(line);
    const prefix = "#SMOLBOX-REQ#1#";
    const json = decodeB64(text.slice(prefix.length, -1));
    expect(JSON.parse(json).stdin).toBe("aMOpbGxv");
  });

  test("request stdin as bytes is base64 on the wire", () => {
    const line = encodeRequest(1, { op: OpExec, cmd: "cat", stdin: utf8("bytes") });
    const text = new TextDecoder().decode(line);
    const prefix = "#SMOLBOX-REQ#1#";
    const json = decodeB64(text.slice(prefix.length, -1));
    expect(JSON.parse(json).stdin).toBe("Ynl0ZXM=");
  });

  test("ready frame round-trips through the decoder", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed(encodeReady({ version: "0.0.1", max_output: 1 << 20 }));
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("ready");
    expect(decodeReady(frames[0])).toEqual({ version: "0.0.1", max_output: 1 << 20 });
  });
});

describe("response decoding", () => {
  test("stdout/stderr are utf8-decoded from base64", () => {
    const decoder = new FrameDecoder();
    const payload = JSON.stringify({
      seq: 3,
      exit_code: 0,
      stdout: "aGVsbG8K",
      stderr: "ZXJyCg==",
      timed_out: false,
      truncated: false,
      duration_ms: 12,
    });
    const frames = decoder.feed(encodeRequestFrame(payload));
    expect(frames).toHaveLength(1);
    const resp = decodeResponse(frames[0]);
    expect(resp.stdout).toBe("hello\n");
    expect(resp.stderr).toBe("err\n");
    expect(resp.seq).toBe(3);
  });

  test("null stdout decodes to empty string", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed(encodeRequestFrame('{"seq":1,"stdout":null,"stderr":null}'));
    const resp = decodeResponse(frames[0]);
    expect(resp.stdout).toBe("");
    expect(resp.stderr).toBe("");
  });
});

describe("FrameDecoder", () => {
  test("discards non-prefixed lines (kernel noise)", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed(utf8("random kernel log line\nanother one\n"));
    expect(frames).toHaveLength(0);
  });

  test("skips noise between frames", () => {
    const decoder = new FrameDecoder();
    const noise = utf8("boot noise\n");
    const ready = encodeReady({ version: "0.0.1" });
    const combined = new Uint8Array(noise.length + ready.length);
    combined.set(noise, 0);
    combined.set(ready, noise.length);
    const frames = decoder.feed(combined);
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("ready");
  });

  test("buffers a frame split across chunks", () => {
    const decoder = new FrameDecoder();
    const line = encodeRequest(1, { op: OpExec, cmd: "echo split" });
    const first = line.subarray(0, 10);
    const rest = line.subarray(10);
    expect(decoder.feed(first)).toHaveLength(0);
    const frames = decoder.feed(rest);
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("request");
    expect(frames[0].seq).toBe(1);
  });

  test("multiple frames in one chunk", () => {
    const decoder = new FrameDecoder();
    const a = encodeRequest(1, { op: OpExec, cmd: "echo a" });
    const b = encodeRequest(2, { op: OpExec, cmd: "echo b" });
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    const frames = decoder.feed(combined);
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  test("overlong line without newline raises", () => {
    const decoder = new FrameDecoder();
    const big = new Uint8Array(MaxFrameSize + 1);
    big.fill(0x61);
    expect(() => decoder.feed(big)).toThrow(ProtocolError);
  });

  // A console transport can hand over one byte per call — the removed --to-js
  // page did, because QEMU's 16550 UART writes per character — so a large frame
  // arrives as ~1e6 single-byte chunks. Buffer growth and the newline scan must
  // both stay amortized O(1) per byte; when they were not, this took minutes
  // instead of milliseconds. The guarantee is worth keeping whatever feeds it.
  test("a large frame delivered one byte at a time stays linear", () => {
    const decoder = new FrameDecoder();
    const line = encodeRequest(7, { op: OpExec, cmd: "a".repeat(512 * 1024) });
    const started = performance.now();
    let frames: ReturnType<FrameDecoder["feed"]> = [];
    for (let i = 0; i < line.length; i++) {
      frames = decoder.feed(line.subarray(i, i + 1));
    }
    expect(performance.now() - started).toBeLessThan(5000);
    expect(frames).toHaveLength(1);
    expect(frames[0].seq).toBe(7);
    expect(JSON.parse(frames[0].json).cmd).toBe("a".repeat(512 * 1024));
  });

  test("consecutive frames reuse the buffer without losing bytes", () => {
    const decoder = new FrameDecoder();
    const seqs: number[] = [];
    for (let i = 1; i <= 200; i++) {
      const line = encodeRequest(i, { op: OpExec, cmd: `echo ${"x".repeat(i * 7)}` });
      for (const frame of decoder.feed(line)) {
        seqs.push(frame.seq);
      }
    }
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
});

// encodeRequestFrame wraps a raw JSON payload as a response frame for the
// decoder to parse (the response body is authored by the guest).
function encodeRequestFrame(payload: string): Uint8Array {
  return utf8(`#SMOLBOX-RES#${1}#${btoa(payload)}\n`);
}
