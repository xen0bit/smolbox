// Where the page is allowed to read weights from.
//
// Until now this was decided per load, by probing: haveLocalWeights() HEADs
// /models/<repo>/config.json and the page took whatever it found there, falling
// back to the hub. That is the right default for a workstation where `make
// model` has already run and the wrong one for a deployment, where "whatever
// happens to be on the disk" is a property of the machine rather than a
// decision anyone made — and where a half-finished `make models` would silently
// serve some checkpoints locally and some from the hub.
//
// So the decision is a flag now, and it defaults to the hub, which is what a
// visitor to a deployment gets. `local` is kept for the two cases it was built
// for: debugging a checkpoint off the disk, and the opt-in GPU suites, which
// must not re-pull gigabytes on every run.
//
//   make web                              the hub (the default)
//   SMOLBOX_MODEL_SOURCE=local make web   dist/models, as the page used to
//
// It is a BUILD flag rather than a server one because web/dist is a static
// bundle: web/serve.ts only hands files out, and `make compress` writes .br and
// .gz variants beside each one, so the server cannot rewrite a page on its way
// past without invalidating both. Flipping the source is therefore a rebuild.
// That is one command, and it buys a page with no runtime configuration to
// fetch, race, or fail to fetch.

import { type ModelEntry, models } from "./models.ts";

/**
 * Substituted at build time by `bun build --define` — see the `web` target.
 *
 * Declared rather than imported because it is a bare identifier the bundler
 * replaces with a literal; `process.env` would not survive a browser build,
 * which does not polyfill `process`. A build that omits the flag leaves the
 * identifier undefined, which is why every read goes through the `typeof` guard
 * below rather than touching it directly.
 */
declare const SMOLBOX_MODEL_SOURCE: string | undefined;

export type ModelSource = "hub" | "local";

/**
 * What a build with no flag set gets.
 *
 * The hub, because that is the configuration that works for someone who has
 * cloned the repo and run nothing, and because the alternative — a page that
 * silently serves whatever a previous `make models` left behind — is the state
 * this flag exists to end.
 */
export const DEFAULT_MODEL_SOURCE: ModelSource = "hub";

/**
 * Reads the flag, treating anything unrecognised as the default.
 *
 * Permissive on purpose, and it is not the only line of defence: the `web`
 * target rejects a value it does not know, so `SMOLBOX_MODEL_SOURCE=locl` fails
 * the build rather than quietly serving from the hub. What is left for this
 * function is the case where nothing was passed at all — a hand-rolled `bun
 * build`, or a unit test importing the module — and there the answer is the
 * default rather than a throw, because a page that refuses to start is a worse
 * outcome than a page that reads from the hub.
 */
export function parseModelSource(raw: string | null | undefined): ModelSource {
  return raw === "local" ? "local" : DEFAULT_MODEL_SOURCE;
}

/** The source this bundle was built for. */
export const MODEL_SOURCE: ModelSource = parseModelSource(
  typeof SMOLBOX_MODEL_SOURCE === "undefined" ? undefined : SMOLBOX_MODEL_SOURCE,
);

/**
 * Why this entry cannot be offered under `source`, or undefined when it can.
 *
 * Only one thing makes an entry unofferable today, and it is not the weights:
 * every repo in the registry serves its files anonymously from huggingface.co
 * with CORS, verified by HEAD against each pinned revision. What `local` buys is
 * the piece a browser cannot fetch for itself — see ModelEntry.requiresLocalBuild.
 *
 * Returned as a string rather than a boolean because it goes straight in front
 * of a reader: the dropdown shows it on the disabled option and loadModel()
 * throws with it. "Gemma 4 E2B is greyed out" is a bug report; "its kernel
 * engine is not on the hub, run `make gemma-kernels`" is an answer.
 */
export function unavailableReason(
  entry: ModelEntry,
  source: ModelSource = MODEL_SOURCE,
): string | undefined {
  if (source === "local") {
    return undefined;
  }
  return entry.requiresLocalBuild;
}

/** The entries a page built for `source` will actually load. */
export function selectableModels(source: ModelSource = MODEL_SOURCE): ModelEntry[] {
  return models.filter((m) => unavailableReason(m, source) === undefined);
}
