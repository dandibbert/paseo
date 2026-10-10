import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import { createProviderEnv, type ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { findClaudeModel, resolveConfiguredClaudeModel } from "./models.js";

export class ClaudeModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeModelCatalogError";
  }
}

export interface ClaudeCatalogConfiguration {
  configDir: string;
  env: NodeJS.ProcessEnv;
  settings: z.infer<typeof settingsSchema>;
  api: { url: string; headers: Record<string, string> } | null;
  cacheKey: string;
}

interface ClaudeCatalogConfigurationOptions {
  baseEnv: NodeJS.ProcessEnv;
  runtimeSettings?: ProviderRuntimeSettings;
  configDir?: string;
}

const settingsSchema = z.object({
  model: z.unknown().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});
const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().trim().min(1),
      display_name: z.string().optional(),
      name: z.string().optional(),
      max_input_tokens: z.number().int().positive().nullish(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

async function readCatalogSettings(configDir: string): Promise<z.infer<typeof settingsSchema>> {
  let settings: z.infer<typeof settingsSchema> = {};
  try {
    const raw = await readFile(join(configDir, "settings.json"), "utf8");
    settings = settingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      // Parser errors can include credential-bearing source text.
      throw new ClaudeModelCatalogError(
        "Cannot read Claude settings.json for model discovery. Check that it contains valid JSON.",
      );
    }
  }
  return settings;
}

function resolveCatalogApi(env: NodeJS.ProcessEnv): NonNullable<ClaudeCatalogConfiguration["api"]> {
  let url: URL;
  try {
    url = new URL(env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid endpoint");
    }
  } catch {
    throw new ClaudeModelCatalogError(
      "Claude model discovery requires an HTTP(S) base URL without credentials, query parameters, or a fragment.",
    );
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix.endsWith("/v1") ? prefix : `${prefix}/v1`}/models`;
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    accept: "application/json",
  };
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon <= 0)
      throw new ClaudeModelCatalogError("Invalid ANTHROPIC_CUSTOM_HEADERS for model discovery.");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN.trim()}`;
  } else if (env.ANTHROPIC_API_KEY?.trim()) {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY.trim();
  }
  return { url: url.toString(), headers };
}

export function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized.length > 0 &&
    !["0", "false", "no", "off"].includes(normalized)
  );
}

export async function resolveClaudeCatalogConfiguration(
  options: ClaudeCatalogConfigurationOptions,
): Promise<ClaudeCatalogConfiguration> {
  const env = createProviderEnv(options);
  const configDir = options.configDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const settings = await readCatalogSettings(configDir);
  // Claude Code applies settings env after the SDK's launch environment.
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  const usesCloudTransport = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((key) => isTruthyEnvValue(env[key]));
  const configuredApi = !!(
    env.ANTHROPIC_BASE_URL?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_AUTH_TOKEN?.trim()
  );
  let api: ClaudeCatalogConfiguration["api"] = null;
  if (configuredApi && !usesCloudTransport) {
    api = resolveCatalogApi(env);
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ configDir, settings, api, usesCloudTransport }))
    .digest("hex");
  return { configDir, env, settings, api, cacheKey: `claude:host:${fingerprint}` };
}

export interface ClaudeModelCatalogTransport {
  fetch: typeof fetch;
}

export const claudeModelCatalogTransport: ClaudeModelCatalogTransport = {
  fetch: (...args) => fetch(...args),
};

interface FetchClaudeApiModelsOptions {
  configuration: ClaudeCatalogConfiguration;
  transport?: ClaudeModelCatalogTransport;
  signal?: AbortSignal;
}

interface FetchCatalogPageOptions {
  url: string;
  headers: Record<string, string>;
  transport: ClaudeModelCatalogTransport;
  signal: AbortSignal;
}

async function fetchCatalogPage({
  url,
  headers,
  transport,
  signal,
}: FetchCatalogPageOptions): Promise<z.infer<typeof pageSchema>> {
  let response: Response;
  try {
    response = await transport.fetch(url, {
      headers,
      signal,
      redirect: "error",
    });
  } catch {
    throw new ClaudeModelCatalogError(
      signal.aborted
        ? "Claude model discovery was canceled or timed out. No model changes were applied."
        : "Could not reach the configured Claude models API. Check the endpoint and connection; redirects are not followed.",
    );
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new ClaudeModelCatalogError(
        `The configured Claude endpoint does not support model discovery (HTTP ${response.status}). No built-in models were substituted.`,
      );
    }
    throw new ClaudeModelCatalogError(
      `Claude model discovery failed (HTTP ${response.status}). Check the configured API credentials and endpoint.`,
    );
  }
  let page: z.infer<typeof pageSchema>;
  try {
    page = pageSchema.parse(await response.json());
  } catch {
    throw new ClaudeModelCatalogError(
      "The configured Claude models API returned an invalid model catalog. No model changes were applied.",
    );
  }
  return page;
}

export async function fetchClaudeApiModels({
  configuration,
  transport = claudeModelCatalogTransport,
  signal,
}: FetchClaudeApiModelsOptions): Promise<AgentModelDefinition[]> {
  if (!configuration.api)
    throw new ClaudeModelCatalogError("Claude API model discovery is not configured.");
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models = new Map<string, AgentModelDefinition>();
  const cursors = new Set<string>();
  const url = new URL(configuration.api.url);
  while (true) {
    const page = await fetchCatalogPage({
      url: url.toString(),
      headers: configuration.api.headers,
      transport,
      signal: requestSignal,
    });
    for (const row of page.data) {
      if (models.has(row.id)) continue;
      const manifest = findClaudeModel(row.id);
      const model = resolveConfiguredClaudeModel({
        ...manifest,
        provider: "claude",
        id: row.id,
        label: row.display_name?.trim() || row.name?.trim() || row.id,
        description: "From configured Claude models API",
        isSelectable: true,
        isDefault: false,
        ...(row.max_input_tokens ? { contextWindowMaxTokens: row.max_input_tokens } : {}),
      });
      models.set(row.id, model);
    }
    if (!page.has_more) return [...models.values()];
    if (
      !page.last_id ||
      cursors.has(page.last_id) ||
      page.data.length === 0 ||
      cursors.size >= 1000
    ) {
      throw new ClaudeModelCatalogError(
        "The configured Claude models API returned invalid pagination. No model changes were applied.",
      );
    }
    cursors.add(page.last_id);
    url.searchParams.set("after_id", page.last_id);
  }
}
