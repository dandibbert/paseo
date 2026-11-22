import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderOptionControl,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type { T3Instance, T3Model, T3OptionDescriptor } from "./environment.js";

/** Paseo model ids name the account as well: `<T3 instance>::<model slug>`. */
const MODEL_SEPARATOR = "::";

/** T3's own default for new threads. */
export const DEFAULT_RUNTIME_MODE = "full-access";

const RUNTIME_MODES: Record<string, ProviderMode> = {
  "approval-required": {
    id: "approval-required",
    label: "Ask",
    description: "Ask before commands and edits.",
    icon: "ShieldCheck",
  },
  "auto-accept-edits": {
    id: "auto-accept-edits",
    label: "Accept edits",
    description: "Apply edits; ask before commands.",
    icon: "ShieldAlert",
  },
  auto: {
    id: "auto",
    label: "Auto",
    description: "Antigravity decides what needs your approval.",
    icon: "Shield",
  },
  "full-access": {
    id: "full-access",
    label: "Full access",
    description: "Approve tool requests without asking.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
};

export interface ModelRef {
  instanceId: string;
  slug: string;
}

export function modelId(ref: ModelRef): string {
  return `${ref.instanceId}${MODEL_SEPARATOR}${ref.slug}`;
}

export function parseModelId(id: string): ModelRef | undefined {
  const at = id.indexOf(MODEL_SEPARATOR);
  if (at <= 0) return undefined;
  return { instanceId: id.slice(0, at), slug: id.slice(at + MODEL_SEPARATOR.length) };
}

export function usableInstances(instances: readonly T3Instance[]): T3Instance[] {
  return instances.filter((instance) => instance.enabled && instance.models.length > 0);
}

function reasoningDescriptor(model: T3Model) {
  return model.optionDescriptors.find(
    (descriptor): descriptor is Extract<T3OptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" && descriptor.role === "reasoning",
  );
}

function thinkingOptions(model: T3Model): ProviderThinkingOption[] {
  return (reasoningDescriptor(model)?.options ?? []).map((option) => {
    const thinking: ProviderThinkingOption = { id: option.id, label: option.label };
    if (option.description) thinking.description = option.description;
    if (option.isDefault) thinking.isDefault = true;
    return thinking;
  });
}

function defaultThinking(model: T3Model): string | undefined {
  const descriptor = reasoningDescriptor(model);
  return (
    descriptor?.currentValue ??
    descriptor?.options.find((option) => option.isDefault)?.id ??
    descriptor?.options[0]?.id
  );
}

/** Options other than reasoning become composer controls, keyed by T3's option id. */
export function optionControls(model: T3Model | undefined): ProviderOptionControl[] {
  if (!model) return [];
  return model.optionDescriptors.flatMap((descriptor): ProviderOptionControl[] => {
    if (descriptor.type === "boolean") {
      return [
        {
          type: "toggle",
          key: descriptor.id,
          label: descriptor.label,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          ...(descriptor.currentValue !== undefined
            ? { defaultValue: descriptor.currentValue }
            : {}),
        },
      ];
    }
    if (descriptor.role === "reasoning") return [];
    return [
      {
        type: "select",
        key: descriptor.id,
        label: descriptor.label,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        ...(descriptor.currentValue ? { defaultValue: descriptor.currentValue } : {}),
        choices: descriptor.options.map((option) => ({ value: option.id, label: option.label })),
      },
    ];
  });
}

export function catalogModels(instances: readonly T3Instance[]): ProviderModel[] {
  const usable = usableInstances(instances);
  const labelAccounts = usable.length > 1;
  return usable.flatMap((instance) =>
    instance.models.map((model) => {
      const options = thinkingOptions(model);
      const thinking = defaultThinking(model);
      return {
        id: modelId({ instanceId: instance.instanceId, slug: model.slug }),
        label: labelAccounts ? `${model.name} · ${instance.displayName}` : model.name,
        ...(labelAccounts ? { description: instance.displayName } : {}),
        ...(model.isDefault && instance === usable[0] ? { isDefault: true } : {}),
        isSelectable: instance.ready,
        metadata: { t3InstanceId: instance.instanceId, t3Model: model.slug },
        ...(options.length > 0 ? { thinkingOptions: options } : {}),
        ...(thinking ? { defaultThinkingOptionId: thinking } : {}),
      } satisfies ProviderModel;
    }),
  );
}

export function catalogModes(instances: readonly T3Instance[]): ProviderMode[] {
  const offered = new Set(usableInstances(instances).flatMap((instance) => instance.runtimeModes));
  const ids = offered.size > 0 ? [...offered] : Object.keys(RUNTIME_MODES);
  return Object.keys(RUNTIME_MODES)
    .filter((id) => ids.includes(id))
    .map((id) => RUNTIME_MODES[id]);
}

export function buildCatalog(instances: readonly T3Instance[]): ProviderCatalog {
  const models = catalogModels(instances);
  const modes = catalogModes(instances);
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  return {
    models,
    modes,
    ...(defaultModel ? { defaultModel: defaultModel.id } : {}),
    defaultMode: modes.some((mode) => mode.id === DEFAULT_RUNTIME_MODE)
      ? DEFAULT_RUNTIME_MODE
      : modes[0]?.id,
    ...(defaultModel?.defaultThinkingOptionId
      ? { defaultThinkingOption: defaultModel.defaultThinkingOptionId }
      : {}),
  };
}

export function findModel(
  instances: readonly T3Instance[],
  ref: ModelRef,
): { instance: T3Instance; model: T3Model } | undefined {
  const instance = instances.find((candidate) => candidate.instanceId === ref.instanceId);
  const model = instance?.models.find((candidate) => candidate.slug === ref.slug);
  return instance && model ? { instance, model } : undefined;
}

/** The model selection T3 receives: the account, the model, and the chosen options. */
export function modelSelection(input: {
  ref: ModelRef;
  model: T3Model | undefined;
  thinkingOption: string | undefined;
  providerOptions: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const options: Array<{ id: string; value: string | boolean }> = [];
  for (const descriptor of input.model?.optionDescriptors ?? []) {
    if (descriptor.type === "select" && descriptor.role === "reasoning") {
      if (input.thinkingOption && descriptor.options.some((o) => o.id === input.thinkingOption)) {
        options.push({ id: descriptor.id, value: input.thinkingOption });
      }
      continue;
    }
    const value = input.providerOptions[descriptor.id];
    if (descriptor.type === "boolean" && typeof value === "boolean") {
      options.push({ id: descriptor.id, value });
    } else if (
      descriptor.type === "select" &&
      typeof value === "string" &&
      descriptor.options.some((option) => option.id === value)
    ) {
      options.push({ id: descriptor.id, value });
    }
  }
  return {
    instanceId: input.ref.instanceId,
    model: input.ref.slug,
    ...(options.length > 0 ? { options } : {}),
  };
}
