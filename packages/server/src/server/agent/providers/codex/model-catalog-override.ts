import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execCommand } from "../../../../utils/spawn.js";
import {
  createProviderEnvSpec,
  type ProviderProfileModel,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";

const CODEX_MODEL_CATALOG_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const CODEX_MODEL_CATALOG_CACHE_DIR = path.join(os.tmpdir(), "paseo-codex-model-catalog");
const bundledCatalogPromises = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExplicitContextWindow(
  model: ProviderProfileModel,
): model is ProviderProfileModel & { contextWindowMaxTokens: number } {
  return (
    typeof model.contextWindowMaxTokens === "number" &&
    Number.isInteger(model.contextWindowMaxTokens) &&
    model.contextWindowMaxTokens > 0
  );
}

function configuredContextModels(
  models: readonly ProviderProfileModel[] | undefined,
): Array<ProviderProfileModel & { contextWindowMaxTokens: number }> {
  return (models ?? []).filter(hasExplicitContextWindow);
}

function configuredModelSlugs(model: ProviderProfileModel): string[] {
  return Array.from(
    new Set(
      [model.id, ...(model.aliases ?? [])]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function buildConfiguredFallbackModel(params: {
  template: Record<string, unknown>;
  model: ProviderProfileModel & { contextWindowMaxTokens: number };
  slug: string;
}): Record<string, unknown> {
  const { template, model, slug } = params;
  const contextWindow = model.contextWindowMaxTokens;
  return {
    ...template,
    guardian: null,
    slug,
    display_name: slug === model.id ? model.label : slug,
    description: model.description ?? null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "none",
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    // An explicit Paseo value is the user-facing usable window. Codex normally
    // reserves 5% in model metadata, which would turn a configured 500k into
    // 475k. Keep the explicit override exact; auto compaction still defaults
    // to 90% of the resulting context window.
    effective_context_window_percent: 100,
    experimental_supported_tools: [],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null,
    multi_agent_reasoning_effort: null,
  };
}

function applyExplicitContextWindow(
  model: Record<string, unknown>,
  contextWindow: number,
): Record<string, unknown> {
  return {
    ...model,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    effective_context_window_percent: 100,
  };
}

/**
 * Codex clamps `model_context_window` to the selected model's catalog
 * `max_context_window`. Unknown model slugs use Codex's fallback metadata, so
 * a per-thread override alone cannot raise their window. Preserve the bundled
 * catalog and augment only models explicitly configured by Paseo.
 */
export function augmentCodexModelCatalog(
  rawCatalog: unknown,
  configuredModels: readonly ProviderProfileModel[] | undefined,
): Record<string, unknown> | null {
  const contextModels = configuredContextModels(configuredModels);
  if (contextModels.length === 0) {
    return null;
  }
  if (!isRecord(rawCatalog) || !Array.isArray(rawCatalog.models)) {
    throw new Error("Codex bundled model catalog did not contain a models array");
  }
  if (rawCatalog.models.length === 0 || rawCatalog.models.some((model) => !isRecord(model))) {
    throw new Error("Codex bundled model catalog contained no usable model definitions");
  }

  const models = (rawCatalog.models as Record<string, unknown>[]).slice();
  const template =
    models.find(
      (model) => model.shell_type === "unified_exec" && model.supported_in_api !== false,
    ) ?? models[0];
  if (!template) {
    throw new Error("Codex bundled model catalog contained no model template");
  }

  for (const configuredModel of contextModels) {
    for (const slug of configuredModelSlugs(configuredModel)) {
      const existingIndex = models.findIndex((model) => model.slug === slug);
      if (existingIndex >= 0) {
        models[existingIndex] = applyExplicitContextWindow(
          models[existingIndex]!,
          configuredModel.contextWindowMaxTokens,
        );
        continue;
      }
      models.push(
        buildConfiguredFallbackModel({
          template,
          model: configuredModel,
          slug,
        }),
      );
    }
  }

  return { ...rawCatalog, models };
}

async function loadBundledCodexModelCatalog(params: {
  command: string;
  launchArgs: readonly string[];
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
}): Promise<unknown> {
  const cacheKey = JSON.stringify([params.command, ...params.launchArgs]);
  let pending = bundledCatalogPromises.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const envSpec = createProviderEnvSpec({
        runtimeSettings: params.runtimeSettings,
        overlays: [params.launchEnv],
      });
      const { stdout } = await execCommand(
        params.command,
        [...params.launchArgs, "debug", "models", "--bundled"],
        {
          ...envSpec,
          maxBuffer: CODEX_MODEL_CATALOG_MAX_BUFFER_BYTES,
        },
      );
      const serialized = stdout.trim();
      if (!serialized) {
        throw new Error("Codex returned an empty bundled model catalog");
      }
      try {
        return JSON.parse(serialized) as unknown;
      } catch (error) {
        throw new Error("Codex returned invalid JSON for its bundled model catalog", {
          cause: error,
        });
      }
    })();
    bundledCatalogPromises.set(cacheKey, pending);
  }

  try {
    return await pending;
  } catch (error) {
    if (bundledCatalogPromises.get(cacheKey) === pending) {
      bundledCatalogPromises.delete(cacheKey);
    }
    throw new Error(
      "Unable to prepare configured Codex context windows. This Codex build must support `codex debug models --bundled`.",
      { cause: error },
    );
  }
}

export async function resolveCodexModelCatalogConfigOverride(params: {
  command: string;
  launchArgs: readonly string[];
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  configuredModels?: readonly ProviderProfileModel[];
}): Promise<string | null> {
  if (configuredContextModels(params.configuredModels).length === 0) {
    return null;
  }

  const bundledCatalog = await loadBundledCodexModelCatalog(params);
  const augmentedCatalog = augmentCodexModelCatalog(bundledCatalog, params.configuredModels);
  if (!augmentedCatalog) {
    return null;
  }

  const serialized = JSON.stringify(augmentedCatalog);
  const digest = createHash("sha256").update(serialized).digest("hex");
  await fs.mkdir(CODEX_MODEL_CATALOG_CACHE_DIR, { recursive: true });
  const catalogPath = path.join(CODEX_MODEL_CATALOG_CACHE_DIR, `${digest}.json`);
  await fs.writeFile(catalogPath, serialized, { encoding: "utf8", mode: 0o600 });

  // CLI -c values are parsed as TOML. JSON string quoting is valid TOML string
  // syntax and safely preserves spaces and Windows path separators.
  return `model_catalog_json=${JSON.stringify(catalogPath)}`;
}

export function buildCodexAppServerArgs(
  launchArgs: readonly string[],
  modelCatalogConfigOverride: string | null,
  goalsEnabled: boolean,
): string[] {
  const args = [...launchArgs];
  if (modelCatalogConfigOverride) {
    args.push("-c", modelCatalogConfigOverride);
  }
  args.push("app-server");
  if (goalsEnabled) {
    args.push("--enable", "goals");
  }
  return args;
}
