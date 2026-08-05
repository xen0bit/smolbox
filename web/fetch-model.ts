// Pulls the LFM2 tool-calling checkpoint into dist/models/ so the dev server can
// serve it locally. Pinned to a revision sha, not `main`: a model that silently
// changes under the spike would be indistinguishable from a regression.
//
// transformers.js resolves a local model as <localModelPath>/<repo>/<file>, so
// the layout here mirrors the HF repo exactly.

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const REPO = "onnx-community/LFM2-1.2B-Tool-ONNX";
const REVISION = "1992998ab37ef9db120f1589181db465e0f037ad";

// The q4 variant, not q4f16: headless Chromium's ANGLE/Vulkan adapter does not
// expose shader-f16 (PLAN §2.11.24), so an f16 build cannot run in the e2e path.
const FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "chat_template.jinja",
  "onnx/model_q4.onnx",
  "onnx/model_q4.onnx_data",
];

const outRoot = path.join("dist", "models", REPO);

function human(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

// stderr, not console.log: bun block-buffers stdout to a pipe, so a `make model`
// piped into a log shows nothing until it exits — useless for a 1.2 GB pull.
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function sizeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

async function fetchFile(rel: string): Promise<void> {
  const dest = path.join(outRoot, rel);
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${rel}`;

  // Bun drops content-length on the HEAD (it negotiates a compressed transfer),
  // so the authoritative size is HF's own x-linked-size, which it exposes via
  // access-control-expose-headers for exactly this purpose.
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) {
    throw new Error(`HEAD ${rel}: ${head.status} ${head.statusText}`);
  }
  const expected = Number(head.headers.get("x-linked-size") ?? head.headers.get("content-length") ?? 0);

  const have = await sizeOf(dest);
  if (have !== null && expected > 0 && have === expected) {
    say(`  ok    ${rel} (${human(have)}, cached)`);
    return;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
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
}

say(`fetching ${REPO}@${REVISION.slice(0, 8)} -> ${outRoot}`);
let total = 0;
for (const rel of FILES) {
  await fetchFile(rel);
  total += (await sizeOf(path.join(outRoot, rel))) ?? 0;
}
say(`done: ${FILES.length} files, ${human(total)}`);
