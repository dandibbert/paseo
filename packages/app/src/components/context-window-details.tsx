import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import {
  hasReplacingSessionCostPluginItem,
  PluginContextWindowItems,
  usePluginContextWindowItems,
} from "@/plugins/context-window-items";
import { AgentUsage as AgentAccountUsage } from "@/usage";
import { formatTokenCount } from "./context-window-meter.utils";
import { MetricsList } from "./metrics-list";

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  context: {
    percentage: number;
    usedTokens: number;
    maxTokens: number;
  } | null;
  sessionCost: string | null;
  totalCostUsd?: number | null;
  usage?: AgentUsage | null;
  provider?: string | null;
  model?: string | null;
  /** What the provider reports about the session. A reported cost replaces `sessionCost`. */
  sessionMetrics: AgentMetric[];
  /** The hover card and tooltip title themselves; the sheet's header carries the title instead. */
  showTitle: boolean;
  /** Whether the usage cards have a Refresh button; without one they show their freshness. */
  refreshable: boolean;
}

/**
 * What the context window meter opens: how full the window is, what the provider reports about the
 * session, then the usage of the agent's account. The desktop hover card, the native wide tooltip, and the compact sheet all render it.
 */
export function ContextWindowDetails({
  serverId,
  agentId,
  context,
  sessionCost,
  totalCostUsd = null,
  usage = null,
  provider = null,
  model = null,
  sessionMetrics,
  showTitle,
  refreshable,
}: ContextWindowDetailsProps) {
  const { t } = useTranslation();
  const pluginItems = usePluginContextWindowItems(serverId);
  const hideBuiltInSessionCost = hasReplacingSessionCostPluginItem(pluginItems);
  const providerReportsCost = sessionMetrics.some(
    (metric) => metric.label.toLowerCase() === "cost",
  );
  return (
    <>
      <View style={styles.summary}>
        {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
        {context ? (
          <>
            <Text style={styles.text}>
              {t("contextWindow.used", { percentage: context.percentage })}
            </Text>
            <Text style={styles.detail}>
              {t("contextWindow.tokens", {
                used: formatTokenCount(context.usedTokens),
                max: formatTokenCount(context.maxTokens),
              })}
            </Text>
          </>
        ) : (
          <Text style={styles.detail}>{t("contextWindow.noData")}</Text>
        )}
        {sessionCost && !hideBuiltInSessionCost && !providerReportsCost ? (
          <Text style={styles.detail}>{t("contextWindow.sessionCost", { cost: sessionCost })}</Text>
        ) : null}
        <PluginContextWindowItems
          targets={pluginItems}
          agentId={agentId}
          model={model}
          provider={provider}
          usedTokens={context?.usedTokens ?? null}
          maxTokens={context?.maxTokens ?? null}
          totalCostUsd={totalCostUsd}
          usage={usage}
        />
      </View>
      {sessionMetrics.length > 0 ? <MetricsList metrics={sessionMetrics} /> : null}
      <AgentAccountUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
