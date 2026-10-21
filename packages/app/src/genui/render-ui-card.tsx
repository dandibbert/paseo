import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type {
  RenderUiAction,
  RenderUiInput,
  RenderUiType,
} from "@getpaseo/protocol/genui/render-ui-schema";
import { Button } from "@/components/ui/button";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { MetricTilePair } from "./components/metric-views";
import {
  isInCurrentTurn,
  resolveFollowUpAvailability,
  type RenderUiActionTarget,
} from "./follow-up-actions";
import {
  applyHeightFloorLayout,
  createHeightFloor,
  raiseHeightFloorToEstimate,
} from "./height-floor";
import { withContentKeys } from "./keyed";
import { buildRenderUiDataText, buildRenderUiPlainText } from "./plain-text";
import type { RenderUiCardState, RenderUiPreview } from "./render-ui-call";
import { RenderUiNodeView } from "./render-ui-node";
import { genuiStyles } from "./styles";
import { GENUI_RADIUS, GENUI_SPACE, GENUI_TEXT, type GenuiColors } from "./tokens";

const COPIED_RESET_MS = 1500;

// Skeleton heights double as the card's minimum height. They are deliberately close to
// the smallest real card of each type so the accepted card grows into place.
const ESTIMATED_HEIGHT: Record<RenderUiType, number> = {
  metricComparison: 200,
  metric: 104,
  progress: 72,
  // A horizontal bar chart with one row is short; vertical bars grow past this.
  "chart.bar": 140,
  "chart.line": 320,
  "chart.pie": 320,
  table: 150,
  priorityList: 200,
  steps: 120,
  card: 200,
  grid: 120,
};
const UNKNOWN_TYPE_ESTIMATE = 120;

function genuiColorsFromTheme(theme: Theme): { colors: GenuiColors } {
  return { colors: theme.genui };
}

interface BoundaryProps {
  fallbackText: string;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

class RenderUiErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[GenUI] Card render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return <Text style={genuiStyles.body}>{this.props.fallbackText}</Text>;
  }
}

const AcceptedBody = withUnistyles(function AcceptedBody({
  input,
  colors,
}: {
  input: RenderUiInput;
  colors: GenuiColors;
}) {
  return <RenderUiNodeView node={input} colors={colors} nested={false} />;
});

function PreviewBody({ preview }: { preview: RenderUiPreview }) {
  return (
    <View style={styles.previewStack}>
      {preview.title ? <Text style={genuiStyles.caption}>{preview.title}</Text> : null}
      {preview.metricItems.length > 0 ? <MetricTilePair items={preview.metricItems} /> : null}
      {preview.priorityItems.length > 0 ? (
        <View style={genuiStyles.outlinedCard}>
          {withContentKeys(preview.priorityItems).map(({ key, item }) => (
            <View key={key} style={styles.previewItem}>
              <Text style={genuiStyles.itemTitle}>{item.title}</Text>
              <Text style={genuiStyles.body}>{item.body}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.loadingBlock} />
    </View>
  );
}

// Model-authored follow-ups. Pressing one shows the exact prompt and sends it as the user's
// next message only after the user confirms.
function FollowUpButtons({
  actions,
  ...target
}: RenderUiActionTarget & { actions: readonly RenderUiAction[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(target.serverId);
  const connected = useHostRuntimeIsConnected(target.serverId);
  const agentBusy = useSessionStore(
    (state) =>
      selectAgentTurnPresentation(state.sessions[target.serverId], target.agentId).isActive,
  );
  const isLatestTurn = useSessionStore((state) => {
    const session = state.sessions[target.serverId];
    return isInCurrentTurn({
      tail: session?.agentStreamTail.get(target.agentId) ?? [],
      head: session?.agentStreamHead.get(target.agentId) ?? [],
      itemId: target.itemId,
    });
  });
  const [sending, setSending] = useState(false);
  const [sentLabel, setSentLabel] = useState<string | null>(null);
  const availability = resolveFollowUpAvailability({
    target: { ...target, isLatestTurn },
    agentBusy,
    connected: connected && client !== null,
    sending,
    sentLabel,
  });
  const handlePress = useCallback(
    async (action: RenderUiAction) => {
      if (!client) {
        return;
      }
      const confirmed = await confirmDialog({
        title: action.label,
        message: action.prompt,
        confirmLabel: t("genui.action.send"),
        cancelLabel: t("genui.action.cancel"),
      });
      if (!confirmed) {
        return;
      }
      setSending(true);
      try {
        await dispatchComposerAgentMessage({
          client,
          agentId: target.agentId,
          text: action.prompt,
          attachments: [],
          encodeImages: async () => [],
          submission: createMessageSubmissionWriter(target.serverId),
        });
        setSentLabel(action.label);
      } catch (error) {
        console.warn("[GenUI] Failed to send follow-up", error);
        toast.show(t("genui.action.failed"), { variant: "error" });
      } finally {
        setSending(false);
      }
    },
    [client, target.agentId, target.serverId, t, toast],
  );
  return (
    <View style={styles.followUps}>
      {actions.map((action) => (
        <FollowUpButton
          key={action.label}
          action={action}
          disabled={availability !== "enabled"}
          sent={sentLabel === action.label}
          onPress={handlePress}
        />
      ))}
    </View>
  );
}

function FollowUpButton({
  action,
  disabled,
  sent,
  onPress,
}: {
  action: RenderUiAction;
  disabled: boolean;
  sent: boolean;
  onPress: (action: RenderUiAction) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    void onPress(action);
  }, [action, onPress]);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onPress={handlePress}
      accessibilityHint={action.prompt}
      testID="genui-follow-up"
    >
      {sent ? `${action.label} · ${t("genui.action.sent")}` : action.label}
    </Button>
  );
}

function CardActions({ input }: { input: RenderUiInput }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [showData, setShowData] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );
  const handleCopy = useCallback(async () => {
    await copyToClipboard(buildRenderUiPlainText(input));
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [input]);
  const toggleData = useCallback(() => setShowData((value) => !value), []);
  const dataButtonState = useMemo(() => ({ expanded: showData }), [showData]);
  return (
    <View style={styles.actionsStack}>
      {showData ? (
        <View style={genuiStyles.subBlock}>
          <Text style={genuiStyles.secondarySmall} selectable testID="genui-data-text">
            {buildRenderUiDataText(input)}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="xs"
          onPress={handleCopy}
          textStyle={styles.actionText}
          testID="genui-copy"
        >
          {copied ? t("genui.copied") : t("genui.copy")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onPress={toggleData}
          accessibilityState={dataButtonState}
          textStyle={styles.actionText}
          testID="genui-view-data"
        >
          {showData ? t("genui.hideData") : t("genui.viewData")}
        </Button>
      </View>
    </View>
  );
}

function AcceptedContent({ input }: { input: RenderUiInput }) {
  const { t } = useTranslation();
  return (
    <RenderUiErrorBoundary fallbackText={buildRenderUiPlainText(input) || t("genui.renderError")}>
      <AcceptedBody input={input} uniProps={genuiColorsFromTheme} />
    </RenderUiErrorBoundary>
  );
}

function estimateHeight(state: RenderUiCardState): number {
  if (state.status === "generating") {
    return state.preview.type ? ESTIMATED_HEIGHT[state.preview.type] : UNKNOWN_TYPE_ESTIMATE;
  }
  if (state.status === "accepted") {
    return ESTIMATED_HEIGHT[state.input.type];
  }
  return 0;
}

// One render_ui call in the timeline. The card body keeps a minimum height so the list does
// not jump while it streams in (see height-floor.ts); a rejected call collapses to nothing.
// The actions and the "View data" panel sit outside that floor so closing the panel shrinks.
// followUpServerId is null in read-only timelines, where follow-up buttons are not drawn.
export function RenderUiCard({
  state,
  followUpServerId = null,
  agentId,
  itemId,
}: {
  state: RenderUiCardState;
  followUpServerId?: string | null;
  agentId?: string;
  itemId?: string;
}) {
  const { t } = useTranslation();
  const estimate = estimateHeight(state);
  const generating = state.status === "generating";
  const [floor, setFloor] = useState(() => createHeightFloor(estimate));
  useEffect(() => {
    setFloor((current) => raiseHeightFloorToEstimate(current, estimate));
  }, [estimate]);
  const bodyStyle = useMemo(() => ({ minHeight: floor.minHeight }), [floor.minHeight]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setFloor((current) =>
        applyHeightFloorLayout({
          floor: current,
          layout: { width: Math.round(width), height: Math.ceil(height) },
          estimate,
          generating,
        }),
      );
    },
    [estimate, generating],
  );

  if (state.status === "rejected") {
    return null;
  }
  if (state.status === "unsupported") {
    return state.fallbackText ? (
      <View style={styles.root} testID="genui-card-unsupported">
        <Text style={genuiStyles.body}>{state.fallbackText}</Text>
      </View>
    ) : null;
  }
  return (
    <View
      style={[styles.root, styles.acceptedStack]}
      testID={state.status === "accepted" ? "genui-card" : "genui-card-generating"}
      accessibilityLabel={state.status === "generating" ? t("genui.generating") : undefined}
    >
      <View style={bodyStyle} onLayout={handleLayout}>
        {state.status === "accepted" ? (
          <AcceptedContent input={state.input} />
        ) : (
          <PreviewBody preview={state.preview} />
        )}
      </View>
      {state.status === "accepted" &&
      state.input.actions &&
      followUpServerId &&
      agentId &&
      itemId ? (
        <FollowUpButtons
          actions={state.input.actions}
          serverId={followUpServerId}
          agentId={agentId}
          itemId={itemId}
        />
      ) : null}
      {state.status === "accepted" ? <CardActions input={state.input} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = theme.genui;
  return {
    root: {
      width: "100%",
      paddingVertical: GENUI_SPACE.sm,
    },
    acceptedStack: {
      gap: GENUI_SPACE.sm,
    },
    previewStack: {
      gap: GENUI_SPACE.sm,
    },
    previewItem: {
      gap: GENUI_SPACE.xs,
    },
    loadingBlock: {
      height: 64,
      borderRadius: GENUI_RADIUS.lg,
      backgroundColor: colors.loading,
      opacity: 0.6,
    },
    actionsStack: {
      gap: GENUI_SPACE.sm,
    },
    followUps: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: GENUI_SPACE.sm,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: GENUI_SPACE.xs,
    },
    actionText: {
      ...GENUI_TEXT.xs,
      color: colors.textTertiary,
    },
  };
});
