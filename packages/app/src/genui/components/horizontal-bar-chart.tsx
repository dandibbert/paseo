import Svg, { Line, Path, Text as SvgText, TSpan } from "react-native-svg";
import type { BarChartData } from "@getpaseo/protocol/genui/render-ui-schema";
import {
  buildValueAxis,
  layoutHorizontalBars,
  roundedHorizontalBarPath,
  type AxisScale,
  type HorizontalBarLayout,
} from "../chart-layout";
import { formatAxisTick, formatCell } from "../format";
import { GENUI_BAR_TOP_RADIUS, getSeriesColor, type GenuiColors } from "../tokens";

export const HORIZONTAL_TICK_FONT_SIZE = 12;
const PLOT_TOP = 4;
const LABEL_GAP = 10;
const AXIS_BAND = 24;
const RIGHT_PADDING = 12;
const LABEL_LINE_HEIGHT = 15;

interface Geometry {
  layout: HorizontalBarLayout;
  axis: AxisScale;
  left: number;
  right: number;
  plotBottom: number;
}

function readValues(data: BarChartData): number[] {
  return data.rows.flatMap((row) =>
    data.series
      .map((series) => row[series.field])
      .filter((value): value is number => typeof value === "number"),
  );
}

function buildGeometry(data: BarChartData, width: number): Geometry {
  const layout = layoutHorizontalBars({
    labels: data.rows.map((row) => formatCell(row[data.x])),
    seriesCount: data.series.length,
    width,
    fontSize: HORIZONTAL_TICK_FONT_SIZE,
  });
  return {
    layout,
    axis: buildValueAxis(readValues(data)),
    left: layout.labelWidth + LABEL_GAP,
    right: width - RIGHT_PADDING,
    plotBottom: PLOT_TOP + layout.bandHeight * data.rows.length,
  };
}

// Height of the whole horizontal chart at this width: one band per row plus the axis.
export function horizontalBarChartHeight(data: BarChartData, width: number): number {
  return buildGeometry(data, width).plotBottom + AXIS_BAND;
}

function scaleX(geometry: Geometry, value: number): number {
  const { axis, left, right } = geometry;
  return left + ((value - axis.min) / (axis.max - axis.min)) * (right - left);
}

function ValueAxis({ geometry, colors }: { geometry: Geometry; colors: GenuiColors }) {
  const lastIndex = geometry.axis.ticks.length - 1;
  return geometry.axis.ticks.flatMap((tick, index) => {
    const x = scaleX(geometry, tick);
    // The last tick sits on the right edge, so it is right-aligned to stay inside the plot.
    const isLast = index === lastIndex;
    return [
      <Line
        key={`grid-${tick}`}
        x1={x}
        x2={x}
        y1={PLOT_TOP}
        y2={geometry.plotBottom}
        stroke={colors.gridLine}
        strokeWidth={1}
        strokeDasharray="3 3"
      />,
      <SvgText
        key={`tick-${tick}`}
        x={isLast ? x + 6 : x}
        y={geometry.plotBottom + 16}
        fontSize={HORIZONTAL_TICK_FONT_SIZE}
        fill={colors.textSecondary}
        textAnchor={isLast ? "end" : "middle"}
      >
        {formatAxisTick(tick)}
      </SvgText>,
    ];
  });
}

function CategoryLabels({ geometry, colors }: { geometry: Geometry; colors: GenuiColors }) {
  const { layout } = geometry;
  return layout.labelLines.map((lines, rowIndex) => {
    const center = PLOT_TOP + layout.bandHeight * (rowIndex + 0.5);
    const firstBaseline =
      center - ((lines.length - 1) * LABEL_LINE_HEIGHT) / 2 + HORIZONTAL_TICK_FONT_SIZE / 3;
    const x = layout.labelWidth;
    return (
      <SvgText
        key={`label-${center}`}
        x={x}
        y={firstBaseline}
        fontSize={HORIZONTAL_TICK_FONT_SIZE}
        fill={colors.textSecondary}
        textAnchor="end"
      >
        {lines.map((line, lineIndex) => (
          <TSpan key={`${center}-${line}`} x={x} dy={lineIndex === 0 ? 0 : LABEL_LINE_HEIGHT}>
            {line}
          </TSpan>
        ))}
      </SvgText>
    );
  });
}

function Bars({
  geometry,
  data,
  colors,
}: {
  geometry: Geometry;
  data: BarChartData;
  colors: GenuiColors;
}) {
  const { layout } = geometry;
  const seriesCount = data.series.length;
  const groupHeight = seriesCount * layout.barThickness + (seriesCount - 1) * layout.barGap;
  const baselineX = scaleX(geometry, 0);
  return data.rows.flatMap((row, rowIndex) => {
    const groupTop =
      PLOT_TOP + layout.bandHeight * rowIndex + (layout.bandHeight - groupHeight) / 2;
    return data.series.map((series, seriesIndex) => {
      const value = row[series.field];
      if (typeof value !== "number") {
        return null;
      }
      const { color, opacity } = getSeriesColor(colors, seriesIndex);
      return (
        <Path
          key={`${rowIndex}-${series.field}`}
          d={roundedHorizontalBarPath({
            y: groupTop + seriesIndex * (layout.barThickness + layout.barGap),
            height: layout.barThickness,
            valueX: scaleX(geometry, value),
            baselineX,
            radius: GENUI_BAR_TOP_RADIUS,
          })}
          fill={color}
          opacity={opacity}
        />
      );
    });
  });
}

export function HorizontalBarChart({
  data,
  colors,
  width,
  height,
}: {
  data: BarChartData;
  colors: GenuiColors;
  width: number;
  height: number;
}) {
  const geometry = buildGeometry(data, width);
  return (
    <Svg width={width} height={height}>
      <ValueAxis geometry={geometry} colors={colors} />
      <CategoryLabels geometry={geometry} colors={colors} />
      <Bars geometry={geometry} data={data} colors={colors} />
    </Svg>
  );
}
