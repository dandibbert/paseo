import { useId } from "react";
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { CartesianChartData } from "@getpaseo/protocol/genui/render-ui-schema";
import {
  buildValueAxis,
  lineSegments,
  roundedBarPath,
  scaleValue,
  visibleLabelIndices,
  type AxisScale,
} from "../chart-layout";
import { formatAxisTick, formatCell } from "../format";
import {
  GENUI_BAR_GAP,
  GENUI_BAR_TOP_RADIUS,
  GENUI_LINE_POINT_RADIUS,
  GENUI_LINE_WIDTH,
  getSeriesColor,
  type GenuiColors,
} from "../tokens";
import { ChartFrame } from "./chart-frame";

const TICK_FONT_SIZE = 12;
const APPROX_CHAR_WIDTH = 7;
const X_LABEL_BAND = 28;
const PLOT_TOP = 10;
const AXIS_LABEL_GAP = 10;
const MAX_BAR_WIDTH = 160;
const GROUP_FILL = 0.84;

interface PlotGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  axis: AxisScale;
  slot: number;
}

function readNumericValues(data: CartesianChartData): number[] {
  const values: number[] = [];
  for (const row of data.rows) {
    for (const series of data.series) {
      const value = row[series.field];
      if (typeof value === "number") {
        values.push(value);
      }
    }
  }
  return values;
}

function buildGeometry(input: {
  data: CartesianChartData;
  width: number;
  height: number;
}): PlotGeometry {
  const axis = buildValueAxis(readNumericValues(input.data));
  const longestTick = Math.max(...axis.ticks.map((tick) => formatAxisTick(tick).length));
  const left = longestTick * APPROX_CHAR_WIDTH + AXIS_LABEL_GAP;
  const right = input.width;
  const bottom = input.height - X_LABEL_BAND;
  return {
    left,
    right,
    top: PLOT_TOP,
    bottom,
    axis,
    slot: (right - left) / input.data.rows.length,
  };
}

function truncateLabel(text: string, maxWidth: number): string {
  const maxChars = Math.max(1, Math.floor(maxWidth / APPROX_CHAR_WIDTH));
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

function AxisLayer({
  geometry,
  data,
  colors,
}: {
  geometry: PlotGeometry;
  data: CartesianChartData;
  colors: GenuiColors;
}) {
  const labelIndices = visibleLabelIndices({
    count: data.rows.length,
    slotWidth: geometry.slot,
    minLabelWidth: 56,
  });
  const labelWidth = geometry.slot * (labelIndices[1] ?? data.rows.length) - 4;
  return (
    <>
      {geometry.axis.ticks.map((tick) => {
        const y = scaleValue({
          value: tick,
          axis: geometry.axis,
          top: geometry.top,
          bottom: geometry.bottom,
        });
        return [
          <Line
            key={`grid-${tick}`}
            x1={geometry.left}
            x2={geometry.right}
            y1={y}
            y2={y}
            stroke={colors.gridLine}
            strokeWidth={1}
            strokeDasharray="3 3"
          />,
          <SvgText
            key={`tick-${tick}`}
            x={geometry.left - AXIS_LABEL_GAP}
            y={y + 4}
            fontSize={TICK_FONT_SIZE}
            fill={colors.textSecondary}
            textAnchor="end"
          >
            {formatAxisTick(tick)}
          </SvgText>,
        ];
      })}
      {labelIndices.map((index) => (
        <SvgText
          key={`x-${index}`}
          x={geometry.left + geometry.slot * (index + 0.5)}
          y={geometry.bottom + 20}
          fontSize={TICK_FONT_SIZE}
          fill={colors.textSecondary}
          textAnchor="middle"
        >
          {truncateLabel(formatCell(data.rows[index]?.[data.x]), labelWidth)}
        </SvgText>
      ))}
    </>
  );
}

function BarLayer({
  geometry,
  data,
  colors,
  gradientPrefix,
}: {
  geometry: PlotGeometry;
  data: CartesianChartData;
  colors: GenuiColors;
  gradientPrefix: string;
}) {
  const seriesCount = data.series.length;
  const groupWidth = geometry.slot * GROUP_FILL;
  const barWidth = Math.min(
    MAX_BAR_WIDTH,
    Math.max(1, (groupWidth - GENUI_BAR_GAP * (seriesCount - 1)) / seriesCount),
  );
  const usedWidth = barWidth * seriesCount + GENUI_BAR_GAP * (seriesCount - 1);
  const baselineY = scaleValue({
    value: 0,
    axis: geometry.axis,
    top: geometry.top,
    bottom: geometry.bottom,
  });
  return (
    <>
      <Defs>
        {data.series.map((series, index) => {
          const { color } = getSeriesColor(colors, index);
          return (
            <LinearGradient
              key={series.field}
              id={`${gradientPrefix}-${index}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <Stop offset="0" stopColor={color} stopOpacity={1} />
              <Stop offset="1" stopColor={color} stopOpacity={0.88} />
            </LinearGradient>
          );
        })}
      </Defs>
      {data.rows.map((row, rowIndex) => {
        const groupLeft =
          geometry.left + geometry.slot * rowIndex + (geometry.slot - usedWidth) / 2;
        return data.series.map((series, seriesIndex) => {
          const value = row[series.field];
          if (typeof value !== "number") {
            return null;
          }
          const { color, opacity } = getSeriesColor(colors, seriesIndex);
          const valueY = scaleValue({
            value,
            axis: geometry.axis,
            top: geometry.top,
            bottom: geometry.bottom,
          });
          return (
            <Path
              key={`${rowIndex}-${series.field}`}
              d={roundedBarPath({
                x: groupLeft + seriesIndex * (barWidth + GENUI_BAR_GAP),
                width: barWidth,
                valueY,
                baselineY,
                radius: GENUI_BAR_TOP_RADIUS,
              })}
              fill={`url(#${gradientPrefix}-${seriesIndex})`}
              stroke={color}
              strokeWidth={1}
              opacity={opacity}
            />
          );
        });
      })}
    </>
  );
}

function LineLayer({
  geometry,
  data,
  colors,
}: {
  geometry: PlotGeometry;
  data: CartesianChartData;
  colors: GenuiColors;
}) {
  return (
    <>
      {data.series.map((series, seriesIndex) => {
        const { color, opacity } = getSeriesColor(colors, seriesIndex);
        const points = data.rows.map((row, rowIndex) => {
          const value = row[series.field];
          return {
            x: geometry.left + geometry.slot * (rowIndex + 0.5),
            y:
              typeof value === "number"
                ? scaleValue({
                    value,
                    axis: geometry.axis,
                    top: geometry.top,
                    bottom: geometry.bottom,
                  })
                : null,
          };
        });
        const segments = lineSegments(points);
        return [
          ...segments.map((segment) => (
            <Path
              key={`${series.field}-line-${segment[0].x}`}
              d={segment
                .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
                .join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={GENUI_LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={opacity}
            />
          )),
          ...segments
            .flat()
            .map((point) => (
              <Circle
                key={`${series.field}-point-${point.x}`}
                cx={point.x}
                cy={point.y}
                r={GENUI_LINE_POINT_RADIUS}
                fill={color}
                opacity={opacity}
              />
            )),
        ];
      })}
    </>
  );
}

function describeChart(data: CartesianChartData): string {
  return data.rows
    .map(
      (row) =>
        `${formatCell(row[data.x])}: ${data.series
          .map((series) => `${series.label} ${formatCell(row[series.field])}`)
          .join(", ")}`,
    )
    .join("; ");
}

export function CartesianChartView({
  kind,
  data,
  colors,
}: {
  kind: "bar" | "line";
  data: CartesianChartData;
  colors: GenuiColors;
}) {
  const gradientPrefix = `genui-bar-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const legend = data.series.map((series, index) => ({
    key: series.field,
    label: series.label,
    colorIndex: index,
  }));
  return (
    <ChartFrame
      description={data.description}
      unit={data.yUnit}
      legend={legend}
      colors={colors}
      accessibilityLabel={describeChart(data)}
    >
      {({ width, height }) => {
        const geometry = buildGeometry({ data, width, height });
        return (
          <Svg width={width} height={height}>
            <AxisLayer geometry={geometry} data={data} colors={colors} />
            {kind === "bar" ? (
              <BarLayer
                geometry={geometry}
                data={data}
                colors={colors}
                gradientPrefix={gradientPrefix}
              />
            ) : (
              <LineLayer geometry={geometry} data={data} colors={colors} />
            )}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
