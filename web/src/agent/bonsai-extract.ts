// Cuts the Ternary Bonsai 2 kernel engine out of the Space's index.html.
//
// The Space publishes no module. Its page inlines one `<script type="module">`
// holding the engine — an ordinary ES module that ends in
// `export{…,zl as TernaryBonsai2,…};` — with the page's own app code
// concatenated straight after it. The app half reads the DOM at top level
// (`document.getElementById`, a WebGPU canvas scene), so importing the block
// whole in the model worker would throw before anything else ran. Everything
// up to and including that export statement is the engine and nothing else, so
// the cut is exact.
//
// Minified identifiers change on every rebuild of the Space, so nothing here
// names one: the anchor is the exported NAME, which is the API. The cut must
// match exactly once or the fetch fails loudly — the same rule kernel-f32.ts
// holds its rewrites to, for the same reason: a quiet near-miss would surface
// as a syntax error inside a dynamic import, nine frames from its cause.
// PLAN §10.28.

/** The export the adapter imports; the anchor the cut is made against. */
export const BONSAI_EXPORT = "TernaryBonsai2";

const MODULE_SCRIPT = /<script type="module">([\s\S]*?)<\/script>/g;
const EXPORT_STATEMENT = new RegExp(`export\\{[^{}]*\\bas ${BONSAI_EXPORT}\\b[^{}]*\\};`, "g");

export class BonsaiExtractError extends Error {}

/** Returns the engine module inside the Space's index.html. */
export function extractBonsaiEngine(html: string): string {
  const blocks = [...html.matchAll(MODULE_SCRIPT)]
    .map((m) => m[1]!)
    .filter((b) => b.includes(`as ${BONSAI_EXPORT}`));
  if (blocks.length !== 1) {
    throw new BonsaiExtractError(
      `expected exactly one module script exporting ${BONSAI_EXPORT}, found ${blocks.length}`,
    );
  }
  const block = blocks[0]!;
  const exports = [...block.matchAll(EXPORT_STATEMENT)];
  if (exports.length !== 1) {
    throw new BonsaiExtractError(
      `expected exactly one export statement naming ${BONSAI_EXPORT}, found ${exports.length}`,
    );
  }
  const end = exports[0]!.index! + exports[0]![0].length;
  return block.slice(0, end);
}
