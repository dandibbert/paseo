import { View, Text, RefreshControl, FlatList, type ListRenderItem } from "react-native";
import { useCallback, useMemo, type ReactElement } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Archive } from "lucide-react-native";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProviderIcon } from "@/components/provider-icons";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  AgentHistoryActions,
  type AgentHistoryOpenTarget,
} from "@/components/agent-history-actions";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { StatusBadge } from "@/components/ui/status-badge";
import type { MenuTriggerState } from "@/components/ui/menu";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Theme } from "@/styles/theme";

interface AgentListProps {
  agents: AggregatedAgent[];
  showCheckoutInfo?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  showAttentionIndicator?: boolean;
  showHostColumn?: boolean;
  search?: string;
}

type DateSectionKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

const DATE_SECTION_ORDER = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
] as const satisfies readonly DateSectionKey[];

type FlatListItem =
  | { type: "header"; key: string; section: DateSectionKey }
  | { type: "agent"; key: string; agent: AggregatedAgent };

const EMPTY_CHILDREN: readonly AggregatedAgent[] = [];
const mutedIconMapping = (theme: Theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
});
const refreshMapping = (theme: Theme) => ({
  tintColor: theme.colors.foregroundMuted,
  colors: [theme.colors.foregroundMuted],
});
const ThemedArchive = withUnistyles(Archive);
const ThemedRefreshControl = withUnistyles(RefreshControl);

function SessionProviderIcon({
  provider,
  serverId,
  size = 16,
  color = "",
}: {
  provider: string;
  serverId: string;
  size?: number;
  color?: string;
}) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={size} color={color} />;
}
const ThemedProviderIcon = withUnistyles(SessionProviderIcon);

function deriveDateSectionKey(lastActivityAt: Date): DateSectionKey {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const activityStart = new Date(
    lastActivityAt.getFullYear(),
    lastActivityAt.getMonth(),
    lastActivityAt.getDate(),
  );

  if (activityStart.getTime() >= todayStart.getTime()) {
    return "today";
  }
  if (activityStart.getTime() >= yesterdayStart.getTime()) {
    return "yesterday";
  }

  const diffTime = todayStart.getTime() - activityStart.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) {
    return "thisWeek";
  }
  if (diffDays <= 30) {
    return "thisMonth";
  }
  return "older";
}

function formatDateSectionLabel(t: TFunction, section: DateSectionKey): string {
  switch (section) {
    case "today":
      return t("agentList.dateSections.today");
    case "yesterday":
      return t("agentList.dateSections.yesterday");
    case "thisWeek":
      return t("agentList.dateSections.thisWeek");
    case "thisMonth":
      return t("agentList.dateSections.thisMonth");
    case "older":
      return t("agentList.dateSections.older");
  }
}

function SessionRowBadges({
  agent,
  showAttentionIndicator,
}: {
  agent: AggregatedAgent;
  showAttentionIndicator: boolean;
}) {
  const { t } = useTranslation();
  const archivedIcon = useMemo(() => <ThemedArchive uniProps={mutedIconMapping} />, []);
  const pendingCount = agent.pendingPermissionCount ?? 0;
  const showAttention = showAttentionIndicator && agent.requiresAttention;
  return (
    <>
      {agent.archivedAt ? (
        <StatusBadge label={t("agentList.badges.archived")} leading={archivedIcon} />
      ) : null}
      {!agent.archivedAt && agent.status !== "idle" ? (
        <StatusBadge
          label={t(`agentList.status.${agent.status}`)}
          variant={agent.status === "error" ? "error" : "muted"}
        />
      ) : null}
      {pendingCount > 0 ? (
        <StatusBadge
          label={t("agentList.badges.pending", { count: pendingCount })}
          variant="warning"
        />
      ) : null}
      {showAttention ? (
        <StatusBadge label={t("agentList.badges.attention")} variant="error" />
      ) : null}
    </>
  );
}

function SessionRow({
  agent,
  knownChildren,
  search,
  selectedAgentId,
  showAttentionIndicator,
  showHostColumn,
  onPress,
}: {
  agent: AggregatedAgent;
  search?: string;
  selectedAgentId?: string;
  showAttentionIndicator: boolean;
  showHostColumn: boolean;
  knownChildren: readonly AggregatedAgent[];
  onPress: (agent: AgentHistoryOpenTarget) => void;
}) {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo(agent.lastActivityAt);
  const agentKey = `${agent.serverId}:${agent.id}`;
  const rowSuffix = `${agent.serverId}-${agent.id}`;
  const isSelected = selectedAgentId === agentKey;
  const projectName = agent.projectPlacement?.projectName ?? "";
  const branch = agent.projectPlacement?.checkout.currentBranch ?? "";
  const workspaceName = agent.projectPlacement?.workspaceName ?? agent.cwd;
  const parentAgentId = getParentAgentIdFromLabels(agent.labels);
  const roleLabel = parentAgentId
    ? t("agentList.badges.subagent", { parent: parentAgentId.slice(0, 7) })
    : t("agentList.badges.rootAgent");
  const ranges = useMemo(
    () => ({
      workspace: findHighlightRanges(search ?? "", workspaceName),
      title: findHighlightRanges(search ?? "", agent.title ?? ""),
      branch: findHighlightRanges(search ?? "", branch),
      project: findHighlightRanges(search ?? "", projectName),
    }),
    [search, workspaceName, agent.title, branch, projectName],
  );
  const pressableStyle = useCallback(
    ({ pressed, hovered, open }: MenuTriggerState) => [
      styles.row,
      isSelected && styles.rowSelected,
      (hovered || open) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isSelected],
  );

  return (
    <AgentHistoryActions
      agent={agent}
      knownChildren={knownChildren}
      onOpen={onPress}
      style={pressableStyle}
      testID={`agent-row-${rowSuffix}`}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowTitleRow}>
          <View style={styles.providerIconWrap}>
            <ThemedProviderIcon
              provider={agent.provider}
              serverId={agent.serverId}
              uniProps={mutedIconMapping}
            />
          </View>
          <HighlightedText
            text={agent.title || t("agentList.fallbackTitle")}
            ranges={ranges.title}
            style={styles.sessionTitle}
            numberOfLines={1}
            testID={`agent-row-title-${rowSuffix}`}
          />
          <View style={styles.rowTrailing} testID={`agent-row-trailing-${rowSuffix}`}>
            <Text style={styles.timeText} numberOfLines={1}>
              {timeAgo}
            </Text>
          </View>
        </View>
        <View style={styles.rowMetaRow} testID={`agent-row-metadata-${rowSuffix}`}>
          <View style={styles.role} testID={`agent-row-role-${rowSuffix}`}>
            <Text style={styles.roleText} numberOfLines={1}>
              {roleLabel}
            </Text>
          </View>
          <HighlightedText
            text={workspaceName}
            ranges={ranges.workspace}
            style={styles.workspaceText}
            numberOfLines={1}
            testID={`agent-row-workspace-${rowSuffix}`}
          />
          {projectName ? (
            <HighlightedText
              text={projectName}
              ranges={ranges.project}
              style={styles.metaText}
              numberOfLines={1}
              testID={`agent-row-project-${rowSuffix}`}
            />
          ) : null}
          {branch ? (
            <HighlightedText
              text={branch}
              ranges={ranges.branch}
              style={styles.metaText}
              numberOfLines={1}
              testID={`agent-row-branch-${rowSuffix}`}
            />
          ) : null}
          {showHostColumn && agent.serverLabel ? (
            <Text style={styles.metaText} numberOfLines={1}>
              {agent.serverLabel}
            </Text>
          ) : null}
          <SessionRowBadges agent={agent} showAttentionIndicator={showAttentionIndicator} />
        </View>
      </View>
    </AgentHistoryActions>
  );
}

export function AgentList({
  agents,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
  showAttentionIndicator = true,
  showHostColumn = false,
  search,
}: AgentListProps) {
  const { t } = useTranslation();
  const handleAgentPress = useCallback(
    (agent: AgentHistoryOpenTarget) => {
      onAgentSelect?.();
      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        pin: true,
      });
    },
    [onAgentSelect],
  );

  const childrenByParent = useMemo(() => {
    const index = new Map<string, AggregatedAgent[]>();
    for (const agent of agents) {
      const parentId = getParentAgentIdFromLabels(agent.labels);
      if (!parentId) continue;
      const parentKey = `${agent.serverId}:${parentId}`;
      const children = index.get(parentKey) ?? [];
      children.push(agent);
      index.set(parentKey, children);
    }
    return index;
  }, [agents]);

  const flatItems = useMemo((): FlatListItem[] => {
    const buckets = new Map<DateSectionKey, AggregatedAgent[]>();
    for (const agent of agents) {
      const section = deriveDateSectionKey(agent.lastActivityAt);
      const existing = buckets.get(section) ?? [];
      existing.push(agent);
      buckets.set(section, existing);
    }
    const result: FlatListItem[] = [];
    for (const section of DATE_SECTION_ORDER) {
      const data = buckets.get(section);
      if (!data || data.length === 0) continue;
      result.push({ type: "header", key: `header:${section}`, section });
      for (const agent of data)
        result.push({ type: "agent", key: `${agent.serverId}:${agent.id}`, agent });
    }
    return result;
  }, [agents]);

  const renderItem: ListRenderItem<FlatListItem> = useCallback(
    ({ item }) => {
      if (item.type === "header")
        return (
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{formatDateSectionLabel(t, item.section)}</Text>
          </View>
        );
      return (
        <SessionRow
          agent={item.agent}
          knownChildren={childrenByParent.get(item.key) ?? EMPTY_CHILDREN}
          search={search}
          selectedAgentId={selectedAgentId}
          showAttentionIndicator={showAttentionIndicator}
          showHostColumn={showHostColumn}
          onPress={handleAgentPress}
        />
      );
    },
    [
      childrenByParent,
      handleAgentPress,
      search,
      selectedAgentId,
      showAttentionIndicator,
      showHostColumn,
      t,
    ],
  );
  const keyExtractor = useCallback((item: FlatListItem) => item.key, []);
  const refreshControl = useMemo(
    () =>
      onRefresh ? (
        <ThemedRefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          uniProps={refreshMapping}
        />
      ) : undefined,
    [onRefresh, isRefreshing],
  );
  return (
    <FlatList
      data={flatItems}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      ListFooterComponent={listFooterComponent}
      refreshControl={refreshControl}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[1],
  },
  sectionHeading: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flex: 1,
    minWidth: 0,
    minHeight: 64,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowContent: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minWidth: 0 },
  providerIconWrap: { flexShrink: 0 },
  sessionTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  rowTrailing: { flexShrink: 0, marginLeft: theme.spacing[2] },
  timeText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    minWidth: 0,
  },
  role: { maxWidth: "100%", flexShrink: 0 },
  roleText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  workspaceText: {
    maxWidth: 280,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metaText: {
    maxWidth: 180,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowSelected: { backgroundColor: theme.colors.surface2 },
  rowHovered: { backgroundColor: theme.colors.surface1 },
  rowPressed: { backgroundColor: theme.colors.surface2 },
}));
