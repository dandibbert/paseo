// GenUI design tokens. Values come from design/genui/docs/genui-visual-spec.md (measured
// from ChatGPT web, light and dark). GenUI cards read only these tokens, never the Paseo
// palette; docs/design.md lists this as a deliberate exception. Sizes are shared by both
// schemes, colors switch with the active Paseo theme's colorScheme.

export type GenuiColorScheme = "light" | "dark";

export interface GenuiColors {
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  divider: string;
  surfaceSecondary: string;
  track: string;
  progressFill: string;
  danger: string;
  success: string;
  loading: string;
  gridLine: string;
  pieSeparator: string;
  series: readonly [string, string, string, string];
}

const LIGHT_COLORS: GenuiColors = {
  text: "#0D0D0D",
  textSecondary: "#5D5D5D",
  textTertiary: "#8F8F8F",
  border: "rgba(0,0,0,0.10)",
  divider: "rgba(0,0,0,0.10)",
  surfaceSecondary: "#FCFCFC",
  track: "#F3F3F3",
  progressFill: "rgba(42,163,106,0.85)",
  danger: "#E02E2A",
  success: "#008635",
  loading: "#E8F3FE",
  gridLine: "rgba(0,0,0,0.05)",
  pieSeparator: "#F3F3F3",
  series: ["#539AF8", "#6BC67F", "#EF8B57", "#F8D45D"],
};

const DARK_COLORS: GenuiColors = {
  text: "#EDEDED",
  textSecondary: "#CDCDCD",
  textTertiary: "#AFAFAF",
  border: "rgba(255,255,255,0.15)",
  divider: "rgba(255,255,255,0.05)",
  surfaceSecondary: "#0E0E0E",
  track: "#212121",
  progressFill: "rgba(42,163,106,0.85)",
  danger: "#FF6764",
  success: "#04B84C",
  loading: "#133463",
  gridLine: "rgba(255,255,255,0.05)",
  pieSeparator: "#303030",
  series: ["#1F4E94", "#3A843F", "#AC4F23", "#D9A337"],
};

export function getGenuiColors(scheme: GenuiColorScheme): GenuiColors {
  return scheme === "dark" ? DARK_COLORS : LIGHT_COLORS;
}

export const GENUI_SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const GENUI_RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const GENUI_TEXT = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  md: { fontSize: 16, lineHeight: 26 },
  titleMd: { fontSize: 16, lineHeight: 26, fontWeight: "600" },
  titleLg: { fontSize: 18, lineHeight: 28, fontWeight: "600" },
  title2xl: { fontSize: 24, lineHeight: 32, fontWeight: "600" },
} as const;

export const GENUI_BAR_HEIGHT = 7;
export const GENUI_CHART_WIDE_BREAKPOINT = 600;
export const GENUI_CHART_WIDE_HEIGHT = 432;
export const GENUI_CHART_NARROW_RATIO = 0.72;
export const GENUI_CHART_MIN_HEIGHT = 280;
export const GENUI_BAR_TOP_RADIUS = 8;
export const GENUI_BAR_GAP = 4;
export const GENUI_LINE_WIDTH = 2;
export const GENUI_LINE_POINT_RADIUS = 4.5;
export const GENUI_PIE_SEPARATOR_WIDTH = 2;
export const GENUI_LEGEND_DOT = 10;

// Color for a series index. After the four measured colors the palette repeats; the
// repeat is drawn at reduced opacity so neighbouring slices stay distinguishable.
export function getSeriesColor(
  colors: GenuiColors,
  index: number,
): { color: string; opacity: number } {
  const base = colors.series[index % colors.series.length];
  const cycle = Math.floor(index / colors.series.length);
  return { color: base, opacity: cycle === 0 ? 1 : Math.max(0.4, 1 - cycle * 0.3) };
}
