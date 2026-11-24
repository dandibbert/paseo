import type { AgentShellContextSummary } from "@getpaseo/protocol/messages";
import { ChevronRight, Terminal, X } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedTerminal = withUnistyles(Terminal);
const ThemedChevron = withUnistyles(ChevronRight);
const ThemedX = withUnistyles(X);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface PendingShellContextBarProps {
  entries: readonly AgentShellContextSummary[];
  disabled?: boolean;
  onRemoveEntry: (entryId: string) => void;
  onClearAll: () => void;
}

function PendingShellContextEntryRow({
  entry,
  disabled,
  onRemoveEntry,
}: {
  entry: AgentShellContextSummary;
  disabled: boolean;
  onRemoveEntry: (entryId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemoveEntry(entry.id);
  }, [entry.id, onRemoveEntry]);

  return (
    <View style={styles.entryRow} testID={`composer-pending-shell-entry-${entry.id}`}>
      <View style={styles.entryMeta}>
        <Text style={styles.entryCommand} numberOfLines={1}>
          $ {entry.command}
        </Text>
        {entry.exitCode !== null ? (
          <Text style={styles.entryExit}>{t("agentShell.exitCode", { code: entry.exitCode })}</Text>
        ) : null}
      </View>
      <ToolbarButton
        compact
        label={t("agentShell.removeEntryAccessibility", { command: entry.command })}
        onPress={handleRemove}
        disabled={disabled}
        testID={`composer-pending-shell-remove-${entry.id}`}
      >
        <ThemedX size={13} uniProps={mutedIcon} />
      </ToolbarButton>
    </View>
  );
}

export function PendingShellContextBar({
  entries,
  disabled = false,
  onRemoveEntry,
  onClearAll,
}: PendingShellContextBarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <View style={styles.container} testID="composer-pending-shell-context-bar">
      <View style={styles.headerRow}>
        <PressHighlight
          onPress={toggleExpanded}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          {...webExpandedProps}
          style={styles.toggleButton}
          testID="composer-pending-shell-context-toggle"
        >
          <View style={chevronStyle}>
            <ThemedChevron size={14} uniProps={mutedIcon} />
          </View>
          <ThemedTerminal size={14} uniProps={mutedIcon} />
          <Text style={styles.summaryText} numberOfLines={1}>
            {t("agentShell.pendingContextSummary", { count: entries.length })}
          </Text>
        </PressHighlight>
        <Button
          size="sm"
          variant="ghost"
          onPress={onClearAll}
          disabled={disabled}
          accessibilityLabel={t("agentShell.clearAll")}
          testID="composer-pending-shell-context-clear"
        >
          {t("agentShell.clearAll")}
        </Button>
      </View>

      {expanded ? (
        <View style={styles.entryList}>
          {entries.map((entry) => (
            <PendingShellContextEntryRow
              key={entry.id}
              entry={entry}
              disabled={disabled}
              onRemoveEntry={onRemoveEntry}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  toggleButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    paddingVertical: 2,
    minWidth: 0,
  },
  chevron: {},
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  summaryText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  entryList: {
    gap: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  entryMeta: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  entryCommand: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  entryExit: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
