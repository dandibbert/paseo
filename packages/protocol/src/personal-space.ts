import type { AgentMode } from "./agent-types.js";

/**
 * Mode ids that let an agent act without approval prompts, across providers. A personal space
 * conversation defaults to one of these so its agent can read and write outside its folder.
 */
const FULL_ACCESS_MODE_IDS = ["bypassPermissions", "full-access", "allowAll", "danger-full-access"];

/** The provider's full-access mode, or null when it has none. */
export function pickFullAccessModeId(
  modes: readonly Pick<AgentMode, "id" | "label">[],
): string | null {
  for (const id of FULL_ACCESS_MODE_IDS) {
    if (modes.some((mode) => mode.id === id)) return id;
  }
  return modes.find((mode) => /full access|bypass/i.test(mode.label))?.id ?? null;
}
