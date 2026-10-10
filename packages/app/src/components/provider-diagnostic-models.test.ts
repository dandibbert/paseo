import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  resolveProviderDiscoveredModels,
  resolveProviderManualModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

const piModel: AgentModelDefinition = {
  provider: "pi",
  id: "pi/model",
  label: "Pi Model",
};

const grokModel: AgentModelDefinition = {
  provider: "grok",
  id: "grok-build",
  label: "Grok Build",
};

function resolveModels(input: {
  serverId?: string;
  provider: string;
  currentModels?: AgentModelDefinition[];
  additionalModels?: { id: string; label: string }[];
  providerConfig?: { env: Record<string, string> };
  loading?: boolean;
  cache?: ProviderDiscoveredModelsCache | null;
}) {
  return resolveProviderDiscoveredModels({
    serverId: input.serverId ?? "local",
    provider: input.provider,
    currentModels: input.currentModels,
    providerConfig: input.providerConfig,
    additionalModels: input.additionalModels ?? [],
    providerSnapshotRefreshing: input.loading === true,
    previousCache: input.cache ?? null,
  });
}

describe("resolveProviderDiscoveredModels", () => {
  it("keeps a provider's cached discovered models visible while that provider refreshes", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([grokModel]);
  });

  it("excludes compatibility-only models from display and cache", () => {
    const compatibilityModel: AgentModelDefinition = {
      ...piModel,
      id: "pi/model-legacy",
      label: "Pi Model legacy",
      isSelectable: false,
    };

    const result = resolveModels({
      provider: "pi",
      currentModels: [piModel, compatibilityModel],
    });

    expect(result.models).toEqual([piModel]);
    expect(result.cache?.models).toEqual([piModel]);
  });

  it("does not show one provider's cached models while another provider loads", () => {
    const ready = resolveModels({ provider: "pi", currentModels: [piModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([]);
  });

  it("does not show another server's cached models while the same provider loads", () => {
    const ready = resolveModels({
      serverId: "server-a",
      provider: "grok",
      currentModels: [grokModel],
    });

    const refreshing = resolveModels({
      serverId: "server-b",
      provider: "grok",
      loading: true,
      cache: ready.cache,
    });

    expect(refreshing.models).toEqual([]);
  });
});

describe("manual model management", () => {
  it("shows configured models only in the manual section", () => {
    const additionalModels = [{ id: grokModel.id, label: "My Grok" }];
    const result = resolveModels({
      provider: "grok",
      currentModels: [grokModel],
      additionalModels,
    });

    expect(result.models).toEqual([]);
    expect(resolveProviderManualModels(additionalModels, [grokModel])).toEqual([
      { model: additionalModels[0], status: "available" },
    ]);
  });

  it("keeps unavailable and hidden manual entries editable without promoting them", () => {
    const unavailable = { id: "missing-model", label: "Missing model", isSelectable: true };
    const hidden = { id: grokModel.id, label: "Hidden model", isSelectable: false };
    const additionalModels = [unavailable, hidden];
    const catalog = [
      { ...grokModel, isSelectable: false },
      { provider: "grok", ...unavailable, isSelectable: false },
    ];

    expect(resolveProviderManualModels(additionalModels, catalog)).toEqual([
      { model: unavailable, status: "unavailable" },
      { model: hidden, status: "disabled" },
    ]);
    expect(
      resolveModels({ provider: "grok", currentModels: catalog, additionalModels }).models,
    ).toEqual([]);
  });

  it("keeps configured entries editable even when discovery returns no catalog", () => {
    const manual = { id: "stale-model", label: "Stale model" };
    expect(resolveProviderManualModels([manual], undefined)).toEqual([
      { model: manual, status: "unavailable" },
    ]);
  });

  it("does not resurrect a model just hidden with an override during refresh", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });
    const refreshing = resolveModels({
      provider: "grok",
      loading: true,
      cache: ready.cache,
      additionalModels: [{ id: grokModel.id, label: grokModel.label }],
    });

    expect(refreshing.models).toEqual([]);
    expect(refreshing.cache?.models).toEqual([]);
  });

  it("does not restore a removed catalog on a later refresh", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });
    const empty = resolveModels({ provider: "grok", currentModels: [], cache: ready.cache });
    expect(resolveModels({ provider: "grok", loading: true, cache: empty.cache }).models).toEqual(
      [],
    );
  });
});

describe("provider discovery identity", () => {
  it("drops cached models after endpoint configuration changes", () => {
    const ready = resolveModels({
      provider: "grok",
      currentModels: [grokModel],
      providerConfig: { env: { API_BASE_URL: "https://first.example" } },
    });
    expect(
      resolveModels({
        provider: "grok",
        loading: true,
        cache: ready.cache,
        providerConfig: { env: { API_BASE_URL: "https://second.example" } },
      }).models,
    ).toEqual([]);
  });

  it("respects an explicitly empty catalog while loading", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });
    expect(
      resolveModels({
        provider: "grok",
        loading: true,
        currentModels: [],
        cache: ready.cache,
      }).models,
    ).toEqual([]);
  });
});
