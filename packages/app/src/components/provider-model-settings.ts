import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";

export type ProviderModelChange =
  | { type: "remove"; modelId: string }
  | { type: "save"; model: ProviderProfileModel; originalModelId: string | null };

export type ProviderModelMutationState =
  | { status: "idle" }
  | { status: "saving"; modelId: string }
  | { status: "error"; modelId: string; message: string };

interface ProviderModelMutationInput {
  provider: AgentProvider;
  additionalModels: ProviderProfileModel[];
  change: ProviderModelChange;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
  refresh: (providers: AgentProvider[]) => Promise<void>;
  fallbackError: string;
  disconnectedError: string;
}

export function updateAdditionalModels(
  models: ProviderProfileModel[],
  change: ProviderModelChange,
): ProviderProfileModel[] {
  if (change.type === "remove") {
    return models.filter((model) => model.id !== change.modelId);
  }
  const originalIndex = models.findIndex((model) => model.id === change.originalModelId);
  if (originalIndex < 0) return [...models, change.model];
  return models.map((model, index) => (index === originalIndex ? change.model : model));
}

export function createProviderModelMutation() {
  let state: ProviderModelMutationState = { status: "idle" };
  const listeners = new Set<() => void>();

  function publish(next: ProviderModelMutationState) {
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearError() {
      if (state.status === "error") publish({ status: "idle" });
    },
    async run(input: ProviderModelMutationInput): Promise<boolean> {
      if (state.status === "saving") return false;
      const { change, provider } = input;
      const modelId = change.type === "remove" ? change.modelId : change.model.id;
      publish({ status: "saving", modelId });
      try {
        const config = await input.patchConfig({
          providers: {
            [provider]: {
              additionalModels: updateAdditionalModels(input.additionalModels, change),
            },
          },
        });
        if (!config) throw new Error(input.disconnectedError);
        await input.refresh([provider]);
        publish({ status: "idle" });
        return true;
      } catch (error) {
        publish({
          status: "error",
          modelId,
          message: error instanceof Error ? error.message : input.fallbackError,
        });
        return false;
      }
    },
  };
}

export type ProviderModelMutation = ReturnType<typeof createProviderModelMutation>;
