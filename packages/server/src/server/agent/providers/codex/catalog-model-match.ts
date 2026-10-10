/**
 * Find the Codex catalog entry for a configured model slug, accepting one
 * leading `source/` segment that model managers add (`magpie/gpt-5.5`).
 *
 * Codex resolves request metadata the same way (`find_model_by_namespaced_suffix`
 * in codex-rs/models-manager), so the tiers found here are the ones Codex
 * keeps when it sends the turn. Codex also falls back to longest-prefix
 * matching; that is deliberately not mirrored, because `model/list` is only
 * the picker subset and a prefix could select a parent (`gpt-5.5` for
 * `gpt-5.5-pro`) whose tiers the real entry does not have.
 */
export function findCodexCatalogModel<T>(
  model: string,
  candidates: readonly T[],
  slugOf: (candidate: T) => string,
): T | undefined {
  const exact = candidates.find((candidate) => slugOf(candidate) === model);
  if (exact) return exact;
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  const namespace = model.slice(0, separator);
  const suffix = model.slice(separator + 1);
  if (suffix.includes("/") || !/^[A-Za-z0-9_-]+$/.test(namespace)) return undefined;
  return candidates.find((candidate) => slugOf(candidate) === suffix);
}
