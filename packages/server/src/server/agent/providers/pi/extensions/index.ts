import { PiExtensionHost } from "./host.js";
import { piExtensions } from "./registry.js";
import type { Logger } from "pino";
import type { PiExtension } from "./contract.js";

export const piExtensionRuntimeBridge = piExtensions
  .flatMap((extension) => extension.runtimeBridge ?? [])
  .join("\n");

/** Custom entry type → data fields history replay keeps, merged across extensions. */
export const piExtensionHistoryEntries: Record<string, string[]> = {};
for (const extension of piExtensions) {
  for (const [customType, fields] of Object.entries(extension.historyEntries ?? {})) {
    piExtensionHistoryEntries[customType] = [
      ...new Set([...(piExtensionHistoryEntries[customType] ?? []), ...fields]),
    ];
  }
}

export type { PiExtensionHost } from "./host.js";
export type { PiExtensionEventOutput } from "./host.js";

export function createPiExtensionHost(
  logger?: Pick<Logger, "warn">,
  extensions: readonly PiExtension[] = piExtensions,
  hydrationByteBudget?: number,
): PiExtensionHost {
  return new PiExtensionHost(extensions, logger, hydrationByteBudget);
}
