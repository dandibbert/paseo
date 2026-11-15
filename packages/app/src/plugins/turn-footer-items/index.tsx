import type { AgentTurnTelemetry } from "@getpaseo/protocol/agent-types";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginTurnFooterItemContribution,
  PluginTurnFooterItemProps,
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin } from "../types";

interface TurnFooterItemTarget {
  plugin: InstalledPlugin;
  item: PluginTurnFooterItemContribution;
}

export function usePluginTurnFooterItems(serverId: string | null): TurnFooterItemTarget[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      serverId
        ? installed
            .filter((plugin) => plugin.serverId === serverId)
            .flatMap((plugin) => plugin.turnFooterItems.map((item) => ({ plugin, item })))
        : [],
    [installed, serverId],
  );
}

export function PluginTurnFooterItems({
  targets,
  agentId,
  turnId,
  model,
  provider,
  completedAt,
  durationMs,
  telemetry,
}: {
  targets: readonly TurnFooterItemTarget[];
  agentId: string;
  turnId: string | null;
  model: string | null;
  provider: string | null;
  completedAt: Date | null;
  durationMs: number | null;
  telemetry: AgentTurnTelemetry | null;
}) {
  if (targets.length === 0) return null;
  return targets.map((target) => (
    <ThemedTurnFooterItemHost
      key={`${target.plugin.id}:${target.item.id}`}
      target={target}
      agentId={agentId}
      turnId={turnId}
      model={model}
      provider={provider}
      completedAt={completedAt}
      durationMs={durationMs}
      telemetry={telemetry}
      uniProps={pluginThemeMapping}
    />
  ));
}

function TurnFooterItemHost({
  target: { plugin, item },
  agentId,
  turnId,
  model,
  provider,
  completedAt,
  durationMs,
  telemetry,
  theme,
}: {
  target: TurnFooterItemTarget;
  agentId: string;
  turnId: string | null;
  model: string | null;
  provider: string | null;
  completedAt: Date | null;
  durationMs: number | null;
  telemetry: AgentTurnTelemetry | null;
  theme: PluginTheme;
}) {
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const props = useMemo<PluginTurnFooterItemProps>(
    () => ({
      ...hostProps,
      agentId,
      turnId,
      model,
      provider,
      completedAt,
      durationMs,
      telemetry,
    }),
    [agentId, completedAt, durationMs, hostProps, model, provider, telemetry, turnId],
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

const ThemedTurnFooterItemHost = withUnistyles(TurnFooterItemHost);
