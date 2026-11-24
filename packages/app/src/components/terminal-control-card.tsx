import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Hand,
  SquareCheck,
  Terminal,
  XCircle,
} from "lucide-react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { TerminalControlPrompt } from "@getpaseo/protocol/messages";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { usePaneContextOptional, usePaneFocusOptional } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

const ThemedHand = withUnistyles(Hand);
const ThemedTerminal = withUnistyles(Terminal);
const ThemedChevron = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);
const ThemedSquareCheck = withUnistyles(SquareCheck);
const ThemedXCircle = withUnistyles(XCircle);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const amberColor = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const successColor = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const errorColor = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const placeholderTextColor = "#888888";

const EMPTY_PROMPTS: TerminalControlPrompt[] = [];
const noopFileOpen = () => undefined;
const takeControlIcon = (color: string) => <Terminal size={14} color={color} />;
const openTabIcon = (color: string) => <ExternalLink size={13} color={color} />;

function readRecordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export interface TerminalControlCardProps {
  serverId: string | null;
  agentId: string;
  detail: ToolCallDetail | undefined;
  status: "running" | "completed" | "failed" | "canceled";
  readOnly?: boolean;
  disableOuterSpacing?: boolean;
}

function resolveControlHeaderMeta(
  t: (key: string) => string,
  isPending: boolean,
  outputStatus: string | undefined,
  callStatus: TerminalControlCardProps["status"],
) {
  if (isPending) {
    return {
      title: t("terminalControl.titlePending"),
      icon: <ThemedHand size={14} uniProps={amberColor} />,
    };
  }
  if (outputStatus === "returned" || callStatus === "completed") {
    return {
      title: t("terminalControl.titleReturned"),
      icon: <ThemedCheck size={14} uniProps={successColor} />,
    };
  }
  return {
    title:
      outputStatus === "declined"
        ? t("terminalControl.titleDeclined")
        : t("terminalControl.titleOther"),
    icon: <ThemedXCircle size={14} uniProps={errorColor} />,
  };
}

interface TerminalControlPendingBodyProps {
  serverId: string | null;
  effectiveTerminalId?: string;
  effectiveCwd: string;
  isCompact: boolean;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  shareScreen: boolean;
  note: string;
  actionError: string | null;
  submittingAction: "return" | "decline" | null;
  hasClient: boolean;
  hasPaneContext: boolean;
  onToggleShareScreen: () => void;
  onChangeNote: (text: string) => void;
  onOpenMobileModal: () => void;
  onOpenInTerminalTab: () => void;
  onDecline: () => void;
  onReturn: () => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
}

function TerminalControlPendingBody({
  serverId,
  effectiveTerminalId,
  effectiveCwd,
  isCompact,
  isWorkspaceFocused,
  isPaneFocused,
  shareScreen,
  note,
  actionError,
  submittingAction,
  hasClient,
  hasPaneContext,
  onToggleShareScreen,
  onChangeNote,
  onOpenMobileModal,
  onOpenInTerminalTab,
  onDecline,
  onReturn,
  onOpenWorkspaceFile,
}: TerminalControlPendingBodyProps) {
  const { t } = useTranslation();
  const shareAccessibilityState = useMemo(() => ({ checked: shareScreen }), [shareScreen]);
  const hasLiveTerminal = Boolean(serverId && effectiveTerminalId && effectiveCwd);

  return (
    <>
      {!isCompact && hasLiveTerminal && serverId && effectiveTerminalId ? (
        <View style={styles.desktopTerminalBox} testID="terminal-control-inline-terminal">
          <TerminalPane
            serverId={serverId}
            cwd={effectiveCwd}
            terminalId={effectiveTerminalId}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={isPaneFocused}
            onOpenFileExplorer={noopFileOpen}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        </View>
      ) : null}

      <PressHighlight
        onPress={onToggleShareScreen}
        accessibilityRole="checkbox"
        accessibilityState={shareAccessibilityState}
        style={styles.shareRow}
        testID="terminal-control-share-screen"
      >
        {shareScreen ? (
          <ThemedSquareCheck size={15} uniProps={amberColor} />
        ) : (
          <ThemedTerminal size={15} uniProps={mutedColor} />
        )}
        <Text style={styles.shareLabel}>{t("terminalControl.shareScreenLabel")}</Text>
      </PressHighlight>

      <EditingTextInput
        initialValue={note}
        onChangeText={onChangeNote}
        placeholder={t("terminalControl.notePlaceholder")}
        placeholderTextColor={placeholderTextColor}
        style={styles.noteInput}
        editable={submittingAction === null}
        testID="terminal-control-note-input"
      />

      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

      <View style={styles.actionsRow}>
        {isCompact && hasLiveTerminal ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={takeControlIcon}
            onPress={onOpenMobileModal}
            testID="terminal-control-take-control"
          >
            {t("terminalControl.takeControl")}
          </Button>
        ) : null}

        {effectiveTerminalId && hasPaneContext ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={openTabIcon}
            onPress={onOpenInTerminalTab}
            testID="terminal-control-open-tab"
          >
            {t("terminalControl.openTerminal")}
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="secondary"
          onPress={onDecline}
          disabled={submittingAction !== null || !hasClient}
          loading={submittingAction === "decline"}
          testID="terminal-control-decline"
        >
          {t("terminalControl.decline")}
        </Button>

        <Button
          size="sm"
          variant="default"
          onPress={onReturn}
          disabled={submittingAction !== null || !hasClient}
          loading={submittingAction === "return"}
          testID="terminal-control-return"
        >
          {submittingAction === "return"
            ? t("terminalControl.returning")
            : t("terminalControl.returnControl")}
        </Button>
      </View>
    </>
  );
}

interface TerminalControlMobileModalProps {
  visible: boolean;
  serverId: string;
  terminalId: string;
  cwd: string;
  title: string;
  reason?: string;
  submittingAction: "return" | "decline" | null;
  hasClient: boolean;
  onClose: () => void;
  onReturn: () => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
}

function TerminalControlMobileModal({
  visible,
  serverId,
  terminalId,
  cwd,
  title,
  reason,
  submittingAction,
  hasClient,
  onClose,
  onReturn,
  onOpenWorkspaceFile,
}: TerminalControlMobileModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafeArea}>
        <View style={styles.modalHeader}>
          <View style={styles.modalHeaderInfo}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {title}
            </Text>
            {reason ? (
              <Text style={styles.modalReason} numberOfLines={2}>
                {reason}
              </Text>
            ) : null}
          </View>
          <View style={styles.modalHeaderActions}>
            <Button size="sm" variant="secondary" onPress={onClose}>
              {t("common.close")}
            </Button>
            <Button
              size="sm"
              variant="default"
              onPress={onReturn}
              disabled={submittingAction !== null || !hasClient}
              loading={submittingAction === "return"}
              testID="terminal-control-modal-return"
            >
              {submittingAction === "return"
                ? t("terminalControl.returning")
                : t("terminalControl.returnControl")}
            </Button>
          </View>
        </View>
        <View style={styles.modalTerminalContainer}>
          <TerminalPane
            serverId={serverId}
            cwd={cwd}
            terminalId={terminalId}
            isWorkspaceFocused
            isPaneFocused
            onOpenFileExplorer={noopFileOpen}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function parseControlDetail(detail: ToolCallDetail | undefined) {
  if (detail?.type !== "unknown") {
    return { input: {}, output: {} };
  }
  return {
    input: {
      terminalId: readRecordString(detail.input, "terminalId"),
      reason: readRecordString(detail.input, "reason"),
      requestId: readRecordString(detail.input, "requestId"),
    },
    output: {
      status: readRecordString(detail.output, "status"),
      screen: readRecordString(detail.output, "screen"),
      note: readRecordString(detail.output, "note"),
    },
  };
}

function findPendingControlPrompt(
  pendingPrompts: readonly TerminalControlPrompt[],
  agentId: string,
  requestId?: string,
  terminalId?: string,
): TerminalControlPrompt | null {
  for (const prompt of pendingPrompts) {
    if (requestId && prompt.id === requestId) {
      return prompt;
    }
    if (prompt.agentId === agentId && (!terminalId || prompt.terminalId === terminalId)) {
      return prompt;
    }
  }
  return null;
}

function TerminalControlCompletedBody({ note, screen }: { note?: string; screen?: string }) {
  return (
    <>
      {note ? (
        <Text style={styles.notePreview} selectable>
          {note}
        </Text>
      ) : null}
      {screen ? (
        <ScrollView
          style={styles.screenScroll}
          nestedScrollEnabled
          testID="terminal-control-screen-snapshot"
        >
          <Text style={styles.screenText} selectable>
            {screen}
          </Text>
        </ScrollView>
      ) : null}
    </>
  );
}

function useTerminalControlCardState({
  serverId,
  agentId,
  detail,
  status,
  readOnly,
}: Pick<TerminalControlCardProps, "serverId" | "agentId" | "detail" | "status" | "readOnly">) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const paneContext = usePaneContextOptional();
  const paneFocus = usePaneFocusOptional();
  const hold = useDisclosureHold();

  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const pendingPrompts = useSessionStore((state) =>
    serverId
      ? (state.sessions[serverId]?.pendingTerminalControlPrompts ?? EMPTY_PROMPTS)
      : EMPTY_PROMPTS,
  );
  const agentCwd = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents.get(agentId)?.cwd : undefined,
  );

  const { input: parsedInput, output: parsedOutput } = useMemo(
    () => parseControlDetail(detail),
    [detail],
  );
  const pendingPrompt = useMemo(
    () =>
      findPendingControlPrompt(
        pendingPrompts,
        agentId,
        parsedInput.requestId,
        parsedInput.terminalId,
      ),
    [agentId, parsedInput.requestId, parsedInput.terminalId, pendingPrompts],
  );

  const isPending = pendingPrompt !== null || status === "running";
  const effectiveTerminalId = pendingPrompt?.terminalId ?? parsedInput.terminalId;
  const effectiveReason = pendingPrompt?.reason ?? parsedInput.reason;
  const effectiveCwd = pendingPrompt?.cwd ?? agentCwd ?? "";

  const [expanded, setExpanded] = useState(isPending);
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [shareScreen, setShareScreen] = useState(true);
  const [note, setNote] = useState("");
  const [submittingAction, setSubmittingAction] = useState<"return" | "decline" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleExpanded = useCallback(() => hold(() => setExpanded((current) => !current)), [hold]);
  const toggleShareScreen = useCallback(() => setShareScreen((value) => !value), []);
  const openMobileModal = useCallback(() => setMobileModalOpen(true), []);
  const closeMobileModal = useCallback(() => setMobileModalOpen(false), []);

  const handleOpenInTerminalTab = useCallback(() => {
    if (!effectiveTerminalId || !paneContext) return;
    paneContext.openTab({ kind: "terminal", terminalId: effectiveTerminalId });
  }, [effectiveTerminalId, paneContext]);

  const handleOpenWorkspaceFile = useMemo(
    () => paneContext?.openFileInWorkspace ?? noopFileOpen,
    [paneContext],
  );

  const submitControlResponse = useCallback(
    (action: "return" | "decline") => {
      if (!client || !pendingPrompt || submittingAction || readOnly) return;
      setSubmittingAction(action);
      setActionError(null);
      const trimmedNote = note.trim();
      void client
        .respondToTerminalControlPrompt({
          controlId: pendingPrompt.id,
          action,
          ...(action === "return" ? { shareScreen } : {}),
          ...(action === "return" && trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        })
        .then((res) => {
          if (!res.success) {
            setActionError(res.error ?? t("composer.errors.failedToSend"));
            return undefined;
          }
          setMobileModalOpen(false);
          return undefined;
        })
        .catch((err) => {
          setActionError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setSubmittingAction(null);
        });
    },
    [client, note, pendingPrompt, readOnly, shareScreen, submittingAction, t],
  );

  const handleDecline = useCallback(
    () => submitControlResponse("decline"),
    [submitControlResponse],
  );
  const handleReturn = useCallback(() => submitControlResponse("return"), [submitControlResponse]);

  return {
    t,
    isCompact,
    hasClient: Boolean(client),
    hasPaneContext: Boolean(paneContext),
    isWorkspaceFocused: paneFocus?.isWorkspaceFocused ?? true,
    isPaneFocused: paneFocus?.isPaneFocused ?? true,
    parsedOutput,
    pendingPrompt,
    isPending,
    effectiveTerminalId,
    effectiveReason,
    effectiveCwd,
    expanded,
    mobileModalOpen,
    shareScreen,
    note,
    setNote,
    submittingAction,
    actionError,
    toggleExpanded,
    toggleShareScreen,
    openMobileModal,
    closeMobileModal,
    handleOpenInTerminalTab,
    handleOpenWorkspaceFile,
    handleDecline,
    handleReturn,
  };
}

export function TerminalControlCard({
  serverId,
  agentId,
  detail,
  status,
  readOnly = false,
  disableOuterSpacing = false,
}: TerminalControlCardProps) {
  const model = useTerminalControlCardState({
    serverId,
    agentId,
    detail,
    status,
    readOnly,
  });

  const containerStyle = useMemo(
    () => [
      styles.container,
      model.isPending && styles.containerPending,
      disableOuterSpacing && styles.containerCompact,
    ],
    [disableOuterSpacing, model.isPending],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, model.expanded && styles.chevronExpanded],
    [model.expanded],
  );
  const headerAccessibilityState = useMemo(() => ({ expanded: model.expanded }), [model.expanded]);
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": model.expanded } as const) : null),
    [model.expanded],
  );

  const headerMeta = resolveControlHeaderMeta(
    model.t,
    model.isPending,
    model.parsedOutput.status,
    status,
  );
  const showInteractivePending = Boolean(model.isPending && model.pendingPrompt && !readOnly);
  const showMobileModal = Boolean(
    model.isCompact &&
    model.mobileModalOpen &&
    serverId &&
    model.effectiveTerminalId &&
    model.effectiveCwd,
  );

  return (
    <View style={containerStyle} testID="terminal-control-card">
      <PressHighlight
        onPress={model.toggleExpanded}
        accessibilityRole="button"
        accessibilityState={headerAccessibilityState}
        {...webExpandedProps}
        style={styles.header}
        testID="terminal-control-card-header"
      >
        <View style={styles.headerLeft}>
          <View style={chevronStyle}>
            <ThemedChevron size={15} uniProps={mutedColor} />
          </View>
          {headerMeta.icon}
          <Text style={styles.title} numberOfLines={1}>
            {headerMeta.title}
          </Text>
        </View>
        {model.isPending ? <ThemedSpinner size="small" uniProps={amberColor} /> : null}
      </PressHighlight>

      {model.effectiveReason ? (
        <Text style={styles.reasonText} selectable>
          {model.effectiveReason}
        </Text>
      ) : null}

      {model.expanded ? (
        <View style={styles.body}>
          {showInteractivePending ? (
            <TerminalControlPendingBody
              serverId={serverId}
              effectiveTerminalId={model.effectiveTerminalId}
              effectiveCwd={model.effectiveCwd}
              isCompact={model.isCompact}
              isWorkspaceFocused={model.isWorkspaceFocused}
              isPaneFocused={model.isPaneFocused}
              shareScreen={model.shareScreen}
              note={model.note}
              actionError={model.actionError}
              submittingAction={model.submittingAction}
              hasClient={model.hasClient}
              hasPaneContext={model.hasPaneContext}
              onToggleShareScreen={model.toggleShareScreen}
              onChangeNote={model.setNote}
              onOpenMobileModal={model.openMobileModal}
              onOpenInTerminalTab={model.handleOpenInTerminalTab}
              onDecline={model.handleDecline}
              onReturn={model.handleReturn}
              onOpenWorkspaceFile={model.handleOpenWorkspaceFile}
            />
          ) : (
            <TerminalControlCompletedBody
              note={model.parsedOutput.note}
              screen={model.parsedOutput.screen}
            />
          )}
        </View>
      ) : null}

      {showMobileModal && serverId && model.effectiveTerminalId ? (
        <TerminalControlMobileModal
          visible={model.mobileModalOpen}
          serverId={serverId}
          terminalId={model.effectiveTerminalId}
          cwd={model.effectiveCwd}
          title={model.pendingPrompt?.terminalName ?? model.t("terminalControl.titlePending")}
          reason={model.effectiveReason}
          submittingAction={model.submittingAction}
          hasClient={model.hasClient}
          onClose={model.closeMobileModal}
          onReturn={model.handleReturn}
          onOpenWorkspaceFile={model.handleOpenWorkspaceFile}
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
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  containerPending: {
    borderColor: theme.colors.palette.amber[500],
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
    flex: 1,
    minWidth: 0,
  },
  chevron: {},
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  reasonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  body: {
    gap: theme.spacing[2],
  },
  desktopTerminalBox: {
    height: 280,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    paddingVertical: 2,
  },
  shareLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  notePreview: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontStyle: "italic",
  },
  screenScroll: {
    maxHeight: 220,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
  },
  screenText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 16,
    color: theme.colors.foreground,
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  modalHeaderInfo: {
    gap: 2,
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modalReason: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  modalHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  modalTerminalContainer: {
    flex: 1,
    minHeight: 0,
  },
}));
