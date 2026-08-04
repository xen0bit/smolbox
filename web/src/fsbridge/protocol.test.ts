import { describe, expect, test } from "bun:test";
import {
  BRIDGE_HEADER_PAD,
  BRIDGE_MAX_REQUEST,
  BRIDGE_PAYLOAD_SIZE,
  BridgeChannel,
  ERRNO_SUCCESS,
  ReadResponse,
  createBridgeSab,
  decodeRequest,
  encodeRequest,
  inoOf,
} from "./protocol.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array | undefined): string => new TextDecoder().decode(b ?? new Uint8Array());

function pair(): { worker: BridgeChannel; main: BridgeChannel } {
  const sab = createBridgeSab();
  return {
    worker: new BridgeChannel(sab, () => {}),
    main: new BridgeChannel(sab, () => {}),
  };
}

describe("bridge SAB layout", () => {
  test("createBridgeSab sizes match the constants", () => {
    const sab = createBridgeSab();
    expect(sab.byteLength).toBe(BRIDGE_HEADER_PAD + BRIDGE_MAX_REQUEST + BRIDGE_PAYLOAD_SIZE);
  });
});

describe("request/response codec", () => {
  test("each request op round-trips through encode/decode", () => {
    const reqs = [
      { op: "stat" as const, path: "/hello.txt" },
      { op: "readdir" as const, path: "/sub" },
      { op: "read" as const, path: "/big.txt", offset: 0, len: 1024 },
      { op: "readlink" as const, path: "/link.txt" },
    ];
    for (const req of reqs) {
      expect(decodeRequest(encodeRequest(req))).toEqual(req);
    }
  });

  test("inoOf is deterministic and distinct per path", () => {
    expect(inoOf("/hello.txt")).toBe(inoOf("/hello.txt"));
    expect(inoOf("/hello.txt")).not.toBe(inoOf("/nested.txt"));
    expect(inoOf("/")).toBe(inoOf("/"));
  });
});

describe("main-thread respond / worker readResponse", () => {
  test("a stat response crosses the SAB intact", () => {
    const { worker, main } = pair();
    worker.submitRequest({ op: "stat", path: "/x" });
    expect(main.readRequest()).toEqual({ op: "stat", path: "/x" });
    main.respond({ op: "stat", errno: ERRNO_SUCCESS, filetype: 4, size: 3 });
    expect(worker.readResponse()).toEqual({ op: "stat", errno: ERRNO_SUCCESS, filetype: 4, size: 3 });
  });

  test("read data rides the payload window", () => {
    const { worker, main } = pair();
    worker.submitRequest({ op: "read", path: "/hello.txt", offset: 0, len: 5 });
    main.readRequest();
    main.respond({ op: "read", errno: ERRNO_SUCCESS, len: 5 }, utf8("hello"));
    const resp = worker.readResponse() as ReadResponse;
    expect(decode(resp.data)).toBe("hello");
  });

  test("readdata longer than the payload window is truncated, not corrupted", () => {
    const { worker, main } = pair();
    const big = new Uint8Array(BRIDGE_PAYLOAD_SIZE + 1024).fill(0x61);
    worker.submitRequest({ op: "read", path: "/big", offset: 0, len: big.length });
    main.readRequest();
    main.respond({ op: "read", errno: ERRNO_SUCCESS, len: big.length }, big);
    const resp = worker.readResponse() as ReadResponse;
    expect(resp.data?.length).toBe(BRIDGE_PAYLOAD_SIZE);
  });

  test("an error response carries no payload data", () => {
    const { worker, main } = pair();
    worker.submitRequest({ op: "read", path: "/missing", offset: 0, len: 10 });
    main.readRequest();
    main.respond({ op: "read", errno: 44 });
    const resp = worker.readResponse() as ReadResponse;
    expect(resp.data).toBeUndefined();
  });

  test("readRequest returns null when no request is pending", () => {
    const { main } = pair();
    expect(main.readRequest()).toBeNull();
  });
});
