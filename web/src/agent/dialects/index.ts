import { bonsai } from "./bonsai.ts";
import { gemma4 } from "./gemma4.ts";
import { hermes } from "./hermes.ts";
import { lfm2 } from "./lfm2.ts";
import { lfm25 } from "./lfm25.ts";
import { llama } from "./llama.ts";
import { qwen35 } from "./qwen35.ts";
import type { Dialect } from "./types.ts";

export type { Dialect } from "./types.ts";
export { lfm2, lfm25, hermes, llama, gemma4, qwen35, bonsai };

export const dialects = { lfm2, "lfm2.5": lfm25, hermes, llama, gemma4, "qwen3.5": qwen35, bonsai } as const;

export type DialectName = keyof typeof dialects;

export function dialectFor(name: DialectName): Dialect {
  const d = dialects[name];
  if (!d) {
    throw new Error(`unknown dialect: ${String(name)}`);
  }
  return d;
}
