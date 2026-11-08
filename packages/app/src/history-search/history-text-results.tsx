import { useCallback, useMemo, type ReactElement } from "react";
import { FlatList, Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isNative } from "@/constants/platform";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import type { Theme } from "@/styles/theme";
import type { HistoryTextResult } from "./merge";
import { requestChatJump } from "./pending-jump";
import type { HistoryTextSearch } from "./use-history-text-search";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinner = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function snippetRanges(snippet: string, query: string) {
  const index = snippet.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return index === -1 ? undefined : [{ start: index, length: query.length }];
}

function keyOf(item: HistoryTextResult): string {
  return `${item.serverId}:${item.agentId}`;
}

function ResultRow({
  result,
  query,
  onOpen,
}: {
  result: HistoryTextResult;
  query: string;
  onOpen: (result: HistoryTextResult) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpen(result), [onOpen, result]);
  const ranges = useMemo(() => snippetRanges(result.snippet, query), [query, result.snippet]);
  const folder =
    result.cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || result.cwd;
  const more = result.agentMatchCount - 1;
  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.row}
      highlightStyle={styles.rowPressed}
      testID={`history-text-result-${result.agentId}`}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.title} numberOfLines={1}>
          {result.title || t("historyTextSearch.untitled")}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatTimeAgo(new Date(result.updatedAt))}
        </Text>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {`${result.serverLabel} · ${folder} · ${
          result.role === "user" ? t("historyTextSearch.you") : t("historyTextSearch.agent")
        }`}
      </Text>
      <HighlightedText
        text={result.snippet}
        ranges={ranges}
        style={styles.snippet}
        numberOfLines={3}
      />
      {more > 0 ? (
        <Text style={styles.meta}>{t("historyTextSearch.moreInChat", { count: more })}</Text>
      ) : null}
    </PressHighlight>
  );
}

/** Matches in message text, one row per chat; pressing one opens the chat at that message. */
export function HistoryTextResults({
  search,
  query,
}: {
  search: HistoryTextSearch;
  query: string;
}): ReactElement {
  const { t } = useTranslation();
  const handleOpen = useCallback(
    (result: HistoryTextResult) => {
      requestChatJump({
        serverId: result.serverId,
        agentId: result.agentId,
        query,
        seq: result.seq,
      });
      navigateToAgent({
        serverId: result.serverId,
        agentId: result.agentId,
        workspaceId: result.workspaceId,
        pin: true,
      });
    },
    [query],
  );
  const renderItem = useCallback(
    ({ item }: { item: HistoryTextResult }) => (
      <ResultRow result={item} query={query} onOpen={handleOpen} />
    ),
    [handleOpen, query],
  );
  const unsearched = search.unsearchedHosts.join(", ");
  const header = useMemo(
    () => (
      <View style={styles.notes}>
        <Text style={styles.note}>{t("historyTextSearch.coverage")}</Text>
        {isNative ? <Text style={styles.note}>{t("historyTextSearch.nativeJump")}</Text> : null}
        {unsearched ? (
          <Text style={styles.warning}>
            {t("historyTextSearch.unsearchedHosts", { hosts: unsearched })}
          </Text>
        ) : null}
      </View>
    ),
    [t, unsearched],
  );
  const empty = useMemo(
    () => <Text style={[styles.note, styles.empty]}>{t("historyTextSearch.noMatches")}</Text>,
    [t],
  );
  const footer = useMemo(
    () =>
      search.truncated ? <Text style={styles.note}>{t("sessions.tooManyMatches")}</Text> : null,
    [search.truncated, t],
  );
  if (search.isLoading) {
    return (
      <View style={styles.center}>
        <ThemedLoadingSpinner size="large" uniProps={mutedSpinner} />
      </View>
    );
  }
  return (
    <FlatList
      data={search.results}
      keyExtractor={keyOf}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={styles.list}
      testID="history-text-results"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  notes: { gap: theme.spacing[1], paddingBottom: theme.spacing[2] },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  empty: { textAlign: "center", paddingVertical: theme.spacing[6] },
  row: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  rowPressed: { backgroundColor: theme.colors.surface1 },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  snippet: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
