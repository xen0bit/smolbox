// The export path, driven against a scripted session.
//
// Everything that can go wrong here goes wrong quietly if it is not asserted:
// a chunk loop that drops the tail, a base64 decode that mangles high bytes, a
// path that turns into shell. None of it needs a VM, which is the point — this
// is the half of the feature CI can run.

import { describe, expect, test } from "bun:test";

import {
  ExportError,
  basename,
  formatBytes,
  readGuestFile,
  sha256Hex,
  shellQuote,
  statGuestFile,
} from "./export.ts";
import type { Request, Response } from "./protocol.ts";

function respond(over: Partial<Response> = {}): Response {
  return {
    seq: 0,
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    truncated: false,
    duration_ms: 1,
    ...over,
  };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s);
}

/**
 * A guest with one file in it.
 *
 * It answers the three commands export.ts issues by matching on their shape,
 * which is deliberately a little strict: a rewrite that changes the command
 * without changing the behaviour should have to say so here.
 */
class FakeGuest {
  readonly commands: string[] = [];
  /** Wrapped lines, as the real base64 emits them (76 columns). */
  wrap = true;
  hasSha = true;

  constructor(
    private readonly path: string,
    private readonly bytes: Uint8Array,
  ) {}

  async exec(req: Request): Promise<Response> {
    const cmd = req.cmd ?? "";
    this.commands.push(cmd);

    if (cmd.startsWith("stat ")) {
      return cmd.includes(quoted(this.path))
        ? respond({ stdout: `regular file|${this.bytes.length}\n` })
        : respond({ exit_code: 1, stderr: `stat: can't stat: No such file or directory\n` });
    }
    if (cmd.startsWith("sha256sum ")) {
      if (!this.hasSha) {
        return respond({ exit_code: 127, stderr: "sh: sha256sum: not found\n" });
      }
      return respond({ stdout: `${await sha256Hex(this.bytes)}  ${this.path}\n` });
    }
    if (cmd.startsWith("dd ")) {
      const bs = Number(/bs=(\d+)/.exec(cmd)?.[1]);
      const skip = Number(/skip=(\d+)/.exec(cmd)?.[1]);
      const slice = this.bytes.slice(skip * bs, (skip + 1) * bs);
      const encoded = b64(slice);
      return respond({ stdout: this.wrap ? wrap76(encoded) : encoded });
    }
    throw new Error(`unexpected command: ${cmd}`);
  }
}

function quoted(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function wrap76(s: string): string {
  return (s.match(/.{1,76}/g) ?? []).join("\n") + "\n";
}

function bytesOfLength(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // Cycles through every byte value, so a decoder that mishandles the high
    // half or an off-by-one in the chunk loop shows up as a mismatch.
    out[i] = (i * 7 + (i >> 8)) & 0xff;
  }
  return out;
}

describe("shellQuote", () => {
  test("wraps a plain path", () => {
    expect(shellQuote("/tmp/notes.txt")).toBe("'/tmp/notes.txt'");
  });

  test("neutralises a path that would otherwise be syntax", () => {
    expect(shellQuote("/tmp/a b; rm -rf /")).toBe("'/tmp/a b; rm -rf /'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });
});

describe("basename", () => {
  test.each([
    ["/tmp/notes.txt", "notes.txt"],
    ["/tmp/dir/", "dir"],
    ["file", "file"],
    ["/", "download"],
  ])("%s -> %s", (path, want) => {
    expect(basename(path)).toBe(want);
  });
});

describe("statGuestFile", () => {
  test("reads kind and size", async () => {
    const guest = new FakeGuest("/tmp/f", bytesOfLength(10));
    expect(await statGuestFile(guest, "/tmp/f")).toEqual({ kind: "file", size: 10 });
  });

  test("surfaces the guest's own message when the path is missing", async () => {
    const guest = new FakeGuest("/tmp/f", bytesOfLength(10));
    await expect(statGuestFile(guest, "/tmp/nope")).rejects.toThrow(/No such file/);
  });
});

describe("readGuestFile", () => {
  test("reassembles a file that spans several chunks", async () => {
    const bytes = bytesOfLength(1000);
    const guest = new FakeGuest("/tmp/f", bytes);
    const got = await readGuestFile(guest, "/tmp/f", { chunkBytes: 256 });

    expect(got.bytes).toEqual(bytes);
    expect(got.name).toBe("f");
    expect(got.sha256).toBe(await sha256Hex(bytes));
    // stat, four chunks, sha256sum.
    expect(guest.commands.length).toBe(6);
    expect(guest.commands[1]).toBe("dd if='/tmp/f' bs=256 skip=0 count=1 2>/dev/null | base64");
  });

  test("handles a file that is an exact multiple of the chunk size", async () => {
    const bytes = bytesOfLength(512);
    const guest = new FakeGuest("/tmp/f", bytes);
    const got = await readGuestFile(guest, "/tmp/f", { chunkBytes: 256 });
    expect(got.bytes).toEqual(bytes);
    // Two reads and no wasted third: the loop is bounded by the stat size, not
    // by reading until empty.
    expect(guest.commands.filter((c) => c.startsWith("dd ")).length).toBe(2);
  });

  test("handles an empty file without reading anything", async () => {
    const guest = new FakeGuest("/tmp/empty", new Uint8Array(0));
    const got = await readGuestFile(guest, "/tmp/empty", { chunkBytes: 256 });
    expect(got.bytes.length).toBe(0);
    expect(guest.commands.filter((c) => c.startsWith("dd ")).length).toBe(0);
  });

  test("survives base64 line wrapping", async () => {
    // busybox and coreutils disagree about -w0, so the wrapping is stripped
    // here rather than asked away. An unwrapped guest must work too.
    const bytes = bytesOfLength(700);
    const wrapped = new FakeGuest("/tmp/f", bytes);
    const flat = new FakeGuest("/tmp/f", bytes);
    flat.wrap = false;
    expect((await readGuestFile(wrapped, "/tmp/f", { chunkBytes: 256 })).bytes).toEqual(bytes);
    expect((await readGuestFile(flat, "/tmp/f", { chunkBytes: 256 })).bytes).toEqual(bytes);
  });

  test("reports progress up to the total", async () => {
    const seen: number[] = [];
    const guest = new FakeGuest("/tmp/f", bytesOfLength(600));
    await readGuestFile(guest, "/tmp/f", {
      chunkBytes: 256,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([0, 256, 512, 600]);
  });

  test("refuses a directory, naming the way out", async () => {
    const guest = {
      exec: async () => respond({ stdout: "directory|4096\n" }),
    };
    await expect(readGuestFile(guest, "/mnt/host")).rejects.toThrow(/is a directory; tar it first/);
  });

  test("refuses a file over the ceiling before reading a byte", async () => {
    const guest = new FakeGuest("/tmp/f", new Uint8Array(0));
    await expect(readGuestFile(guest, "/tmp/f", { size: 200 * 1024 * 1024 })).rejects.toThrow(/over the .* export limit/);
    expect(guest.commands).toEqual([]);
  });

  test("a truncated chunk is an error, not a short read", async () => {
    const guest = {
      exec: async (req: Request) =>
        req.cmd?.startsWith("stat ")
          ? respond({ stdout: "regular file|1000\n" })
          : respond({ stdout: b64(bytesOfLength(256)), truncated: true }),
    };
    await expect(readGuestFile(guest, "/tmp/f", { chunkBytes: 256 })).rejects.toThrow(ExportError);
  });

  test("a file that vanishes mid-read fails rather than saving a stub", async () => {
    let calls = 0;
    const guest = {
      exec: async (req: Request) => {
        if (req.cmd?.startsWith("stat ")) {
          return respond({ stdout: "regular file|1000\n" });
        }
        calls++;
        return calls === 1 ? respond({ stdout: b64(bytesOfLength(256)) }) : respond({ stdout: "" });
      },
    };
    await expect(readGuestFile(guest, "/tmp/f", { chunkBytes: 256 })).rejects.toThrow(/changed underneath/);
  });

  test("a hash the guest disagrees with fails the export", async () => {
    const guest = {
      exec: async (req: Request) => {
        const cmd = req.cmd ?? "";
        if (cmd.startsWith("stat ")) {
          return respond({ stdout: "regular file|4\n" });
        }
        if (cmd.startsWith("sha256sum ")) {
          return respond({ stdout: `${"0".repeat(64)}  /tmp/f\n` });
        }
        return respond({ stdout: b64(new Uint8Array([1, 2, 3, 4])) });
      },
    };
    await expect(readGuestFile(guest, "/tmp/f", { chunkBytes: 256 })).rejects.toThrow(/sha256 mismatch/);
  });

  test("a guest without sha256sum exports unverified rather than failing", async () => {
    const guest = new FakeGuest("/tmp/f", bytesOfLength(64));
    guest.hasSha = false;
    const got = await readGuestFile(guest, "/tmp/f", { chunkBytes: 256 });
    expect(got.sha256).toBeNull();
    expect(got.bytes.length).toBe(64);
  });

  test("verify:false skips the hash round-trip entirely", async () => {
    const guest = new FakeGuest("/tmp/f", bytesOfLength(64));
    await readGuestFile(guest, "/tmp/f", { chunkBytes: 256, verify: false });
    expect(guest.commands.some((c) => c.startsWith("sha256sum"))).toBe(false);
  });

  test("an aborted signal stops the loop between chunks", async () => {
    const signal = { aborted: false };
    const guest = new FakeGuest("/tmp/f", bytesOfLength(1000));
    await expect(
      readGuestFile(guest, "/tmp/f", {
        chunkBytes: 256,
        signal,
        onProgress: (done) => {
          if (done >= 256) {
            signal.aborted = true;
          }
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect(guest.commands.filter((c) => c.startsWith("dd ")).length).toBe(1);
  });

  test("quotes the path into every command it issues", async () => {
    const path = "/tmp/it's a file";
    const guest = new FakeGuest(path, bytesOfLength(10));
    await readGuestFile(guest, path);
    for (const cmd of guest.commands) {
      expect(cmd).toContain(`'/tmp/it'\\''s a file'`);
    }
  });
});

describe("formatBytes", () => {
  test.each([
    [512, "512 B"],
    [2048, "2 KiB"],
    [3 * 1024 * 1024, "3.0 MiB"],
  ])("%i -> %s", (n, want) => {
    expect(formatBytes(n)).toBe(want);
  });
});

describe("parseBuiltin", () => {
  test("splits a builtin from its argument", async () => {
    const { parseBuiltin } = await import("./terminal.ts");
    expect(parseBuiltin(":get /tmp/x")).toEqual({ name: "get", arg: "/tmp/x" });
    expect(parseBuiltin("  :help  ")).toEqual({ name: "help", arg: "" });
    expect(parseBuiltin(":GET /tmp/x")).toEqual({ name: "get", arg: "/tmp/x" });
  });

  test("leaves guest commands alone", async () => {
    const { parseBuiltin } = await import("./terminal.ts");
    expect(parseBuiltin("ls -la")).toBeNull();
    expect(parseBuiltin("echo :get")).toBeNull();
    expect(parseBuiltin("")).toBeNull();
  });
});
