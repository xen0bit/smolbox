import { hermes } from "./hermes.ts";
import { lfm2 } from "./lfm2.ts";
import { llama } from "./llama.ts";
import type { Dialect } from "./types.ts";

export type { Dialect } from "./types.ts";
export { lfm2, hermes, llama };

export const dialects = { lfm2, hermes, llama } as const;

export type DialectName = keyof typeof dialects;

export function dialectFor(name: DialectName): Dialect {
  const d = dialects[name];
  if (!d) {
    throw new Error(`unknown dialect: ${String(name)}`);
  }
  return d;
}
