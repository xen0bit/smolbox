// Downloads the WebGPU kernel engines into dist/kernels.
//
// Both are published as Hugging Face Spaces (webml-community/gemma-4-webgpu-kernels
// and webml-community/ternary-bonsai-2-webgpu-kernels). They are pulled at a
// pinned revision, the same shape as `make model`: dist/ is gitignored build
// output, the revision is fixed here so a build is reproducible, and a minified
// megabyte of somebody else's bundle stays out of our history. `make site`
// ships them with the deployment.
//
//   bun web/fetch-kernels.ts            # every engine
//   bun web/fetch-kernels.ts gemma      # one of them
//
// The page imports each engine dynamically and says what to run when it is
// missing (see gemma-kernels.ts, bonsai-kernels.ts), so `make web` still works
// on a checkout that has never run this.

import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { extractBonsaiEngine } from "./src/agent/bonsai-extract.ts";

interface Engine {
  /** The Space, and the commit this project has actually run against. */
  space: string;
  revision: string;
  /** The file to fetch from the Space. */
  file: string;
  /** Where the page imports it from, under dist/. */
  dest: string;
  /** Turns the fetched text into the module, or throws saying why it cannot. */
  prepare(text: string): string;
}

const ENGINES: Record<string, Engine> = {
  // The engine embeds its own WGSL, tokenizer and safetensors reader, so this
  // one module is the whole dependency — there are no sidecar assets to keep in
  // sync.
  gemma: {
    space: "webml-community/gemma-4-webgpu-kernels",
    revision: "158f16ae0f672943ca304d59c47c8e3a264e399e",
    file: "gemma-4-e2b.js",
    dest: path.join("dist", "kernels", "gemma4", "gemma-4-e2b.js"),
    prepare(text) {
      // A wrong file here fails much later, inside a dynamic import, as a syntax
      // error with no hint of where it came from. Check the one thing that is
      // cheap to check: the bundle announces itself on its first line.
      if (!text.slice(0, 120).includes("Gemma4Mobile")) {
        throw new Error(`does not look like the kernel bundle (first line: ${text.split("\n")[0]})`);
      }
      return text;
    },
  },
  // This Space publishes no module at all: the engine is inlined into its
  // index.html, followed by the page's own app code. bonsai-extract.ts cuts the
  // engine out at its export statement. PLAN §10.28.
  bonsai: {
    space: "webml-community/ternary-bonsai-2-webgpu-kernels",
    revision: "94320c9da2b7aeac5b5807c9e61d696a3c09edb5",
    file: "index.html",
    dest: path.join("dist", "kernels", "bonsai", "ternary-bonsai-2.js"),
    prepare: extractBonsaiEngine,
  },
};

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function fetchEngine(name: string, engine: Engine): Promise<void> {
  const existing = await stat(engine.dest).catch(() => null);
  if (existing && existing.size > 0) {
    say(`ok: ${engine.dest} (${(existing.size / 1e3).toFixed(0)} kB, cached)`);
    return;
  }

  const url = `https://huggingface.co/spaces/${engine.space}/resolve/${engine.revision}/${engine.file}`;
  say(`fetching ${engine.space}@${engine.revision.slice(0, 8)}/${engine.file} -> ${engine.dest}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  }
  let body: string;
  try {
    body = engine.prepare(await res.text());
  } catch (err) {
    throw new Error(`${name}: ${engine.file} ${err instanceof Error ? err.message : String(err)}`);
  }

  await mkdir(path.dirname(engine.dest), { recursive: true });
  const tmp = `${engine.dest}.part`;
  await Bun.write(tmp, body);
  await rename(tmp, engine.dest);
  say(`done: ${(body.length / 1e3).toFixed(0)} kB`);
}

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!(name in ENGINES)) {
    say(`error: no kernel engine named ${name} (have: ${Object.keys(ENGINES).join(", ")})`);
    process.exit(1);
  }
}
let failed = false;
for (const name of wanted.length ? wanted : Object.keys(ENGINES)) {
  try {
    await fetchEngine(name, ENGINES[name]!);
  } catch (err) {
    say(`error: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
