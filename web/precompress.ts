/**
 * Pre-compresses the served artifacts, writing a `.br` and a `.gz` beside each
 * compressible file in dist/.
 *
 * Why build time rather than request time: smolbox.wasm is ~117 MB and the
 * emscripten build another ~121 MB across two files. Compressing those per
 * request — in the proxy or in serve.ts — burns seconds of CPU on every cold
 * load and, worse, forces a chunked response, which throws away the
 * Content-Length the loading bar reads. Compressing once here costs nothing per
 * request, gets a better ratio than an on-the-fly encoder would risk spending
 * time on, and keeps a real length on the wire (see serve.ts, which reports the
 * identity size in X-Uncompressed-Length).
 *
 * Measured on dist/smolbox.wasm (117.7 MB):
 *
 *   gzip -6              45.4 MB   2.59x
 *   brotli q9 lgwin 22   35.7 MB   3.29x
 *   brotli q9 lgwin 24   32.8 MB   3.59x
 *
 * Across everything served, 531.7 MiB of artifacts become 162.7 MiB of brotli.
 *
 * Both encodings are emitted: brotli for anything from roughly the last decade,
 * gzip as the fallback that every HTTP client understands. serve.ts prefers br.
 *
 * Usage:  bun web/precompress.ts [--quality N] [--force]
 *         DIST_DIR=/path/to/dist bun web/precompress.ts
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, readdir, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import zlib from "node:zlib";

// Extensions worth encoding. Everything here is text or bytecode that gzip and
// brotli both shrink substantially; anything not listed is left alone.
const COMPRESSIBLE = new Set([
  ".wasm",
  ".js",
  ".mjs",
  ".data",
  ".html",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".map",
  ".jinja",
]);

// Below this, the encoding overhead and the extra request-time stat cost more
// than the saving.
const MIN_BYTES = 1024;

/**
 * Directory names never descended into.
 *
 * `models` is the important one. Checkpoint weights are already quantised, so
 * they barely compress, and the Gemma kernel engine reads model.safetensors
 * through 256 KB Range requests — serve.ts declines to serve an encoded variant
 * to a Range request precisely so that stays intact, but generating hundreds of
 * megabytes of near-useless `.br` next to the weights would be wasted work and
 * wasted disk either way.
 */
const SKIP_DIRS = new Set(["models"]);

interface Options {
  quality: number;
  force: boolean;
  roots: string[];
}

function parseArgs(argv: string[]): Options {
  // q9 is the knee of the curve for these artifacts: q5 is 4.77x, q9 is 4.92x
  // for about 4x the time, and q11 buys 5.53x for ~30x the time of q9 — real,
  // but minutes of build for a few MB. Overridable for whoever wants that trade.
  let quality = 9;
  let force = false;
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--quality") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 11) {
        throw new Error(`--quality must be an integer 0-11, got ${argv[i]}`);
      }
      quality = n;
    } else if (argv[i] === "--force") {
      force = true;
    } else if (argv[i].startsWith("-")) {
      throw new Error(`unknown argument: ${argv[i]}`);
    } else {
      roots.push(argv[i]);
    }
  }
  return { quality, force, roots };
}

/**
 * The trees to walk when none are named.
 *
 * Both are served: dist/ holds the VM artifacts and the mounted weights
 * (DIST_DIR points at it in the container), web/dist holds the page bundles and
 * the onnxruntime-web runtime, which serve.ts serves from its own directory.
 * Compressing only the first would leave several MB of .wasm and .js on the
 * identity path.
 */
function defaultRoots(): string[] {
  return [
    fileURLToPath(artifactRoot()),
    fileURLToPath(new URL("./dist/", import.meta.url)),
  ];
}

function artifactRoot(): URL {
  const override = Bun.env.DIST_DIR;
  if (!override) {
    return new URL("../dist/", import.meta.url);
  }
  return pathToFileURL(override.endsWith("/") ? override : override + "/");
}

/**
 * True when `variant` is present and at least as new as `source`.
 *
 * This is what makes the target cheap to re-run: `make compress` after a build
 * that only touched the web bundles re-encodes the bundles and leaves the
 * 117 MB VM alone.
 */
async function upToDate(source: string, variant: string): Promise<boolean> {
  try {
    const [s, v] = await Promise.all([stat(source), stat(variant)]);
    return v.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Encodes one file, streaming.
 *
 * Streamed rather than read-compress-write because these inputs run to 117 MB
 * and there is no reason to hold one, let alone its output, in memory.
 *
 * The output goes to a temporary name and is renamed on success, so an
 * interrupted run cannot leave a truncated `.br` behind — which would be served
 * as a complete response and fail to decode in the browser.
 */
async function encode(source: string, dest: string, size: number, opts: Options): Promise<number> {
  const codec =
    path.extname(dest) === ".br"
      ? zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: opts.quality,
            // Lets brotli size its window against the real input instead of
            // guessing; worth a percent or so on inputs this large.
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
            // 24 is the largest window a stock decoder must accept (RFC 7932);
            // anything beyond it needs the large-window extension, which
            // browsers do not implement. The streaming default of 22 costs
            // real ratio on inputs this size — 35.7 MB against 32.8 MB on
            // smolbox.wasm — for about half the time.
            [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
          },
        })
      : zlib.createGzip({ level: 6 });

  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    await pipeline(createReadStream(source), codec, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return (await stat(dest)).size;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(full);
      }
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function fmt(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${(n / 1024).toFixed(0)} KiB`;
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const roots = opts.roots.length ? opts.roots.map((r) => path.resolve(r)) : defaultRoots();

  let encoded = 0;
  let skipped = 0;
  let identityTotal = 0;
  let brTotal = 0;

  for (const root of roots) {
    for await (const file of walk(root)) {
      const ext = path.extname(file);
      if (!COMPRESSIBLE.has(ext)) {
        continue;
      }
      const info = await stat(file);
      if (info.size < MIN_BYTES) {
        continue;
      }

      for (const suffix of [".br", ".gz"] as const) {
        const dest = file + suffix;
        if (!opts.force && (await upToDate(file, dest))) {
          skipped++;
          if (suffix === ".br") {
            identityTotal += info.size;
            brTotal += (await stat(dest)).size;
          }
          continue;
        }
        const out = await encode(file, dest, info.size, opts);
        if (suffix === ".br") {
          encoded++;
          identityTotal += info.size;
          brTotal += out;
          const rel = path.relative(root, file);
          console.log(
            `  ${rel}: ${fmt(info.size)} -> ${fmt(out)} br (${(info.size / out).toFixed(2)}x)`,
          );
        }
      }
    }
  }

  if (encoded === 0 && skipped === 0) {
    console.log(`precompress: nothing to compress under ${roots.join(", ")} (build first)`);
    return;
  }
  console.log(
    `precompress: ${encoded} encoded, ${skipped} already current` +
      (identityTotal
        ? `; brotli total ${fmt(identityTotal)} -> ${fmt(brTotal)} (${(identityTotal / brTotal).toFixed(2)}x)`
        : ""),
  );
}

await main();
