import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export interface ProviderDiscoveredModelsCache {
  serverId: string;
  provider: string;
  models: AgentModelDefinition[];
  providerConfig: MutableDaemonConfig["providers"][string] | undefined;
}

export interface ResolveProviderDiscoveredModelsInput {
  serverId: string;
  provider: string;
  providerConfig?: MutableDaemonConfig["providers"][string];
  currentModels: AgentModelDefinition[] | undefined;
  additionalModels: ProviderProfileModel[];
  providerSnapshotRefreshing: boolean;
  previousCache: ProviderDiscoveredModelsCache | null;
}

export interface ResolveProviderDiscoveredModelsResult {
  models: AgentModelDefinition[];
  cache: ProviderDiscoveredModelsCache | null;
}

export function resolveProviderDiscoveredModels({
  serverId,
  provider,
  providerConfig,
  currentModels,
  additionalModels,
  providerSnapshotRefreshing,
  previousCache,
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const manualIds = new Set(additionalModels.map((model) => model.id));
  const selectableModels = (filterSelectableModels(currentModels ?? null) ?? []).filter(
    (model) => !manualIds.has(model.id),
  );
  if (selectableModels.length > 0) {
    const cache = { serverId, provider, providerConfig, models: selectableModels };
    return { models: selectableModels, cache };
  }

  if (
    currentModels === undefined &&
    providerSnapshotRefreshing &&
    previousCache?.providerConfig === providerConfig &&
    previousCache?.serverId === serverId &&
    previousCache.provider === provider
  ) {
    const models = previousCache.models.filter((model) => !manualIds.has(model.id));
    const cache = { serverId, provider, providerConfig, models };
    return { models, cache };
  }

  return { models: [], cache: null };
}

export interface ProviderManualModel {
  model: ProviderProfileModel;
  status: "available" | "unavailable" | "disabled";
}

export function resolveProviderManualModels(
  additionalModels: ProviderProfileModel[],
  currentModels: AgentModelDefinition[] | undefined,
): ProviderManualModel[] {
  const catalog = new Map(currentModels?.map((model) => [model.id, model]));
  return additionalModels.map((model) => {
    if (model.isSelectable === false) return { model, status: "disabled" };
    const discovered = catalog.get(model.id);
    const available = discovered && discovered.isSelectable !== false;
    return { model, status: available ? "available" : "unavailable" };
  });
}
