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
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { RenderUiInput, RenderUiType } from "@getpaseo/protocol/genui/render-ui-schema";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { MetricTilePair } from "./components/metric-views";
import { withContentKeys } from "./keyed";
import { buildRenderUiDataText, buildRenderUiPlainText } from "./plain-text";
import type { RenderUiCardState, RenderUiPreview } from "./render-ui-call";
import { RenderUiNodeView } from "./render-ui-node";
import { genuiStyles } from "./styles";
import { GENUI_RADIUS, GENUI_SPACE, GENUI_TEXT, getGenuiColors, type GenuiColors } from "./tokens";

const COPIED_RESET_MS = 1500;

// Skeleton heights double as the card's minimum height. They are deliberately close to
// the smallest real card of each type so the accepted card grows into place.
const ESTIMATED_HEIGHT: Record<RenderUiType, number> = {
  metricComparison: 200,
  metric: 104,
  progress: 72,
  "chart.bar": 320,
  "chart.line": 320,
  "chart.pie": 320,
  table: 150,
  priorityList: 200,
  card: 200,
  grid: 120,
};
const UNKNOWN_TYPE_ESTIMATE = 120;

function genuiColorsFromTheme(theme: Theme): { colors: GenuiColors } {
  return { colors: getGenuiColors(theme.colorScheme) };
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
        <Pressable onPress={handleCopy} accessibilityRole="button" hitSlop={8} testID="genui-copy">
          <Text style={styles.actionText}>{copied ? t("genui.copied") : t("genui.copy")}</Text>
        </Pressable>
        <Pressable
          onPress={toggleData}
          accessibilityRole="button"
          accessibilityState={dataButtonState}
          hitSlop={8}
          testID="genui-view-data"
        >
          <Text style={styles.actionText}>
            {showData ? t("genui.hideData") : t("genui.viewData")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function AcceptedCard({ input }: { input: RenderUiInput }) {
  const { t } = useTranslation();
  return (
    <View style={styles.acceptedStack}>
      <RenderUiErrorBoundary fallbackText={buildRenderUiPlainText(input) || t("genui.renderError")}>
        <AcceptedBody input={input} uniProps={genuiColorsFromTheme} />
      </RenderUiErrorBoundary>
      <CardActions input={input} />
    </View>
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

// One render_ui call in the timeline. Height only grows while generating and once
// accepted, so the list never jumps; a rejected call collapses to nothing.
export function RenderUiCard({ state }: { state: RenderUiCardState }) {
  const { t } = useTranslation();
  const [minHeight, setMinHeight] = useState(() => estimateHeight(state));
  const estimate = estimateHeight(state);
  useEffect(() => {
    setMinHeight((current) => Math.max(current, estimate));
  }, [estimate]);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setMinHeight((current) => (height > current ? height : current));
  }, []);

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
      style={[styles.root, { minHeight }]}
      onLayout={handleLayout}
      testID={state.status === "accepted" ? "genui-card" : "genui-card-generating"}
      accessibilityLabel={state.status === "generating" ? t("genui.generating") : undefined}
    >
      {state.status === "accepted" ? (
        <AcceptedCard input={state.input} />
      ) : (
        <PreviewBody preview={state.preview} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = getGenuiColors(theme.colorScheme);
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
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: GENUI_SPACE.lg,
    },
    actionText: {
      ...GENUI_TEXT.xs,
      color: colors.textTertiary,
    },
  };
});
