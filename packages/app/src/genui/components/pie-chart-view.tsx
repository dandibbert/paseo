import Svg, { Path } from "react-native-svg";
import { computePieShares } from "@getpaseo/protocol/genui/compute";
import type { PieChartData } from "@getpaseo/protocol/genui/render-ui-schema";
import { readPieSlices } from "@getpaseo/protocol/genui/render-ui-validate";
import { pieSlicePaths } from "../chart-layout";
import { formatNumber } from "../format";
import { GENUI_PIE_SEPARATOR_WIDTH, getSeriesColor, type GenuiColors } from "../tokens";
import { ChartFrame } from "./chart-frame";

const PIE_INSET = 4;

export function PieChartView({ data, colors }: { data: PieChartData; colors: GenuiColors }) {
  const slices = readPieSlices(data);
  const { shares } = computePieShares(slices.map((slice) => slice.value));
  const legend = slices.map((slice, index) => ({
    key: `${index}-${slice.label}`,
    label: `${slice.label} ${formatNumber(shares[index].percent)}%`,
    colorIndex: index,
  }));
  return (
    <ChartFrame
      description={data.description}
      legend={legend}
      colors={colors}
      accessibilityLabel={legend.map((entry) => entry.label).join(", ")}
    >
      {({ width, height }) => {
        const size = Math.min(width, height);
        const radius = size / 2 - PIE_INSET;
        const paths = pieSlicePaths({
          ratios: shares.map((share) => share.ratio),
          cx: width / 2,
          cy: height / 2,
          radius,
        });
        return (
          <Svg width={width} height={height}>
            {paths.map((slice, index) => {
              if (!slice.path) {
                return null;
              }
              const { color, opacity } = getSeriesColor(colors, index);
              return (
                <Path
                  key={legend[index].key}
                  d={slice.path}
                  fill={color}
                  fillOpacity={opacity}
                  stroke={colors.pieSeparator}
                  strokeWidth={GENUI_PIE_SEPARATOR_WIDTH}
                  strokeLinejoin="round"
                />
              );
            })}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
