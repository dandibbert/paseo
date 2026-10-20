import {
  GENUI_CHART_MIN_HEIGHT,
  GENUI_CHART_NARROW_RATIO,
  GENUI_CHART_WIDE_BREAKPOINT,
  GENUI_CHART_WIDE_HEIGHT,
} from "./tokens";

export function chartHeightForWidth(width: number): number {
  if (width >= GENUI_CHART_WIDE_BREAKPOINT) {
    return GENUI_CHART_WIDE_HEIGHT;
  }
  return Math.max(GENUI_CHART_MIN_HEIGHT, Math.round(width * GENUI_CHART_NARROW_RATIO));
}

export interface AxisScale {
  min: number;
  max: number;
  ticks: number[];
}

function niceStep(rawStep: number): number {
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / 10 ** exponent;
  const niceFraction = [1, 2, 2.5, 5].find((candidate) => fraction <= candidate) ?? 10;
  return niceFraction * 10 ** exponent;
}

// A zero-anchored axis covering every value with roughly `targetTicks` round steps.
// Bars must start at zero to be honest, so zero is always inside the domain.
export function buildValueAxis(values: readonly number[], targetTicks = 5): AxisScale {
  const dataMin = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values);
  if (dataMin === dataMax) {
    return { min: 0, max: 1, ticks: [0, 1] };
  }
  const step = niceStep((dataMax - dataMin) / Math.max(1, targetTicks - 1));
  const min = Math.floor(dataMin / step) * step;
  const max = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return { min, max, ticks };
}

export function scaleValue(input: {
  value: number;
  axis: AxisScale;
  top: number;
  bottom: number;
}): number {
  const { value, axis, top, bottom } = input;
  return bottom - ((value - axis.min) / (axis.max - axis.min)) * (bottom - top);
}

// Path for a bar whose end away from the baseline is rounded. Positive bars round the
// top, negative bars round the bottom. The radius shrinks to fit short or thin bars.
export function roundedBarPath(input: {
  x: number;
  width: number;
  valueY: number;
  baselineY: number;
  radius: number;
}): string {
  const { x, width } = input;
  const top = Math.min(input.valueY, input.baselineY);
  const bottom = Math.max(input.valueY, input.baselineY);
  const height = bottom - top;
  const r = Math.max(0, Math.min(input.radius, width / 2, height));
  const right = x + width;
  if (input.valueY <= input.baselineY) {
    return [
      `M${x},${bottom}`,
      `L${x},${top + r}`,
      `Q${x},${top} ${x + r},${top}`,
      `L${right - r},${top}`,
      `Q${right},${top} ${right},${top + r}`,
      `L${right},${bottom}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${x},${top}`,
    `L${right},${top}`,
    `L${right},${bottom - r}`,
    `Q${right},${bottom} ${right - r},${bottom}`,
    `L${x + r},${bottom}`,
    `Q${x},${bottom} ${x},${bottom - r}`,
    "Z",
  ].join(" ");
}

export interface PieSlicePath {
  path: string;
  startAngle: number;
  endAngle: number;
}

function polar(cx: number, cy: number, radius: number, angle: number): string {
  // Angles start at twelve o'clock and run clockwise.
  const x = cx + radius * Math.sin(angle);
  const y = cy - radius * Math.cos(angle);
  return `${Number(x.toFixed(3))},${Number(y.toFixed(3))}`;
}

export function pieSlicePaths(input: {
  ratios: readonly number[];
  cx: number;
  cy: number;
  radius: number;
}): PieSlicePath[] {
  const { cx, cy, radius } = input;
  let start = 0;
  return input.ratios.map((ratio) => {
    const sweep = ratio * Math.PI * 2;
    const end = start + sweep;
    const slice: PieSlicePath = { path: "", startAngle: start, endAngle: end };
    if (ratio >= 1) {
      // A single full slice cannot be drawn as one arc; draw two halves.
      slice.path = [
        `M${polar(cx, cy, radius, 0)}`,
        `A${radius},${radius} 0 1 1 ${polar(cx, cy, radius, Math.PI)}`,
        `A${radius},${radius} 0 1 1 ${polar(cx, cy, radius, 0)}`,
        "Z",
      ].join(" ");
    } else if (ratio > 0) {
      const largeArc = sweep > Math.PI ? 1 : 0;
      slice.path = [
        `M${cx},${cy}`,
        `L${polar(cx, cy, radius, start)}`,
        `A${radius},${radius} 0 ${largeArc} 1 ${polar(cx, cy, radius, end)}`,
        "Z",
      ].join(" ");
    }
    start = end;
    return slice;
  });
}

// Split a series into drawable runs; a null value breaks the line instead of dropping to 0.
export function lineSegments(
  points: ReadonlyArray<{ x: number; y: number | null }>,
): Array<Array<{ x: number; y: number }>> {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length > 0) {
        segments.push(current);
      }
      current = [];
      continue;
    }
    current.push({ x: point.x, y: point.y });
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

// Indices of category labels to draw so neighbours do not overlap.
export function visibleLabelIndices(input: {
  count: number;
  slotWidth: number;
  minLabelWidth: number;
}): number[] {
  const every = Math.max(1, Math.ceil(input.minLabelWidth / Math.max(1, input.slotWidth)));
  const indices: number[] = [];
  for (let index = 0; index < input.count; index += every) {
    indices.push(index);
  }
  return indices;
}
