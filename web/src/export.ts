// Getting bytes back out of the guest, over the exec API and nothing else.
//
// The protocol has no file-transfer op and does not need one: `dd` seeks, and
// base64 turns a binary window into something a response frame can carry
// unharmed. So an export is a stat, a loop of range reads, and a hash — all of
// them ordinary commands, which keeps the wire surface exactly where M7 left it
// (AGENTS: new capability goes *around* the exec API, not inside it).
//
// Everything here is pure over the exec interface, so `bun test` drives the
// whole thing against a scripted session. The one DOM function is at the
// bottom and does no work worth testing.

import { OpExec, type Request, type Response } from "./protocol.ts";

/** The slice of Session this module needs. Both pages' Sessions satisfy it. */
export interface ExecLike {
  exec(req: Request, timeoutMs?: number): Promise<Response>;
}

export class ExportError extends Error {}

/**
 * How much of the file one command reads.
 *
 * The arithmetic is the load-bearing part. 512 KiB of raw bytes base64s to
 * 699,052 bytes, which sits under the 1 MiB cap requested below and well under
 * the guest's own frame ceiling of 1,162,808 (guest/smolagentd/agent.go
 * maxOutputCeiling). So a well-formed chunk cannot be truncated, and a response
 * that comes back `truncated` anyway means something else is wrong — it is
 * treated as a hard error rather than absorbed as a short read.
 */
export const CHUNK_BYTES = 512 * 1024;
export const CHUNK_MAX_OUTPUT = 1 << 20;

/**
 * The ceiling on one export.
 *
 * Not a protocol limit — it is about this side: the bytes are assembled whole
 * in the tab, and every one of them is copied through an emulated x86 twice
 * (once by dd, once by base64). A gigabyte would technically work and would
 * take long enough to look like a hang.
 */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 60_000;

export interface GuestStat {
  kind: "file" | "directory" | "other";
  size: number;
}

export interface ReadOptions {
  /** Skips the stat round-trip when the caller already has one. */
  size?: number;
  chunkBytes?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Compare a guest-side sha256sum against the assembled bytes. Default true. */
  verify?: boolean;
  onProgress?(done: number, total: number): void;
  signal?: { aborted: boolean };
}

export interface ExportResult {
  name: string;
  bytes: Uint8Array;
  /** Null when the guest had no sha256sum, or verification was turned off. */
  sha256: string | null;
}

// Single quotes are fully literal in sh. The one character that cannot appear
// inside them is a single quote, so it is closed, escaped, and reopened. Same
// rule as the template tools' quoting (agent/user-tools.ts); a path is user
// input and lands here as one argument or not at all.
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The last path segment, which is what the download is named. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx < 0 ? trimmed : trimmed.slice(idx + 1);
  return name || "download";
}

/**
 * What the guest says the path is.
 *
 * `%F|%s` in one call rather than a test-and-then-size: the file could change
 * between two commands, and the size read here is the one the loop below is
 * held to.
 */
export async function statGuestFile(session: ExecLike, path: string): Promise<GuestStat> {
  const resp = await session.exec({
    op: OpExec,
    cmd: `stat -c '%F|%s' -- ${shellQuote(path)}`,
    timeout_ms: 10_000,
  });
  if (resp.exit_code !== 0) {
    throw new ExportError(firstLine(resp.stderr) || `cannot stat ${path} (exit ${resp.exit_code})`);
  }
  const [what, size] = resp.stdout.trim().split("|");
  const bytes = Number(size);
  if (!what || !Number.isFinite(bytes)) {
    throw new ExportError(`cannot stat ${path}: unexpected output ${JSON.stringify(resp.stdout)}`);
  }
  const kind = what.includes("directory") ? "directory" : what.includes("regular") ? "file" : "other";
  return { kind, size: bytes };
}

/**
 * Reads a regular file out of the guest.
 *
 * Rejects anything that is not a regular file by name rather than by symptom:
 * `dd` on a directory reads zero bytes and would otherwise produce an empty
 * download with no explanation, and on a character device it would never end.
 */
export async function readGuestFile(session: ExecLike, path: string, opts: ReadOptions = {}): Promise<ExportResult> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_EXPORT_BYTES;

  let size = opts.size;
  if (size === undefined) {
    const st = await statGuestFile(session, path);
    if (st.kind !== "file") {
      throw new ExportError(
        st.kind === "directory"
          ? `${path} is a directory; tar it first (tar czf /tmp/out.tgz -C ${path} .) and export that`
          : `${path} is not a regular file`,
      );
    }
    size = st.size;
  }
  if (size > maxBytes) {
    throw new ExportError(
      `${path} is ${formatBytes(size)}, over the ${formatBytes(maxBytes)} export limit — ` +
        `the bytes are assembled in this tab and copied twice through an emulated CPU on the way out`,
    );
  }

  const out = new Uint8Array(size);
  let done = 0;
  opts.onProgress?.(0, size);

  for (let skip = 0; done < size; skip++) {
    if (opts.signal?.aborted) {
      throw new ExportError(`export of ${path} cancelled after ${formatBytes(done)}`);
    }
    const resp = await session.exec({
      op: OpExec,
      cmd: `dd if=${shellQuote(path)} bs=${chunkBytes} skip=${skip} count=1 2>/dev/null | base64`,
      timeout_ms: timeoutMs,
      max_output: CHUNK_MAX_OUTPUT,
    });
    if (resp.exit_code !== 0) {
      throw new ExportError(firstLine(resp.stderr) || `reading ${path} failed (exit ${resp.exit_code})`);
    }
    // Cannot happen with the chunk arithmetic above, which is exactly why it is
    // worth saying so loudly instead of writing short bytes into the download.
    if (resp.truncated) {
      throw new ExportError(`reading ${path}: the guest truncated a chunk (chunk ${skip}, ${chunkBytes} bytes)`);
    }
    // Whitespace is stripped here rather than asking for `base64 -w0`: busybox
    // and coreutils disagree about that flag, and both are on the PATH.
    const chunk = decodeBase64(resp.stdout.replace(/\s+/g, ""));
    if (chunk.length === 0) {
      throw new ExportError(
        `reading ${path}: the guest returned nothing at offset ${formatBytes(done)} of ${formatBytes(size)} — ` +
          `the file changed underneath the export`,
      );
    }
    if (done + chunk.length > size) {
      throw new ExportError(`reading ${path}: the file grew during the export`);
    }
    out.set(chunk, done);
    done += chunk.length;
    opts.onProgress?.(done, size);
  }

  const sha256 = opts.verify === false ? null : await verify(session, path, out);
  return { name: basename(path), bytes: out, sha256 };
}

/**
 * Holds the export to the guest's own hash.
 *
 * Every failure mode this module has — a dropped chunk, a mangled base64
 * decode, a file rewritten mid-read — ends as bytes that differ from the
 * guest's, and nothing else here would notice. A guest without sha256sum
 * degrades to no verification; a guest whose hash *disagrees* is a hard error.
 */
async function verify(session: ExecLike, path: string, bytes: Uint8Array): Promise<string | null> {
  const resp = await session.exec({
    op: OpExec,
    cmd: `sha256sum -- ${shellQuote(path)}`,
    timeout_ms: 60_000,
  });
  if (resp.exit_code !== 0) {
    return null;
  }
  const want = resp.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(want)) {
    return null;
  }
  const got = await sha256Hex(bytes);
  if (got !== want) {
    throw new ExportError(`${path}: sha256 mismatch — guest says ${want}, ${bytes.length} exported bytes hash to ${got}`);
  }
  return got;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(s: string): Uint8Array {
  if (!s) {
    return new Uint8Array(0);
  }
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

export function formatBytes(n: number): string {
  if (n >= 1 << 20) {
    return `${(n / (1 << 20)).toFixed(1)} MiB`;
  }
  if (n >= 1 << 10) {
    return `${(n / (1 << 10)).toFixed(0)} KiB`;
  }
  return `${n} B`;
}

/** Hands the assembled bytes to the browser as a download. */
export function saveBytes(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn of the loop: Chromium starts the download
  // synchronously from click(), but Firefox has been known not to.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
