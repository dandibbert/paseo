import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Hand, Terminal } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import type { ListTerminalsResponse, TerminalControlPrompt } from "@getpaseo/protocol/messages";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import { openUrlInWorkspaceBrowser } from "@/desktop/browser/open-url-in-workspace";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { queryClient } from "@/data/query-client";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { showExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";

type ListTerminalsPayload = ListTerminalsResponse["payload"];

const EMPTY_CONTROL_PROMPTS: TerminalControlPrompt[] = [];
const ThemedHand = withUnistyles(Hand);
const amberIcon = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function useTerminalPanelDescriptor(
  target: { kind: "terminal"; terminalId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[context.serverId]?.client ?? null);
  const pendingControlPrompt = useSessionStore(
    (state) =>
      (
        state.sessions[context.serverId]?.pendingTerminalControlPrompts ?? EMPTY_CONTROL_PROMPTS
      ).find((prompt) => prompt.terminalId === target.terminalId) ?? null,
  );
  const workspaceDirectory = useWorkspaceDirectory(context.serverId, context.workspaceId);
  const terminalsQuery = useQuery(
    {
      queryKey: buildTerminalsQueryKey(
        context.serverId,
        workspaceDirectory,
        context.workspaceId || null,
      ),
      enabled: Boolean(client && workspaceDirectory),
      queryFn: async (): Promise<ListTerminalsPayload> => {
        if (!client || !workspaceDirectory) {
          throw new Error("Workspace directory not found");
        }
        return client.listTerminals(workspaceDirectory, undefined, {
          workspaceId: context.workspaceId || undefined,
        });
      },
      staleTime: 5_000,
    },
    queryClient,
  );
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;
  const label =
    trimNonEmpty(terminal?.title ?? terminal?.name ?? null) ??
    t("workspace.tabs.fallback.terminal");

  return {
    label,
    subtitle: pendingControlPrompt
      ? t("terminalControl.tabBadgeLabel")
      : t("workspace.tabs.fallback.terminal"),
    tooltip: label,
    titleState: terminalsQuery.isPending ? "loading" : "ready",
    icon: Terminal,
    statusBucket: pendingControlPrompt
      ? "needs_input"
      : deriveTerminalActivityStatusBucket(terminal?.activity),
  };
}

function TerminalPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const pendingControlPrompt = useSessionStore(
    (state) =>
      (state.sessions[serverId]?.pendingTerminalControlPrompts ?? EMPTY_CONTROL_PROMPTS).find(
        (prompt) => prompt.terminalId === (target.kind === "terminal" ? target.terminalId : ""),
      ) ?? null,
  );
  const [submittingControl, setSubmittingControl] = useState(false);
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const isCompact = useIsCompactFormFactor();
  const handleOpenFileExplorer = useCallback(() => {
    if (!workspaceDirectory) {
      return;
    }
    showExplorerSidebar({
      isCompact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    });
  }, [isCompact, serverId, workspaceId, workspaceDirectory]);

  const handleControlRespond = useCallback(
    (action: "return" | "decline") => {
      if (!client || !pendingControlPrompt || submittingControl) return;
      setSubmittingControl(true);
      void client
        .respondToTerminalControlPrompt({
          controlId: pendingControlPrompt.id,
          action,
          ...(action === "return" ? { shareScreen: true } : {}),
        })
        .finally(() => {
          setSubmittingControl(false);
        });
    },
    [client, pendingControlPrompt, submittingControl],
  );

  const handleDeclineControl = useCallback(() => {
    handleControlRespond("decline");
  }, [handleControlRespond]);

  const handleReturnControl = useCallback(() => {
    handleControlRespond("return");
  }, [handleControlRespond]);

  const handleOpenBrowserUrl = useCallback(
    (url: string) => openUrlInWorkspaceBrowser({ serverId, workspaceId, url }),
    [serverId, workspaceId],
  );
  invariant(target.kind === "terminal", "TerminalPanel requires terminal target");

  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>Workspace directory not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {pendingControlPrompt ? (
        <View style={styles.controlBanner} testID="terminal-panel-control-banner">
          <View style={styles.controlBannerInfo}>
            <ThemedHand size={14} uniProps={amberIcon} />
            <Text style={styles.controlBannerText} numberOfLines={2}>
              {t("terminalControl.bannerPrompt", { reason: pendingControlPrompt.reason })}
            </Text>
          </View>
          <View style={styles.controlBannerActions}>
            <Button
              size="sm"
              variant="secondary"
              onPress={handleDeclineControl}
              disabled={submittingControl || !client}
              testID="terminal-panel-decline-control"
            >
              {t("terminalControl.decline")}
            </Button>
            <Button
              size="sm"
              variant="default"
              onPress={handleReturnControl}
              disabled={submittingControl || !client}
              loading={submittingControl}
              testID="terminal-panel-return-control"
            >
              {t("terminalControl.returnControl")}
            </Button>
          </View>
        </View>
      ) : null}
      <View style={styles.paneContainer}>
        <TerminalPane
          serverId={serverId}
          cwd={workspaceDirectory}
          terminalId={target.terminalId}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={isPaneFocused}
          onOpenFileExplorer={handleOpenFileExplorer}
          onOpenWorkspaceFile={openFileInWorkspace}
          onOpenBrowserUrl={handleOpenBrowserUrl}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  paneContainer: {
    flex: 1,
    minHeight: 0,
  },
  controlBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.palette.amber[500],
  },
  controlBannerInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 180,
  },
  controlBannerText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  controlBannerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

export const terminalPanelRegistration = definePanel("terminal", {
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
});
