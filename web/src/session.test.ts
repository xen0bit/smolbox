import { describe, expect, test } from "bun:test";
import type { Caps, Request, Response } from "./protocol.ts";
import { OpExec, OpShutdown } from "./protocol.ts";
import { Session } from "./session.ts";
import { StdinChannel } from "./stdio.ts";

class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sab: SharedArrayBuffer | null = null;

  receive(msg: unknown): void {
    const m = msg as { type: string; sab?: SharedArrayBuffer };
    if (m.type === "channel" && m.sab) {
      this.sab = m.sab;
    }
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

function makeSession(): { session: Session; worker: FakeWorker } {
  const worker = new FakeWorker();
  return { session: new Session(worker), worker };
}

async function boot(session: Session, worker: FakeWorker): Promise<Caps> {
  const sab = StdinChannel.create().sab;
  const booted = session.boot();
  worker.receive({ type: "channel", sab });
  worker.receive({ type: "ready", caps: { version: "0.0.1" } });
  return booted;
}

// The worker decodes frames at the protocol boundary; the Session passes
// decoded responses straight through. This mock mirrors that contract.
function decodedResp(seq: number, stdout = ""): Response {
  return { seq, exit_code: 0, stdout, stderr: "", timed_out: false, truncated: false, duration_ms: 1 };
}

// flush drains the exec/close promise queue (a few microtask hops) so the SAB
// write has happened by the time the test reads it back.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("Session", () => {
  test("boot resolves on the ready banner", async () => {
    const { session, worker } = makeSession();
    const caps = await boot(session, worker);
    expect(caps.version).toBe("0.0.1");
    expect(session.Caps()).toEqual({ version: "0.0.1" });
  });

  test("exec writes a REQ frame into the shared channel and resolves on its response", async () => {
    const { session, worker } = makeSession();
    await boot(session, worker);
    const channel = new StdinChannel(worker.sab!);

    const pending = session.exec({ op: OpExec, cmd: "echo hello" });
    await flush();
    const frame = channel.read(1 << 20);
    expect(frame).not.toBeNull();
    const text = new TextDecoder().decode(frame!);
    expect(text.startsWith("#SMOLBOX-REQ#1#")).toBe(true);

    worker.receive({ type: "response", resp: decodedResp(1, "hello\n") });
    const got = await pending;
    expect(got.stdout).toBe("hello\n");
    expect(got.seq).toBe(1);
  });

  test("exec before the channel arrives rejects", async () => {
    const { session } = makeSession();
    await expect(session.exec({ op: OpExec, cmd: "echo nope" })).rejects.toThrow(
      "session not booted",
    );
  });

  test("exec after close rejects", async () => {
    const { session, worker } = makeSession();
    await boot(session, worker);
    const channel = new StdinChannel(worker.sab!);

    const closing = session.close();
    await flush();
    const frame = channel.read(1 << 20);
    expect(frame).not.toBeNull();
    const text = new TextDecoder().decode(frame!);
    expect(text.startsWith("#SMOLBOX-REQ#1#")).toBe(true);
    const b64 = text.slice(0, -1).split("#")[3];
    expect(JSON.parse(atob(b64))).toMatchObject({ op: OpShutdown });

    worker.receive({ type: "exit", code: 0 });
    await closing;

    await expect(session.exec({ op: OpExec, cmd: "echo no" })).rejects.toThrow("session closed");
  });

  test("exit before ready rejects the pending boot", async () => {
    const { session, worker } = makeSession();
    const booted = session.boot();
    worker.receive({ type: "exit", code: 1 });
    await expect(booted).rejects.toThrow("exited before ready");
  });

  test("exec assigns increasing sequence numbers", async () => {
    const { session, worker } = makeSession();
    await boot(session, worker);
    const channel = new StdinChannel(worker.sab!);

    const p1 = session.exec({ op: OpExec, cmd: "echo one" });
    await flush();
    channel.read(1 << 20);
    worker.receive({ type: "response", resp: decodedResp(1) });
    await p1;

    const p2 = session.exec({ op: OpExec, cmd: "echo two" });
    await flush();
    const frame = channel.read(1 << 20);
    expect(new TextDecoder().decode(frame!).startsWith("#SMOLBOX-REQ#2#")).toBe(true);
    worker.receive({ type: "response", resp: decodedResp(2) });

    await Promise.all([p1, p2]);
  });
});
