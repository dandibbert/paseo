import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronRight, ExternalLink, Terminal, XCircle } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { TerminalPane } from "@/components/terminal-pane";
import { isWeb } from "@/constants/platform";
import { usePaneContextOptional, usePaneFocusOptional } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

const ThemedTerminal = withUnistyles(Terminal);
const ThemedChevron = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);
const ThemedXCircle = withUnistyles(XCircle);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColor = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const successColor = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const errorColor = (theme: Theme) => ({ color: theme.colors.palette.red[500] });

const noopFileOpen = () => undefined;
const externalLinkIcon = (color: string) => <ExternalLink size={13} color={color} />;

export interface UserShellCommandCardProps {
  serverId: string | null;
  agentId: string;
  callId: string;
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  terminalId?: string;
  status: "running" | "completed" | "failed" | "canceled";
  error?: unknown;
  readOnly?: boolean;
  disableOuterSpacing?: boolean;
}

interface UserShellStatusBadgeProps {
  status: UserShellCommandCardProps["status"];
  exitCode?: number | null;
}

function UserShellStatusBadge({ status, exitCode }: UserShellStatusBadgeProps) {
  const { t } = useTranslation();

  if (status === "running") {
    return (
      <View style={styles.statusBadge}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
        <Text style={styles.statusTextRunning}>{t("agentShell.running")}</Text>
      </View>
    );
  }

  const exitLabel =
    exitCode !== undefined && exitCode !== null
      ? t("agentShell.exitCode", { code: exitCode })
      : null;

  if (status === "completed") {
    return (
      <View style={styles.statusBadge}>
        <ThemedCheck size={12} uniProps={successColor} />
        <Text style={styles.statusTextSuccess}>{exitLabel ?? t("terminalControl.doneLabel")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.statusBadge}>
      <ThemedXCircle size={12} uniProps={errorColor} />
      <Text style={styles.statusTextError}>{exitLabel ?? t("paneFind.failed")}</Text>
    </View>
  );
}

interface UserShellCardBodyProps {
  serverId: string | null;
  terminalId?: string;
  effectiveCwd: string;
  isRunning: boolean;
  output?: string;
  errorText: string | null;
  readOnly: boolean;
  finishing: boolean;
  hasClient: boolean;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  hasPaneContext: boolean;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
  onOpenInTerminalTab: () => void;
  onMarkComplete: () => void;
}

function UserShellCardBody({
  serverId,
  terminalId,
  effectiveCwd,
  isRunning,
  output,
  errorText,
  readOnly,
  finishing,
  hasClient,
  isWorkspaceFocused,
  isPaneFocused,
  hasPaneContext,
  onOpenWorkspaceFile,
  onOpenInTerminalTab,
  onMarkComplete,
}: UserShellCardBodyProps) {
  const { t } = useTranslation();
  const canRenderLiveTerminal = Boolean(isRunning && terminalId && serverId && effectiveCwd);

  let bodyOutput: React.ReactNode = null;
  if (canRenderLiveTerminal && serverId && terminalId) {
    bodyOutput = (
      <View style={styles.liveTerminalBox} testID="user-shell-live-terminal">
        <TerminalPane
          serverId={serverId}
          cwd={effectiveCwd}
          terminalId={terminalId}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={isPaneFocused}
          onOpenFileExplorer={noopFileOpen}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </View>
    );
  } else if (output && output.length > 0) {
    bodyOutput = (
      <ScrollView style={styles.outputScroll} nestedScrollEnabled testID="user-shell-static-output">
        <Text style={styles.outputText} selectable>
          {output}
        </Text>
      </ScrollView>
    );
  } else if (!isRunning) {
    bodyOutput = <Text style={styles.emptyOutput}>{t("agentShell.noOutput")}</Text>;
  }

  return (
    <View style={styles.body}>
      {bodyOutput}

      {errorText ? (
        <Text style={styles.errorText} selectable>
          {errorText}
        </Text>
      ) : null}

      {isRunning && !readOnly ? (
        <View style={styles.footerActions}>
          {terminalId && hasPaneContext ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={externalLinkIcon}
              onPress={onOpenInTerminalTab}
              testID="user-shell-open-terminal"
            >
              {t("agentShell.openTerminal")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="default"
            onPress={onMarkComplete}
            disabled={finishing || !hasClient}
            loading={finishing}
            testID="user-shell-mark-complete"
          >
            {t("agentShell.markComplete")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export function UserShellCommandCard({
  serverId,
  agentId,
  callId,
  command,
  cwd,
  output,
  exitCode,
  terminalId,
  status,
  error,
  readOnly = false,
  disableOuterSpacing = false,
}: UserShellCommandCardProps) {
  const { t } = useTranslation();
  const isRunning = status === "running";
  const [expanded, setExpanded] = useState(isRunning || status === "failed");
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const hold = useDisclosureHold();

  const paneContext = usePaneContextOptional();
  const paneFocus = usePaneFocusOptional();
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const agentCwd = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents.get(agentId)?.cwd : undefined,
  );
  const effectiveCwd = cwd ?? agentCwd ?? "";

  const toggleExpanded = useCallback(() => hold(() => setExpanded((current) => !current)), [hold]);

  const handleMarkComplete = useCallback(() => {
    if (!client || finishing || readOnly) return;
    setFinishing(true);
    setFinishError(null);
    void client
      .finishAgentShellCommand({ agentId, callId })
      .then((res) => {
        if (!res.success) {
          setFinishError(res.error ?? t("composer.errors.failedToSend"));
        }
        return undefined;
      })
      .catch((err) => {
        setFinishError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setFinishing(false);
      });
  }, [agentId, callId, client, finishing, readOnly, t]);

  const handleOpenInTerminalTab = useCallback(() => {
    if (!terminalId || !paneContext) return;
    paneContext.openTab({ kind: "terminal", terminalId });
  }, [paneContext, terminalId]);

  const handleOpenWorkspaceFile = useMemo(
    () => paneContext?.openFileInWorkspace ?? noopFileOpen,
    [paneContext],
  );

  const errorText = useMemo(() => {
    if (finishError) return finishError;
    if (typeof error === "string" && error.trim().length > 0) return error;
    return null;
  }, [error, finishError]);

  const containerStyle = useMemo(
    () => [styles.container, disableOuterSpacing && styles.containerCompact],
    [disableOuterSpacing],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );

  return (
    <View style={containerStyle} testID={`user-shell-command-card-${callId}`}>
      <PressHighlight
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        {...webExpandedProps}
        style={styles.header}
        testID="user-shell-card-header"
      >
        <View style={styles.headerLeft}>
          <View style={chevronStyle}>
            <ThemedChevron size={15} uniProps={mutedColor} />
          </View>
          <ThemedTerminal size={14} uniProps={accentColor} />
          <Text style={styles.originLabel}>{t("agentShell.youPrefix")}</Text>
        </View>
        <UserShellStatusBadge status={status} exitCode={exitCode} />
      </PressHighlight>

      <View style={styles.commandBox}>
        <Text style={styles.commandText} selectable>
          $ {command}
        </Text>
      </View>

      {expanded ? (
        <UserShellCardBody
          serverId={serverId}
          terminalId={terminalId}
          effectiveCwd={effectiveCwd}
          isRunning={isRunning}
          output={output}
          errorText={errorText}
          readOnly={readOnly}
          finishing={finishing}
          hasClient={Boolean(client)}
          isWorkspaceFocused={paneFocus?.isWorkspaceFocused ?? true}
          isPaneFocused={paneFocus?.isPaneFocused ?? true}
          hasPaneContext={Boolean(paneContext)}
          onOpenWorkspaceFile={handleOpenWorkspaceFile}
          onOpenInTerminalTab={handleOpenInTerminalTab}
          onMarkComplete={handleMarkComplete}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: theme.borderRadius.sm,
    gap: theme.spacing[2],
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  chevron: {},
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  originLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.blue[500],
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  statusTextRunning: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  statusTextSuccess: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.green[500],
  },
  statusTextError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  commandBox: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  commandText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  body: {
    gap: theme.spacing[2],
  },
  liveTerminalBox: {
    height: 240,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  outputScroll: {
    maxHeight: 280,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
  },
  outputText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  emptyOutput: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));
