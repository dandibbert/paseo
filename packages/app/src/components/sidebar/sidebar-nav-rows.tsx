import { router, usePathname } from "expo-router";
import { CalendarClock, History, Plus, Search, UserRound } from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import { HostBadge } from "@/hosts/host-badge";
import type { HostBadgeModel } from "@/hosts/appearance";
import { useHostBadges } from "@/hosts/use-host-badges";
import { StatusRing } from "@/components/status-ring";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import { derivePersonalSpaceStatus } from "@/sidebar-nav/personal-status";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useToast } from "@/contexts/toast-api-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useWorkspace, useWorkspaceFields } from "@/stores/session-store-hooks";
import {
  buildHostWorkspaceRoute,
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/** The top-level items the user keeps visible, in display order. */
export function useVisibleSidebarNavItems() {
  const { items } = useSidebarNavItems("header");
  return useMemo(() => items.filter((item) => item.visible), [items]);
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden and there is no `firstRowTrailing`.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const visibleItems = useVisibleSidebarNavItems();
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const [firstRow, ...restRows] = visibleItems.map((item) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
  });

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

/**
 * Opens a host's personal space, creating it on first use. Every host that supports it gets its
 * own row, and with more than one host each row carries that host's badge, named, so a message
 * never goes to the wrong machine. The personal space is not listed among the projects.
 */
function SidebarPersonalRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportByServerId = useHostFeatureMap(serverIds, "personalSpace");
  const supportedServerIds = useMemo(
    () => serverIds.filter((serverId) => supportByServerId.get(serverId) === true),
    [serverIds, supportByServerId],
  );
  const badges = useHostBadges({ enabled: serverIds.length > 1, alwaysNamed: true });

  return (
    <>
      {supportedServerIds.map((serverId) => (
        <SidebarPersonalHostRow
          key={serverId}
          serverId={serverId}
          badge={badges.get(serverId) ?? null}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
    </>
  );
}

function SidebarPersonalHostRow({
  serverId,
  badge,
  onBeforeNavigate,
}: SidebarNavRowProps & { serverId: string; badge: HostBadgeModel | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeServerId = activeWorkspaceSelection?.serverId ?? null;
  const isActive =
    useWorkspaceFields(
      activeServerId === serverId ? serverId : null,
      activeServerId === serverId ? (activeWorkspaceSelection?.workspaceId ?? null) : null,
      (workspace) => workspace.personal === true,
    ) ?? false;
  const label = t(builtinSidebarNavLabelKey("personal"));
  const statusBucket = usePersonalSpaceStatusBucket(serverId);
  const handlePress = useCallback(async () => {
    if (!client) return;
    onBeforeNavigate?.();
    try {
      const result = await client.ensurePersonalSpace();
      if (result.workspace) router.push(buildHostWorkspaceRoute(serverId, result.workspace.id));
      else toast.error(result.error ?? label);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [client, label, onBeforeNavigate, serverId, toast]);

  const trailing = useMemo(
    () =>
      badge || statusBucket !== "done" ? (
        <View style={styles.personalTrailing}>
          <PersonalStatusIndicator bucket={statusBucket} />
          {badge ? <HostBadge badge={badge} /> : null}
        </View>
      ) : undefined,
    [badge, statusBucket],
  );

  return (
    <SidebarHeaderRow
      icon={UserRound}
      label={label}
      accessibilityLabel={badge ? `${label} · ${badge.label}` : label}
      onPress={handlePress}
      isActive={isActive}
      testID={`sidebar-personal-${serverId}`}
      variant="compact"
      trailing={trailing}
    />
  );
}

/**
 * Most urgent status across the host's personal project. Agents started in the personal folder
 * without naming the workspace used to get workspaces of their own in that project, and those are
 * hidden from the project list, so all of them count here.
 */
function usePersonalSpaceStatusBucket(serverId: string): SidebarStateBucket {
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);
  return useSessionStore((state) =>
    derivePersonalSpaceStatus({
      serverId,
      session: state.sessions[serverId],
      pendingCreateAttempts,
    }),
  );
}

function PersonalStatusIndicator({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.personalStatus} testID="sidebar-personal-status-running">
        <StatusRing />
      </View>
    );
  }
  const dotStyle = PERSONAL_STATUS_DOT_STYLE[bucket];
  if (!dotStyle) return null;
  return (
    <View style={styles.personalStatus} testID={`sidebar-personal-status-${bucket}`}>
      <View style={[styles.personalStatusDot, styles[dotStyle]]} />
    </View>
  );
}

const PERSONAL_STATUS_DOT_STYLE: Record<
  SidebarStateBucket,
  "dotNeedsInput" | "dotFailed" | "dotAttention" | null
> = {
  needs_input: "dotNeedsInput",
  failed: "dotFailed",
  attention: "dotAttention",
  running: null,
  done: null,
};

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow() {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  personal: SidebarPersonalRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  personalTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  personalStatus: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  personalStatusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  dotNeedsInput: { backgroundColor: theme.colors.statusDotWarning },
  dotFailed: { backgroundColor: theme.colors.statusDotDanger },
  dotAttention: { backgroundColor: theme.colors.statusDotSuccess },
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
}));
