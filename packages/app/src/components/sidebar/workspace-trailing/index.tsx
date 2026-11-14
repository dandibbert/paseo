import { Timer } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { DensityIcon } from "@/components/ui/density-icon";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";

export type { SidebarWorkspaceTrailing };

/**
 * The slot to the right of a workspace title. Renderers behind one preference, so
 * every row renderer asks the same question and the kebab overlay geometry stays identical
 * no matter which one is showing.
 *
 * "none" exists because the slot is the only thing competing with the title for width, and
 * a user who never reads the diff would rather have the characters.
 */
export function useSidebarWorkspaceTrailing(): SidebarWorkspaceTrailing {
  const {
    settings: { sidebarWorkspaceTrailing },
  } = useAppSettings();
  return sidebarWorkspaceTrailing;
}

/** Whether the slot has anything to draw for this workspace under the current preference. */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  if (trailing === "both") return workspace.diffStat !== null || workspace.statusEnteredAt !== null;
  if (trailing === "diff") return workspace.diffStat !== null;
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return false;
}

export function SidebarWorkspaceTrailingContent({
  workspace,
  trailing,
  backdrop,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
  backdrop: SidebarSurfaceBackdrop;
}) {
  if (trailing === "both")
    return (
      <View style={styles.both}>
        <SidebarWorkspaceTrailingContent
          workspace={workspace}
          trailing="diff"
          backdrop={backdrop}
        />
        <SidebarWorkspaceTrailingContent
          workspace={workspace}
          trailing="timestamp"
          backdrop={backdrop}
        />
      </View>
    );
  if (trailing === "diff" && workspace.diffStat) {
    return (
      <DiffStat additions={workspace.diffStat.additions} deletions={workspace.diffStat.deletions} />
    );
  }
  if (trailing === "timestamp" && workspace.statusEnteredAt) {
    return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} backdrop={backdrop} />;
  }
  return null;
}

/**
 * Its own component so the clock stops here. `useCompactTimeAgo` holds state, and state
 * re-renders the component that owns it — keeping that component down to a single `<Text>` is
 * what stops a minute tick from reaching the row, the list, or the diff stat next door.
 */
function WorkspaceTimestamp({
  enteredAt,
  backdrop,
}: {
  enteredAt: Date;
  backdrop: SidebarSurfaceBackdrop;
}) {
  const label = useCompactTimeAgo(enteredAt);
  const { t } = useTranslation();
  return (
    <View
      style={styles.both}
      accessibilityLabel={`${t("sidebar.display.show.timestamp")}: ${label}`}
    >
      <DensityIcon icon={Timer} size="xs" color="foregroundMuted" />
      <Text
        style={[
          styles.timestamp,
          backdrop === "surfaceSidebarHover" && styles.hovered,
          backdrop === "surfaceSidebarSelected" && styles.selected,
        ]}
        numberOfLines={1}
        testID="sidebar-workspace-timestamp"
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  both: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  // A step below the project title it shares the row with. The timestamp is the one thing here
  // you never came looking for, so it sits at the bottom of the muted ramp rather than tying
  // with the label naming the group.
  timestamp: {
    height: 20,
    lineHeight: 20,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
  hovered: { color: theme.colors.foregroundSidebarHover },
  selected: { color: theme.colors.foregroundSidebarSelected },
}));
