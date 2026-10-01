import { describe, expect, it } from "vitest";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { createProviderModelMutation, updateAdditionalModels } from "./provider-model-settings";

const manualModel: ProviderProfileModel = { id: "custom-model", label: "Custom model" };
const otherModel: ProviderProfileModel = { id: "other-model", label: "Other model" };

function createConfigAdapter(models: ProviderProfileModel[]) {
  let config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: true },
    providers: { claude: { additionalModels: models } },
  });
  const patches: MutableDaemonConfigPatch[] = [];
  const refreshedProviders: string[][] = [];
  let patchError: Error | null = null;
  let refreshError: Error | null = null;
  let patchGate: Promise<void> = Promise.resolve();
  let connected = true;
  return {
    patches,
    refreshedProviders,
    getConfig: () => config,
    failPatch(error: Error | null) {
      patchError = error;
    },
    failRefresh(error: Error | null) {
      refreshError = error;
    },
    pausePatch(gate: Promise<void>) {
      patchGate = gate;
    },
    disconnect() {
      connected = false;
    },
    async patchConfig(patch: MutableDaemonConfigPatch) {
      patches.push(patch);
      await patchGate;
      if (patchError) throw patchError;
      if (!connected) return undefined;
      config = MutableDaemonConfigSchema.parse({ ...config, providers: patch.providers });
      return config;
    },
    async refresh(providers: string[]) {
      refreshedProviders.push(providers);
      if (refreshError) throw refreshError;
    },
  };
}

function removalInput(adapter: ReturnType<typeof createConfigAdapter>) {
  return {
    provider: "claude",
    additionalModels: adapter.getConfig().providers?.claude?.additionalModels ?? [],
    change: { type: "remove" as const, modelId: manualModel.id },
    patchConfig: adapter.patchConfig,
    refresh: adapter.refresh,
    fallbackError: "Failed to save model",
    disconnectedError: "Host disconnected",
  };
}

describe("provider model settings", () => {
  it("deletes a manual model from configuration instead of saving a disabled entry", async () => {
    const adapter = createConfigAdapter([manualModel, otherModel]);
    const mutation = createProviderModelMutation();

    expect(await mutation.run(removalInput(adapter))).toBe(true);
    expect(adapter.getConfig().providers?.claude?.additionalModels).toEqual([otherModel]);
    expect(adapter.patches).toEqual([
      { providers: { claude: { additionalModels: [otherModel] } } },
    ]);
    expect(adapter.refreshedProviders).toEqual([["claude"]]);
    expect(mutation.getState()).toEqual({ status: "idle" });
  });

  it("keeps a failed deletion editable and permits a retry", async () => {
    const adapter = createConfigAdapter([manualModel]);
    adapter.failPatch(new Error("Configuration is read-only"));
    const mutation = createProviderModelMutation();

    expect(await mutation.run(removalInput(adapter))).toBe(false);
    expect(adapter.getConfig().providers?.claude?.additionalModels).toEqual([manualModel]);
    expect(adapter.refreshedProviders).toEqual([]);
    expect(mutation.getState()).toEqual({
      status: "error",
      modelId: manualModel.id,
      message: "Configuration is read-only",
    });

    adapter.failPatch(null);
    expect(await mutation.run(removalInput(adapter))).toBe(true);
    expect(adapter.getConfig().providers?.claude?.additionalModels).toEqual([]);
  });

  it("rejects repeated writes while persistence and refresh are pending", async () => {
    const adapter = createConfigAdapter([manualModel, otherModel]);
    let releasePatch = () => {};
    adapter.pausePatch(
      new Promise<void>((resolve) => {
        releasePatch = resolve;
      }),
    );
    const mutation = createProviderModelMutation();
    const first = mutation.run(removalInput(adapter));

    expect(mutation.getState()).toEqual({ status: "saving", modelId: manualModel.id });
    expect(await mutation.run(removalInput(adapter))).toBe(false);
    expect(adapter.patches).toHaveLength(1);
    releasePatch();
    expect(await first).toBe(true);
  });

  it("reports refresh failures after the manual entry was removed", async () => {
    const adapter = createConfigAdapter([manualModel]);
    adapter.failRefresh(new Error("Catalog refresh failed"));
    const mutation = createProviderModelMutation();

    expect(await mutation.run(removalInput(adapter))).toBe(false);
    expect(adapter.getConfig().providers?.claude?.additionalModels).toEqual([]);
    expect(mutation.getState()).toEqual({
      status: "error",
      modelId: manualModel.id,
      message: "Catalog refresh failed",
    });
  });

  it("does not report a disconnected config write as successful", async () => {
    const adapter = createConfigAdapter([manualModel]);
    adapter.disconnect();
    const mutation = createProviderModelMutation();

    expect(await mutation.run(removalInput(adapter))).toBe(false);
    expect(adapter.refreshedProviders).toEqual([]);
    expect(mutation.getState()).toEqual({
      status: "error",
      modelId: manualModel.id,
      message: "Host disconnected",
    });
  });

  it("hides discovered models with a removable override", async () => {
    const adapter = createConfigAdapter([manualModel]);
    const mutation = createProviderModelMutation();
    const hiddenModel = { id: "claude-sonnet-4-6", label: "Sonnet", isSelectable: false };

    expect(
      await mutation.run({
        ...removalInput(adapter),
        change: { type: "save", model: hiddenModel, originalModelId: null },
      }),
    ).toBe(true);
    expect(adapter.getConfig().providers?.claude?.additionalModels).toEqual([
      manualModel,
      hiddenModel,
    ]);
  });

  it("replaces a manual model when its unavailable ID is edited", () => {
    expect(
      updateAdditionalModels([manualModel, otherModel], {
        type: "save",
        model: { ...manualModel, id: "corrected-model" },
        originalModelId: manualModel.id,
      }),
    ).toEqual([{ ...manualModel, id: "corrected-model" }, otherModel]);
  });
});
