import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginContextWindowItemContribution,
  PluginContextWindowItemProps,
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin } from "../types";

interface ContextWindowItemTarget {
  plugin: InstalledPlugin;
  item: PluginContextWindowItemContribution;
}

export function usePluginContextWindowItems(serverId: string | null): ContextWindowItemTarget[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      serverId
        ? installed
            .filter((plugin) => plugin.serverId === serverId)
            .flatMap((plugin) => plugin.contextWindowItems.map((item) => ({ plugin, item })))
        : [],
    [installed, serverId],
  );
}

export function hasReplacingSessionCostPluginItem(
  targets: readonly ContextWindowItemTarget[],
): boolean {
  return targets.some(({ item }) => item.replacesSessionCost === true);
}

export function PluginContextWindowItems({
  targets,
  agentId,
  model,
  provider,
  usedTokens,
  maxTokens,
  totalCostUsd,
  usage,
}: {
  targets: readonly ContextWindowItemTarget[];
  agentId: string;
  model: string | null;
  provider: string | null;
  usedTokens: number | null;
  maxTokens: number | null;
  totalCostUsd: number | null;
  usage: AgentUsage | null;
}) {
  if (targets.length === 0) return null;
  return targets.map((target) => (
    <ThemedContextWindowItemHost
      key={`${target.plugin.id}:${target.item.id}`}
      target={target}
      agentId={agentId}
      model={model}
      provider={provider}
      usedTokens={usedTokens}
      maxTokens={maxTokens}
      totalCostUsd={totalCostUsd}
      usage={usage}
      uniProps={pluginThemeMapping}
    />
  ));
}

function ContextWindowItemHost({
  target: { plugin, item },
  agentId,
  model,
  provider,
  usedTokens,
  maxTokens,
  totalCostUsd,
  usage,
  theme,
}: {
  target: ContextWindowItemTarget;
  agentId: string;
  model: string | null;
  provider: string | null;
  usedTokens: number | null;
  maxTokens: number | null;
  totalCostUsd: number | null;
  usage: AgentUsage | null;
  theme: PluginTheme;
}) {
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const props = useMemo<PluginContextWindowItemProps>(
    () => ({
      ...hostProps,
      agentId,
      model,
      provider,
      usedTokens,
      maxTokens,
      totalCostUsd,
      usage,
    }),
    [agentId, hostProps, maxTokens, model, provider, totalCostUsd, usage, usedTokens],
  );
  const Item = item.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Item} renderError={renderNothing}>
      <PluginEnvironmentProvider environment={environment}>
        <Item {...props} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedContextWindowItemHost = withUnistyles(ContextWindowItemHost);
