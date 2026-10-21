import { useCallback, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { genuiStyles } from "../styles";
import { GENUI_LEGEND_DOT, GENUI_SPACE, getSeriesColor, type GenuiColors } from "../tokens";
import { chartHeightForWidth } from "../chart-layout";

export interface LegendEntry {
  key: string;
  label: string;
  colorIndex: number;
}

interface ChartFrameProps {
  description?: string;
  unit?: string;
  legend: readonly LegendEntry[];
  colors: GenuiColors;
  accessibilityLabel: string;
  // Plot height for a measured width; defaults to the spec chart height.
  heightForWidth?: (width: number) => number;
  children: (size: { width: number; height: number }) => ReactNode;
}

// Measures the available width, reserves the spec chart height before the first layout,
// and draws the caption above and the legend below the plot.
export function ChartFrame({
  description,
  unit,
  legend,
  colors,
  accessibilityLabel,
  heightForWidth = chartHeightForWidth,
  children,
}: ChartFrameProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === next ? current : next));
  }, []);
  const caption = [description, unit ? t("genui.unit", { unit }) : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const height = width > 0 ? heightForWidth(width) : 0;

  return (
    <View style={styles.root}>
      {caption ? <Text style={genuiStyles.caption}>{caption}</Text> : null}
      <View
        style={[styles.plot, height > 0 ? { height, minHeight: height } : null]}
        onLayout={handleLayout}
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      >
        {width > 0 ? children({ width, height }) : null}
      </View>
      {legend.length > 0 ? (
        <View style={styles.legend}>
          {legend.map((entry) => {
            const series = getSeriesColor(colors, entry.colorIndex);
            return (
              <View key={entry.key} style={styles.legendItem}>
                <View
                  style={[
                    styles.legendDot,
                    { backgroundColor: series.color, opacity: series.opacity },
                  ]}
                />
                <Text style={genuiStyles.bodySmall}>{entry.label}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: GENUI_SPACE.sm,
  },
  plot: {
    width: "100%",
    minHeight: 280,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: GENUI_SPACE.xs,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  legendDot: {
    width: GENUI_LEGEND_DOT,
    height: GENUI_LEGEND_DOT,
    borderRadius: GENUI_LEGEND_DOT / 2,
  },
});
