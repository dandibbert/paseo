import type { ProviderUsage } from "@getpaseo/plugin/server/provider";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Paseo's usage for one T3 provider turn.
 *
 * T3 keeps two figures per provider turn. `turnTokenUsage` counts this prompt's work, with
 * cached reads and cache writes inside `inputTokens`. `tokenUsage` is the context window as the
 * agent last reported it. Paseo, like Claude, reports `inputTokens` without the cached reads, so
 * the cached share is taken out of the input here.
 */
export function usageFromProviderTurn(turn: Record<string, unknown>): ProviderUsage | undefined {
  const work = record(turn.turnTokenUsage);
  const context = record(turn.tokenUsage);
  const usage: ProviderUsage = {};
  const input = count(work.inputTokens);
  const cached = count(work.cachedInputTokens);
  if (input !== undefined) usage.inputTokens = Math.max(0, input - Math.min(cached ?? 0, input));
  if (cached !== undefined) usage.cachedInputTokens = cached;
  const output = count(work.outputTokens);
  if (output !== undefined) usage.outputTokens = output;
  const used = count(context.usedTokens);
  const max = count(context.maxTokens);
  if (used !== undefined) usage.contextWindowUsedTokens = used;
  if (max !== undefined && max > 0) usage.contextWindowMaxTokens = max;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
