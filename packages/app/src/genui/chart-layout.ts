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

// Horizontal counterpart of roundedBarPath: the end away from the baseline is rounded.
export function roundedHorizontalBarPath(input: {
  y: number;
  height: number;
  valueX: number;
  baselineX: number;
  radius: number;
}): string {
  const { y, height } = input;
  const left = Math.min(input.valueX, input.baselineX);
  const right = Math.max(input.valueX, input.baselineX);
  const width = right - left;
  const r = Math.max(0, Math.min(input.radius, height / 2, width));
  const bottom = y + height;
  if (input.valueX >= input.baselineX) {
    return [
      `M${left},${y}`,
      `L${right - r},${y}`,
      `Q${right},${y} ${right},${y + r}`,
      `L${right},${bottom - r}`,
      `Q${right},${bottom} ${right - r},${bottom}`,
      `L${left},${bottom}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${right},${y}`,
    `L${left + r},${y}`,
    `Q${left},${y} ${left},${y + r}`,
    `L${left},${bottom - r}`,
    `Q${left},${bottom} ${left + r},${bottom}`,
    `L${right},${bottom}`,
    "Z",
  ].join(" ");
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

const CJK_PATTERN = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;
const LATIN_CHAR_RATIO = 0.6;
const LINE_HEIGHT_RATIO = 1.25;
const MAX_LABEL_LINES = 2;
const ROTATED_MAX_WIDTH = 96;
const ROTATED_SIN = Math.SQRT1_2;

// SVG text cannot be measured before it is drawn on every platform, so widths are
// estimated: full-width (CJK) glyphs are about one em, Latin about 0.6 em.
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += CJK_PATTERN.test(char) ? fontSize : fontSize * LATIN_CHAR_RATIO;
  }
  return width;
}

function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) {
    return text;
  }
  let result = "";
  for (const char of text) {
    if (estimateTextWidth(`${result}${char}…`, fontSize) > maxWidth) {
      break;
    }
    result += char;
  }
  return `${result}…`;
}

// Latin words stay whole; CJK breaks between any two characters.
function tokenize(text: string): string[] {
  return (
    text.match(
      /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+\s*|\s+/gu,
    ) ?? []
  );
}

// A token wider than the line, such as a file path, breaks after its separators and
// then between characters, so it can fill the second line instead of being cut short.
function splitLongToken(token: string, maxWidth: number, fontSize: number): string[] {
  if (estimateTextWidth(token.trimEnd(), fontSize) <= maxWidth) {
    return [token];
  }
  const pieces = token.match(/[^/\\._-]+[/\\._-]*|[/\\._-]+/g) ?? [token];
  const result: string[] = [];
  for (const piece of pieces) {
    if (estimateTextWidth(piece, fontSize) <= maxWidth) {
      result.push(piece);
      continue;
    }
    let chunk = "";
    for (const char of piece) {
      if (chunk && estimateTextWidth(`${chunk}${char}`, fontSize) > maxWidth) {
        result.push(chunk);
        chunk = "";
      }
      chunk += char;
    }
    if (chunk) {
      result.push(chunk);
    }
  }
  return result;
}

function wrapLabel(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let current = "";
  const tokens = tokenize(text).flatMap((token) => splitLongToken(token, maxWidth, fontSize));
  for (const token of tokens) {
    const candidate = `${current}${token}`;
    if (current && estimateTextWidth(candidate.trimEnd(), fontSize) > maxWidth) {
      lines.push(current.trimEnd());
      current = token.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    lines.push(current.trimEnd());
  }
  if (lines.length <= MAX_LABEL_LINES) {
    return lines.map((line) => truncateToWidth(line, maxWidth, fontSize));
  }
  const kept = lines.slice(0, MAX_LABEL_LINES - 1);
  const rest = lines.slice(MAX_LABEL_LINES - 1).join(" ");
  return [...kept, truncateToWidth(rest, maxWidth, fontSize)].map((line) =>
    truncateToWidth(line, maxWidth, fontSize),
  );
}

export type CategoryLabelLayout =
  | { mode: "horizontal"; lines: string[][]; bandHeight: number }
  | { mode: "rotated"; labels: string[]; bandHeight: number };

// Every category keeps its label. Labels wrap to two lines under their slot; when slots
// are too narrow for two full-width characters, all labels turn 45° instead.
export function layoutCategoryLabels(input: {
  labels: readonly string[];
  slotWidth: number;
  fontSize: number;
}): CategoryLabelLayout {
  const { labels, slotWidth, fontSize } = input;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const maxWidth = slotWidth - 4;
  if (maxWidth >= fontSize * 2) {
    const lines = labels.map((label) => wrapLabel(label, maxWidth, fontSize));
    const lineCount = Math.max(1, ...lines.map((label) => label.length));
    return { mode: "horizontal", lines, bandHeight: Math.ceil(12 + lineHeight * lineCount) };
  }
  const truncated = labels.map((label) => truncateToWidth(label, ROTATED_MAX_WIDTH, fontSize));
  const widest = Math.max(0, ...truncated.map((label) => estimateTextWidth(label, fontSize)));
  return {
    mode: "rotated",
    labels: truncated,
    bandHeight: Math.ceil(12 + widest * ROTATED_SIN + fontSize),
  };
}

function isLabelShortened(label: string, lines: readonly string[]): boolean {
  return lines.some((line) => line.endsWith("…")) && !label.endsWith("…");
}

// Vertical bars stay the default; a chart whose category labels would turn 45° or lose
// characters under their bars reads better lying down. plotWidth is the width left of
// the value axis labels.
export function prefersHorizontalBars(input: {
  labels: readonly string[];
  plotWidth: number;
  fontSize: number;
  maxRows: number;
}): boolean {
  if (input.labels.length === 0 || input.labels.length > input.maxRows) {
    return false;
  }
  const layout = layoutCategoryLabels({
    labels: input.labels,
    slotWidth: input.plotWidth / input.labels.length,
    fontSize: input.fontSize,
  });
  if (layout.mode === "rotated") {
    return true;
  }
  return input.labels.some((label, index) => isLabelShortened(label, layout.lines[index] ?? []));
}

const HORIZONTAL_BAR_THICKNESS = 14;
const HORIZONTAL_BAR_GAP = 4;
const HORIZONTAL_BAND_PADDING = 14;
const HORIZONTAL_LABEL_MAX_SHARE = 0.4;

export interface HorizontalBarLayout {
  bandHeight: number;
  barThickness: number;
  barGap: number;
  labelWidth: number;
  labelLines: string[][];
}

// Each category gets a band tall enough for its bars or its two-line label, whichever is
// taller. Labels sit left of the plot and take at most 40% of the width.
export function layoutHorizontalBars(input: {
  labels: readonly string[];
  seriesCount: number;
  width: number;
  fontSize: number;
}): HorizontalBarLayout {
  const { labels, seriesCount, width, fontSize } = input;
  const maxLabelWidth = Math.max(fontSize * 4, width * HORIZONTAL_LABEL_MAX_SHARE);
  const widest = Math.max(0, ...labels.map((label) => estimateTextWidth(label, fontSize)));
  const labelWidth = Math.ceil(Math.min(maxLabelWidth, widest));
  const labelLines = labels.map((label) => wrapLabel(label, labelWidth, fontSize));
  const lineCount = Math.max(1, ...labelLines.map((lines) => lines.length));
  const barsHeight =
    seriesCount * HORIZONTAL_BAR_THICKNESS + (seriesCount - 1) * HORIZONTAL_BAR_GAP;
  const labelHeight = lineCount * fontSize * LINE_HEIGHT_RATIO;
  return {
    bandHeight: Math.ceil(Math.max(barsHeight, labelHeight) + HORIZONTAL_BAND_PADDING),
    barThickness: HORIZONTAL_BAR_THICKNESS,
    barGap: HORIZONTAL_BAR_GAP,
    labelWidth,
    labelLines,
  };
}

const TABLE_FONT_SIZE = 14;
const TABLE_CELL_PADDING = 16;
const TABLE_MIN_COLUMN = 72;
const TABLE_MAX_COLUMN = 240;
// Header cells are semibold, which runs a little wider than the estimate.
const TABLE_HEADER_WIDTH_FACTOR = 1.1;

export interface TableColumnWidth {
  // Narrowest the column can get without breaking a word: its longest token.
  min: number;
  // Width that fits the widest cell on one line.
  preferred: number;
}

function clampColumn(width: number): number {
  return Math.round(Math.min(TABLE_MAX_COLUMN, Math.max(TABLE_MIN_COLUMN, width)));
}

// Columns start at the width that fits their widest cell and shrink toward their longest
// unbreakable token, so CJK text wraps before the table scrolls and a long word such as
// "metricComparison" is never clipped.
export function estimateTableColumnWidths(input: {
  headers: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
}): TableColumnWidth[] {
  return input.headers.map((header, columnIndex) => {
    const texts = [header, ...input.rows.map((row) => row[columnIndex] ?? "")];
    const widthOf = (text: string, factor: number) =>
      estimateTextWidth(text.trim(), TABLE_FONT_SIZE) * factor;
    const factorFor = (index: number) => (index === 0 ? TABLE_HEADER_WIDTH_FACTOR : 1);
    const preferred = Math.max(...texts.map((text, index) => widthOf(text, factorFor(index))));
    const longestToken = Math.max(
      ...texts.flatMap((text, index) =>
        tokenize(text).map((token) => widthOf(token, factorFor(index))),
      ),
    );
    const min = clampColumn(longestToken + TABLE_CELL_PADDING);
    return { min, preferred: Math.max(min, clampColumn(preferred + TABLE_CELL_PADDING)) };
  });
}
