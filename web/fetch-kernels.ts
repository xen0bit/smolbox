// Downloads the Gemma 4 WebGPU kernel engine into dist/kernels.
//
// It is fetched rather than vendored on purpose. The engine is published as a
// Hugging Face Space (webml-community/gemma-4-webgpu-kernels) that declares NO
// license, so committing a copy into this repository would be redistributing
// code nobody has granted redistribution rights to. Pulling a pinned revision at
// setup time is the same shape as `make model`: dist/ is gitignored build
// output, the revision is fixed here so a run is reproducible, and nothing about
// somebody else's work ends up in our history.
//
//   bun web/fetch-kernels.ts
//
// If the licensing is ever clarified, vendoring becomes a one-line change and
// this file goes away. Until then the page imports it dynamically and says what
// to run when it is missing (see gemma-kernels.ts).

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

/** The Space, and the commit this project has actually run against. */
const SPACE = "webml-community/gemma-4-webgpu-kernels";
const REVISION = "158f16ae0f672943ca304d59c47c8e3a264e399e";
const FILE = "gemma-4-e2b.js";

// The engine embeds its own WGSL, tokenizer and safetensors reader, so this one
// module is the whole dependency — there are no sidecar assets to keep in sync.
const outRoot = path.join("dist", "kernels", "gemma4");

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

const url = `https://huggingface.co/spaces/${SPACE}/resolve/${REVISION}/${FILE}`;
const dest = path.join(outRoot, FILE);

const existing = await stat(dest).catch(() => null);
if (existing && existing.size > 0) {
  say(`ok: ${dest} (${(existing.size / 1e3).toFixed(0)} kB, cached)`);
  process.exit(0);
}

say(`fetching ${SPACE}@${REVISION.slice(0, 8)}/${FILE} -> ${dest}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  say(`error: GET ${url}: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const body = new Uint8Array(await res.arrayBuffer());

// A wrong file here fails much later, inside a dynamic import, as a syntax
// error with no hint of where it came from. Check the one thing that is cheap to
// check: the bundle announces itself on its first line.
const head = new TextDecoder().decode(body.slice(0, 120));
if (!head.includes("Gemma4Mobile")) {
  say(`error: ${FILE} does not look like the kernel bundle (first line: ${head.split("\n")[0]})`);
  process.exit(1);
}

await mkdir(outRoot, { recursive: true });
const tmp = `${dest}.part`;
await Bun.write(tmp, body);
await rename(tmp, dest);
say(`done: ${(body.byteLength / 1e3).toFixed(0)} kB`);
