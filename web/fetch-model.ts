// Pulls a checkpoint from the registry into dist/models so the dev server can
// serve it locally. The registry (web/src/agent/models.ts) is the single source
// of which revision is current, so the thing that downloads weights and the
// thing that loads them cannot disagree.
//
//   bun web/fetch-model.ts                        # the default entry
//   bun web/fetch-model.ts qwen3-1.7b             # a specific one
//   bun web/fetch-model.ts gemma4-e2b-onnx --dtype q4   # a non-default build
//   bun web/fetch-model.ts --list
//   bun web/fetch-model.ts --keys              # downloadable keys, for `make models`
//
// transformers.js resolves a local model as <localModelPath>/<repo>/<file>, so
// the layout here mirrors the HF repo exactly.

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MODEL_KEY,
  type Dtype,
  OPTIONAL_FILES,
  REQUIRED_FILES,
  SAFETENSORS_EXTRA_FILES,
  modelFor,
  models,
  weightFiles,
} from "./src/agent/models.ts";

// stderr, not console.log: bun block-buffers stdout to a pipe, so a `make model`
// piped into a log shows nothing until it exits — useless for a 1.2 GB pull.
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function human(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

const args = process.argv.slice(2).filter((a) => a !== "");
if (args.includes("--list")) {
  for (const m of models) {
    say(`${m.key.padEnd(24)} ${human(m.approxBytes).padStart(9)}  ${m.dialect.padEnd(7)} ${m.label}`);
  }
  process.exit(0);
}

// One key per line on stdout, for `make models` to loop over. The local entries
// are omitted rather than listed and skipped by the caller: whether a key can be
// downloaded is a property of the registry, and this is the only place that
// reads it.
if (args.includes("--keys")) {
  process.stdout.write(`${models.filter((m) => !m.local).map((m) => m.key).join("\n")}\n`);
  process.exit(0);
}

// The key is the first bare argument: `--dtype q4` may come before or after it.
const flagValues = new Set(args.filter((a, i) => args[i - 1]?.startsWith("--")));
const key = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
const entry = modelFor(key ?? DEFAULT_MODEL_KEY);
if (entry.local) {
  // No ONNX build of these exists on the hub and the source weights are gated,
  // so there is nothing here to download (PLAN §11.1.5). Say which command does
  // produce them rather than emitting a wall of 404s.
  say(`${entry.key} is built locally, not downloaded.`);
  say(`  run: make antares-onnx ANTARES=${entry.repo.split("/").pop()?.replace("-ONNX", "")}`);
  process.exit(1);
}
// The first candidate dtype is the one the page prefers, so it is the default
// to pull. `--dtype` exists because "preferred" is a property of the adapter,
// not of this machine: an entry can lead with q4f16 and be downloaded here as
// q4, where no browser exposes shader-f16 (PLAN §10.14). A safetensors repo has
// no variants at all — the quantization is baked in — so the dtype is only along
// for the log line.
// Read the flag's value only when the flag is there: indexOf returns -1 when it
// is absent, and args[-1 + 1] is the key itself — which then failed every
// explicit `make model MODEL=<key>` with "no <key> build".
const dtypeIndex = args.indexOf("--dtype");
const dtypeArg = dtypeIndex === -1 ? undefined : args[dtypeIndex + 1];
if (dtypeIndex !== -1 && !dtypeArg) {
  say("--dtype needs a value");
  process.exit(1);
}
if (dtypeArg && !entry.dtypes.includes(dtypeArg as Dtype)) {
  say(`${entry.key} has no ${dtypeArg} build (it lists: ${entry.dtypes.join(", ")})`);
  process.exit(1);
}
const dtype = (dtypeArg as Dtype | undefined) ?? entry.dtypes[0]!;
const layout = entry.weights ?? "onnx";
const weights = weightFiles(dtype, layout, entry.components);
const extras = layout === "safetensors" ? SAFETENSORS_EXTRA_FILES : [];

const outRoot = path.join("dist", "models", entry.repo);

async function sizeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

/**
 * Fetch, retrying what is worth retrying.
 *
 * The hub returns 504s and drops connections under load, and this downloads
 * multiple gigabytes across a dozen requests — a single transient failure
 * throwing away the whole pull is the wrong trade. 404 and 403 are answers, not
 * failures, so they come straight back: an absent optional file must not cost
 * three retries and twelve seconds.
 */
async function fetchWithRetry(url: string, init: RequestInit, what: string): Promise<Response> {
  const attempts = 4;
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await fetch(url, init);
    } catch (e) {
      err = e;
    }
    if (res && (res.ok || res.status === 404 || res.status === 403)) {
      return res;
    }
    if (attempt === attempts) {
      if (res) {
        return res;
      }
      throw err;
    }
    const waitMs = 1000 * 2 ** (attempt - 1);
    const why = res ? `${res.status} ${res.statusText}` : String(err);
    say(`  retry ${what} in ${waitMs / 1000}s (${why})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function fetchFile(rel: string, optional: boolean): Promise<number> {
  const dest = path.join(outRoot, rel);
  const url = `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${rel}`;

  // Bun drops content-length on the HEAD (it negotiates a compressed transfer),
  // so the authoritative size is HF's own x-linked-size, which it exposes via
  // access-control-expose-headers for exactly this.
  const head = await fetchWithRetry(url, { method: "HEAD", redirect: "follow" }, `HEAD ${rel}`);
  if (!head.ok) {
    if (optional && (head.status === 404 || head.status === 403)) {
      return 0;
    }
    throw new Error(`HEAD ${rel}: ${head.status} ${head.statusText}`);
  }
  const expected = Number(head.headers.get("x-linked-size") ?? head.headers.get("content-length") ?? 0);

  // A hit needs either a matching size or, for the small non-LFS files where HF
  // reports no size at all, merely existing: the revision is pinned, so a file
  // already on disk cannot be a stale version of itself.
  const have = await sizeOf(dest);
  if (have !== null && have > 0 && (expected === 0 || have === expected)) {
    say(`  ok    ${rel} (${human(have)}, cached)`);
    return have;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetchWithRetry(url, { redirect: "follow" }, `GET ${rel}`);
  if (!res.ok || !res.body) {
    if (optional) {
      return 0;
    }
    throw new Error(`GET ${rel}: ${res.status} ${res.statusText}`);
  }

  // Stream rather than Bun.write(dest, res): this reports progress on a file
  // that is over a gigabyte, where a silent multi-minute stall is
  // indistinguishable from a hang.
  const tmp = `${dest}.part`;
  const sink = Bun.file(tmp).writer();
  let written = 0;
  let lastReport = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    sink.write(chunk);
    written += chunk.byteLength;
    if (written - lastReport >= 64 * 1024 * 1024) {
      lastReport = written;
      const pct = expected > 0 ? ` (${Math.round((written / expected) * 100)}%)` : "";
      say(`        ${rel}: ${human(written)}${pct}`);
    }
  }
  await sink.end();

  if (expected > 0 && written !== expected) {
    throw new Error(`GET ${rel}: expected ${expected} bytes, got ${written}`);
  }
  // Rename only on success, so an interrupted pull cannot leave a truncated
  // file that the cached-size check above would then accept.
  await rename(tmp, dest);
  say(`  fetch ${rel} (${human(written)})`);
  return written;
}

say(
  `fetching ${entry.key} (${entry.repo}@${entry.revision.slice(0, 8)}, ` +
    `${layout === "safetensors" ? "safetensors" : dtype}) -> ${outRoot}`,
);

let total = 0;
for (const rel of [...REQUIRED_FILES, ...extras, ...weights.required]) {
  total += await fetchFile(rel, false);
}
for (const rel of [...OPTIONAL_FILES, ...weights.optional]) {
  total += await fetchFile(rel, true);
}
say(`done: ${human(total)}`);
