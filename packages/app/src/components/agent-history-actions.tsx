import {
  useCallback,
  useReducer,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { MoreHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "@/hooks/agent-history-query-key";
import { applyArchivedAgentCloseResults, isAgentArchiving } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import * as Clipboard from "expo-clipboard";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { Button } from "@/components/ui/button";
import type { MenuTriggerState } from "@/components/ui/menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  canStopHistoryAgent,
  mergeAgentHistoryChildren,
  runAgentHistoryMutation,
  type AgentHistoryMutation,
} from "./agent-history-actions-model";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export interface AgentHistoryOpenTarget {
  serverId: string;
  id: string;
  workspaceId?: string | null;
}

interface AgentHistoryActionsProps {
  agent: AggregatedAgent;
  children: ReactNode;
  knownChildren?: readonly AggregatedAgent[];
  onOpen: (agent: AgentHistoryOpenTarget) => void;
  style?: ComponentProps<typeof ContextMenuTrigger>["style"];
  testID?: string;
}

type Operation = AgentHistoryMutation | "copy-id";
interface ActionState {
  renaming: boolean;
  pending: Operation | null;
  error: string | null;
  copied: boolean;
}
type ActionEvent =
  | { type: "rename" | "close-rename" | "dismiss-error" }
  | { type: "start"; operation: Operation }
  | { type: "finish"; copied?: boolean }
  | { type: "fail"; error: string };
const INITIAL_STATE: ActionState = { renaming: false, pending: null, error: null, copied: false };
function actionReducer(state: ActionState, event: ActionEvent): ActionState {
  switch (event.type) {
    case "rename":
      return { ...state, renaming: true, error: null };
    case "close-rename":
      return { ...state, renaming: false };
    case "dismiss-error":
      return { ...state, error: null };
    case "start":
      return { ...state, pending: event.operation, error: null, copied: false };
    case "finish":
      return { ...state, pending: null, copied: event.copied ?? false };
    case "fail":
      return { ...state, pending: null, error: event.error };
  }
}

/** Both triggers share one controller; neither long press nor right click mutates an agent. */
export function AgentHistoryActions({
  agent,
  children,
  knownChildren,
  onOpen,
  style,
  testID,
}: AgentHistoryActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<"context" | "dropdown" | null>(null);
  const [state, dispatch] = useReducer(actionReducer, INITIAL_STATE);
  const operationRef = useRef(false);
  const key = `${agent.serverId}-${agent.id}`;

  const invalidateHistory = useCallback(() => {
    for (const queryKey of [
      agentHistoryQueryKey(agent.serverId),
      allAgentHistoryQueryRootKey(),
      ["sidebarAgentsList", agent.serverId],
      ["allAgents", agent.serverId],
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [agent.serverId, queryClient]);

  const mutate = useCallback(
    async (action: AgentHistoryMutation, name?: string): Promise<void> => {
      if (
        operationRef.current ||
        isAgentArchiving({ queryClient, serverId: agent.serverId, agentId: agent.id })
      )
        return;
      operationRef.current = true;
      dispatch({ type: "start", operation: action });
      try {
        if (action === "stop" || action === "archive" || action === "detach") {
          const confirmed = await confirmDialog({
            title: t(`agentList.actions.${action}Title`),
            message: t(`agentList.actions.${action}Message`, {
              title: agent.title || t("agentList.fallbackTitle"),
            }),
            confirmLabel: t(`agentList.actions.${action}`),
            cancelLabel: t("common.actions.cancel"),
            destructive: action !== "detach",
          });
          if (!confirmed) {
            dispatch({ type: "finish" });
            return;
          }
        }
        const runtime = getHostRuntimeStore().getSnapshot(agent.serverId);
        if (!runtime?.client || runtime.connectionStatus !== "online")
          throw new Error(t("agentList.actions.offline"));
        // COMPAT(agentDetach): added in v0.1.98, remove gate after 2026-12-19 once daemon floor >= v0.1.98.
        if (
          action === "detach" &&
          !useSessionStore.getState().sessions[agent.serverId]?.serverInfo?.features?.agentDetach
        ) {
          throw new Error(t("agentList.actions.detachUnavailable"));
        }
        const result = await runAgentHistoryMutation({
          client: runtime.client,
          agentId: agent.id,
          action,
          name,
        });
        if (result.archivedAt)
          applyArchivedAgentCloseResults({
            queryClient,
            serverId: agent.serverId,
            results: [{ agentId: agent.id, archivedAt: result.archivedAt }],
          });
        invalidateHistory();
        dispatch({ type: "finish" });
      } catch (error) {
        dispatch({ type: "fail", error: toErrorMessage(error) });
        // The rename modal retains its input and renders the same failure next to it.
        if (action === "rename") throw error;
      } finally {
        operationRef.current = false;
      }
    },
    [agent.id, agent.serverId, agent.title, invalidateHistory, queryClient, t],
  );

  const copyId = useCallback(async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    dispatch({ type: "start", operation: "copy-id" });
    try {
      const copied = await Clipboard.setStringAsync(agent.id);
      if (!copied) throw new Error(t("workspace.tabs.toasts.copyFailed"));
      dispatch({ type: "finish", copied: true });
    } catch (error) {
      dispatch({ type: "fail", error: toErrorMessage(error) });
    } finally {
      operationRef.current = false;
    }
  }, [agent.id, t]);

  const selectAction = useCallback(
    (action: Operation) => {
      if (operationRef.current) return;
      if (action === "rename") dispatch({ type: "rename" });
      else if (action === "copy-id") void copyId();
      else void mutate(action);
    },
    [copyId, mutate],
  );
  const handleOpen = useCallback(() => {
    if (!operationRef.current && menu === null) onOpen(agent);
  }, [agent, menu, onOpen]);
  const contextOpenChange = useCallback((open: boolean) => setMenu(open ? "context" : null), []);
  const dropdownOpenChange = useCallback((open: boolean) => setMenu(open ? "dropdown" : null), []);
  const closeRename = useCallback(() => dispatch({ type: "close-rename" }), []);
  const submitRename = useCallback((name: string) => mutate("rename", name), [mutate]);
  const dismissError = useCallback(() => dispatch({ type: "dismiss-error" }), []);
  const rowStyle = useCallback(
    (trigger: MenuTriggerState) => [
      styles.rowTrigger,
      typeof style === "function" ? style(trigger) : style,
    ],
    [style],
  );
  const menuTriggerStyle = useCallback(
    ({ pressed, hovered, open }: MenuTriggerState) => [
      styles.menuTrigger,
      (pressed || hovered || open) && styles.menuTriggerActive,
    ],
    [],
  );

  const menuItems = (
    <AgentHistoryMenuItems
      agent={agent}
      knownChildren={knownChildren}
      pending={state.pending}
      copied={state.copied}
      onOpen={onOpen}
      onAction={selectAction}
    />
  );
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <ContextMenu open={menu === "context"} onOpenChange={contextOpenChange}>
          <ContextMenuTrigger
            style={rowStyle}
            onPress={handleOpen}
            accessibilityRole="button"
            testID={testID}
          >
            {children}
          </ContextMenuTrigger>
          <ContextMenuContent sheetTitle={t("agentList.actions.menu")} width={280}>
            {menu === "context" ? menuItems : null}
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu
          compactMode="sheet"
          open={menu === "dropdown"}
          onOpenChange={dropdownOpenChange}
        >
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("agentList.actions.menuFor", {
              title: agent.title || t("agentList.fallbackTitle"),
            })}
            style={menuTriggerStyle}
            testID={`agent-row-actions-${key}`}
          >
            {state.pending ? (
              <ThemedLoadingSpinner size={16} />
            ) : (
              <ThemedMoreHorizontal size={18} />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            sheetTitle={t("agentList.actions.menu")}
            side="bottom"
            align="end"
            width={280}
          >
            {menu === "dropdown" ? menuItems : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      {state.error ? (
        <View style={styles.feedback}>
          <Text
            accessibilityRole="alert"
            style={styles.error}
            testID={`agent-history-error-${key}`}
          >
            {state.error}
          </Text>
          <Button variant="ghost" size="xs" onPress={dismissError}>
            {t("common.actions.dismiss")}
          </Button>
        </View>
      ) : null}
      {state.copied ? (
        <Text accessibilityLiveRegion="polite" style={styles.success}>
          {t("agentList.actions.copied")}
        </Text>
      ) : null}
      {state.renaming ? (
        <AdaptiveRenameModal
          visible
          title={t("workspace.tabs.menu.renameAgent")}
          initialValue={agent.title ?? ""}
          maxLength={200}
          onSubmit={submitRename}
          onClose={closeRename}
          testID={`agent-history-rename-${key}`}
        />
      ) : null}
    </View>
  );
}

/** Mount store subscriptions only for an open menu, never once per retained history row. */
function AgentHistoryMenuItems({
  agent,
  knownChildren,
  pending,
  copied,
  onOpen,
  onAction,
}: {
  agent: AggregatedAgent;
  knownChildren?: readonly AggregatedAgent[];
  pending: Operation | null;
  copied: boolean;
  onOpen: (agent: AgentHistoryOpenTarget) => void;
  onAction: (action: Operation) => void;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(agent.serverId);
  const agents = useSessionStore((state) => state.sessions[agent.serverId]?.agents);
  const detail = useSessionStore((state) =>
    state.sessions[agent.serverId]?.agentDetails.get(agent.id),
  );
  const supportsDetach = useSessionStore(
    (state) => state.sessions[agent.serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const current = agents?.get(agent.id) ?? detail ?? agent;
  const parentId = getParentAgentIdFromLabels(current.labels);
  const children = useMemo(
    () => mergeAgentHistoryChildren(agent.id, knownChildren ?? [], agents?.values() ?? []),
    [agent.id, knownChildren, agents],
  );
  const key = `${agent.serverId}-${agent.id}`;
  let reason: string | undefined;
  if (pending) reason = t("agentList.actions.pending");
  else if (!isConnected) reason = t("agentList.actions.offline");
  let copyStatus: "idle" | "pending" | "success" = "idle";
  if (pending === "copy-id") copyStatus = "pending";
  else if (copied) copyStatus = "success";
  const copyId = useCallback(() => onAction("copy-id"), [onAction]);
  const mutationItem = (action: AgentHistoryMutation, unavailable = reason) => (
    <AgentHistoryMutationItem
      key={action}
      action={action}
      unavailable={unavailable}
      pending={pending}
      onAction={onAction}
      agentKey={key}
    />
  );
  return (
    <>
      <AgentHistoryNavigationItem
        serverId={agent.serverId}
        agentId={agent.id}
        workspaceId={agent.workspaceId}
        disabled={Boolean(pending)}
        onOpen={onOpen}
        testID={`agent-history-open-${key}`}
        label={t("agentList.actions.open")}
      />
      {mutationItem("rename")}
      <DropdownMenuItem
        disabled={Boolean(pending)}
        onSelect={copyId}
        closeOnSelect={false}
        status={copyStatus}
        successLabel={t("agentList.actions.copied")}
        testID={`agent-history-copy-id-${key}`}
      >
        {t("agentList.actions.copyId")}
      </DropdownMenuItem>
      {parentId || children.length ? <DropdownMenuSeparator /> : null}
      {parentId ? (
        <AgentHistoryNavigationItem
          serverId={agent.serverId}
          agentId={parentId}
          disabled={Boolean(pending)}
          onOpen={onOpen}
          testID={`agent-history-open-parent-${key}`}
          label={t("agentList.actions.openParent")}
        />
      ) : null}
      {children.length ? (
        <DropdownMenuLabel>{t("agentList.actions.subagents")}</DropdownMenuLabel>
      ) : null}
      {children.map((child) => (
        <AgentHistoryNavigationItem
          key={child.id}
          serverId={agent.serverId}
          agentId={child.id}
          workspaceId={child.workspaceId}
          disabled={Boolean(pending)}
          onOpen={onOpen}
          testID={`agent-history-child-${child.id}`}
          label={child.title || t("agentList.fallbackTitle")}
          description={child.id.slice(0, 8)}
        />
      ))}
      {parentId && !current.archivedAt
        ? mutationItem(
            "detach",
            reason ?? (!supportsDetach ? t("agentList.actions.detachUnavailable") : undefined),
          )
        : null}
      <DropdownMenuSeparator />
      {canStopHistoryAgent(current) ? mutationItem("stop") : null}
      {mutationItem(current.archivedAt ? "unarchive" : "archive")}
    </>
  );
}

function AgentHistoryMutationItem({
  action,
  unavailable,
  pending,
  onAction,
  agentKey,
}: {
  action: AgentHistoryMutation;
  unavailable?: string;
  pending: Operation | null;
  onAction: (action: Operation) => void;
  agentKey: string;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onAction(action), [action, onAction]);
  return (
    <DropdownMenuItem
      disabled={Boolean(unavailable)}
      description={unavailable}
      status={pending === action ? "pending" : "idle"}
      onSelect={select}
      testID={`agent-history-${action}-${agentKey}`}
    >
      {t(`agentList.actions.${action}`)}
    </DropdownMenuItem>
  );
}

function AgentHistoryNavigationItem({
  serverId,
  agentId,
  workspaceId,
  disabled,
  onOpen,
  testID,
  label,
  description,
}: {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  disabled: boolean;
  onOpen: (agent: AgentHistoryOpenTarget) => void;
  testID: string;
  label: string;
  description?: string;
}) {
  const open = useCallback(
    () => onOpen({ serverId, id: agentId, workspaceId }),
    [serverId, agentId, workspaceId, onOpen],
  );
  return (
    <DropdownMenuItem disabled={disabled} onSelect={open} testID={testID} description={description}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { width: "100%", minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", width: "100%", minWidth: 0 },
  rowTrigger: { flex: 1, minWidth: 0 },
  menuTrigger: {
    flexShrink: 0,
    width: { xs: 44, md: 32 },
    minHeight: { xs: 44, md: 32 },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  menuTriggerActive: { backgroundColor: theme.colors.interactionHighlight },
  feedback: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  error: { flex: 1, color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  success: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
