// Pulls a checkpoint from the registry into dist/models so the dev server can
// serve it locally. The registry (web/src/agent/models.ts) is the single source
// of which revision is current, so the thing that downloads weights and the
// thing that loads them cannot disagree.
//
//   bun web/fetch-model.ts              # the default entry
//   bun web/fetch-model.ts qwen3-1.7b   # a specific one
//   bun web/fetch-model.ts --list
//
// transformers.js resolves a local model as <localModelPath>/<repo>/<file>, so
// the layout here mirrors the HF repo exactly.

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MODEL_KEY,
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

const entry = modelFor(args[0] ?? DEFAULT_MODEL_KEY);
if (entry.local) {
  // No ONNX build of these exists on the hub and the source weights are gated,
  // so there is nothing here to download (PLAN §11.1.5). Say which command does
  // produce them rather than emitting a wall of 404s.
  say(`${entry.key} is built locally, not downloaded.`);
  say(`  run: make antares-onnx ANTARES=${entry.repo.split("/").pop()?.replace("-ONNX", "")}`);
  process.exit(1);
}
// The first candidate dtype is what a headless run will use; f16 variants are a
// runtime choice the page makes against the adapter, not something to download
// speculatively. A safetensors repo has no variants at all — the quantization is
// baked in — so the dtype is only along for the log line.
const dtype = entry.dtypes[0]!;
const layout = entry.weights ?? "onnx";
const weights = weightFiles(dtype, layout);
const extras = layout === "safetensors" ? SAFETENSORS_EXTRA_FILES : [];

const outRoot = path.join("dist", "models", entry.repo);

async function sizeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

async function fetchFile(rel: string, optional: boolean): Promise<number> {
  const dest = path.join(outRoot, rel);
  const url = `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${rel}`;

  // Bun drops content-length on the HEAD (it negotiates a compressed transfer),
  // so the authoritative size is HF's own x-linked-size, which it exposes via
  // access-control-expose-headers for exactly this.
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
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
  const res = await fetch(url, { redirect: "follow" });
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
