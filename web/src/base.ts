// Where this bundle expects to be served from.
//
// Every asset the pages fetch by path — the VM worker, the onnxruntime builds,
// the local weights, the Gemma kernel engine — used to be spelled as a
// root-absolute URL: `/worker.js`, `/ort/`, `/models/`. That is exactly right
// for `make serve`, which puts the site at the root of localhost:8080, and it
// 404s everywhere else. A GitHub Pages project site is served from
// `https://<user>.github.io/<repo>/`, so `/worker.js` there resolves to
// `https://<user>.github.io/worker.js` — a path that belongs to a different
// repo's site and has never existed.
//
// So the prefix is a build flag now, in the same shape and for the same reason
// as SMOLBOX_MODEL_SOURCE (see agent/model-source.ts): web/dist is a static
// bundle that `make compress` writes .br/.gz variants beside, so there is
// nothing left for a server to rewrite on the way out. Choosing where the site
// lives is therefore a rebuild.
//
//   make web                         served from the root (the default)
//   SMOLBOX_BASE=/smolbox/ make web  served from a subdirectory
//
// It is not a runtime lookup off `document.baseURI` because the same value has
// to be reachable from inside a worker, where there is no document, and from
// model-worker.ts, which is two directories deep and would need a different
// relative form than the page that spawned it. One literal, substituted once,
// means every caller spells the same thing.

/**
 * Substituted at build time by `bun build --define` — see the `web` target.
 *
 * Declared rather than imported because it is a bare identifier the bundler
 * replaces with a literal; `process.env` would not survive a browser build,
 * which does not polyfill `process`. A build that omits the flag leaves the
 * identifier undefined, which is why the read below goes through a `typeof`
 * guard rather than touching it directly.
 */
declare const SMOLBOX_BASE: string | undefined;

/** What a build with no flag set gets: the site is the whole origin. */
export const DEFAULT_BASE = "/";

/**
 * Normalises a base path to the one form the rest of the code may assume:
 * a leading slash and a trailing slash.
 *
 * Both slashes are load-bearing rather than tidiness. Without the leading one
 * the prefix is relative, so `asset("worker.js")` inside a page at `/agent/`
 * would resolve against `/agent/` and miss. Without the trailing one
 * `"/smolbox" + "worker.js"` is `/smolboxworker.js`, which is the kind of bug
 * that shows up as a 404 nobody can place.
 *
 * Anything unusable — empty, whitespace, undefined — becomes the default, for
 * the same reason parseModelSource is permissive: a hand-rolled `bun build` or
 * a unit test importing this module should get a working page, not a throw.
 * The `web` target does the strict validation, so a typo fails the build.
 */
export function parseBase(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return DEFAULT_BASE;
  }
  const withLead = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  return withLead.endsWith("/") ? withLead : withLead + "/";
}

/** The prefix this bundle was built for, always `/…/`. */
export const BASE: string = parseBase(
  typeof SMOLBOX_BASE === "undefined" ? undefined : SMOLBOX_BASE,
);

/**
 * The URL for a site asset, named by its path relative to the site root.
 *
 * Call it with the path as it appears under web/dist — `asset("worker.js")`,
 * `asset("ort/")` — and never with a leading slash. A leading slash is
 * stripped rather than rejected: the old spelling is what every caller here
 * used to be, so quietly doing the right thing with it is worth more than
 * catching a mistake that produces an obviously broken URL anyway.
 */
export function asset(path: string): string {
  return BASE + (path.startsWith("/") ? path.slice(1) : path);
}
