import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  computeProgress,
  DEFAULT_CHANGE_PERCENT_PRECISION,
} from "@getpaseo/protocol/genui/compute";
import { deriveRenderUiValues } from "@getpaseo/protocol/genui/render-ui-validate";
import type {
  ChangeIntent,
  MetricComparisonData,
  MetricComparisonItem,
  MetricData,
  ProgressData,
} from "@getpaseo/protocol/genui/render-ui-schema";
import { formatSignedPercent, formatWithUnit } from "../format";
import { genuiStyles } from "../styles";
import { GENUI_SPACE, type GenuiColors } from "../tokens";

interface MetricTileProps {
  label: string;
  value: number;
  unit?: string;
  detail?: string;
}

export function MetricTile({ label, value, unit, detail }: MetricTileProps) {
  return (
    <View style={genuiStyles.subBlock} testID="genui-metric-tile">
      <Text style={genuiStyles.label}>{label}</Text>
      <Text style={genuiStyles.metricValue}>{formatWithUnit(value, unit)}</Text>
      {detail ? <Text style={genuiStyles.secondarySmall}>{detail}</Text> : null}
    </View>
  );
}

export function MetricView({ data }: { data: MetricData }) {
  return <MetricTile label={data.label} value={data.value} unit={data.unit} detail={data.detail} />;
}

export function MetricTilePair({ items }: { items: readonly MetricComparisonItem[] }) {
  return (
    <View style={genuiStyles.wrapRow}>
      {items.map((item) => (
        <View key={item.id} style={genuiStyles.wrapItem}>
          <MetricTile label={item.label} value={item.value} unit={item.unit} detail={item.detail} />
        </View>
      ))}
    </View>
  );
}

function intentColor(colors: GenuiColors, intent: ChangeIntent | undefined): string {
  if (intent === "bad") {
    return colors.danger;
  }
  if (intent === "good") {
    return colors.success;
  }
  return colors.textSecondary;
}

interface BarProps {
  ratio: number;
  color: string;
}

// Track plus a semantic fill at 85% opacity. The ratio is clamped for drawing only.
export function MeterBar({ ratio, color }: BarProps) {
  const width = `${Math.max(0, Math.min(1, ratio)) * 100}%` as const;
  return (
    <View style={genuiStyles.track}>
      <View style={[styles.fill, { width, backgroundColor: color }]} />
    </View>
  );
}

export function MetricComparisonView({
  data,
  colors,
}: {
  data: MetricComparisonData;
  colors: GenuiColors;
}) {
  const { t } = useTranslation();
  const derived = deriveRenderUiValues({ type: "metricComparison", data });
  const from = data.items.find((item) => item.id === data.compare.from);
  const to = data.items.find((item) => item.id === data.compare.to);
  const color = intentColor(colors, data.compare.changeIntent);
  const changePercent = "changePercent" in derived ? derived.changePercent : null;
  const precision = data.compare.precision ?? DEFAULT_CHANGE_PERCENT_PRECISION;
  return (
    <View style={styles.stack}>
      <MetricTilePair items={data.items} />
      <View style={styles.changeRow}>
        <Text style={[genuiStyles.secondarySmall, styles.changeLabel]} numberOfLines={2}>
          {t("genui.changeLabel", { from: from?.label ?? "", to: to?.label ?? "" })}
        </Text>
        {changePercent === null ? (
          <Text style={genuiStyles.secondarySmall}>{t("genui.zeroBaseline")}</Text>
        ) : (
          <Text style={[styles.changeValue, { color }]} testID="genui-change-percent">
            {formatSignedPercent(changePercent, precision)}
          </Text>
        )}
      </View>
      {changePercent === null ? null : (
        <MeterBar ratio={Math.abs(changePercent) / 100} color={color} />
      )}
    </View>
  );
}

export function ProgressView({ data, colors }: { data: ProgressData; colors: GenuiColors }) {
  const { ratio, percent } = computeProgress(data);
  return (
    <View style={styles.stack}>
      <View style={styles.changeRow}>
        <Text style={[genuiStyles.bodySmall, styles.changeLabel]}>{data.label}</Text>
        <Text style={genuiStyles.numberSmall}>{`${percent}%`}</Text>
      </View>
      <MeterBar ratio={ratio} color={colors.progressFill} />
      <Text style={genuiStyles.secondarySmall}>
        {`${formatWithUnit(data.current, data.unit)} / ${formatWithUnit(data.total, data.unit)}`}
        {data.detail ? ` · ${data.detail}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: GENUI_SPACE.sm,
  },
  changeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: GENUI_SPACE.sm,
  },
  changeLabel: {
    flexShrink: 1,
  },
  changeValue: {
    fontSize: 18,
    lineHeight: 28,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  fill: {
    height: "100%",
    borderRadius: 9999,
    opacity: 0.85,
  },
});
