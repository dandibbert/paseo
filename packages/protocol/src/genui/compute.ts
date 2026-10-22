// Derived values for GenUI cards. The daemon returns these to the model as `derived`
// and the app renders the same numbers, so both sides must call these functions.

export const DEFAULT_CHANGE_PERCENT_PRECISION = 1;
const PIE_PERCENT_PRECISION = 1;

export type ChangePercentResult =
  | { changePercent: number }
  | { unavailableReason: "zero_baseline" };

export interface ProgressResult {
  // Unclamped; values above 1 mean the target was exceeded. Clamp only the visual fill.
  ratio: number;
  percent: number;
}

export interface PieShare {
  ratio: number;
  percent: number;
}

export interface PieSharesResult {
  total: number;
  shares: PieShare[];
}

// Matches Python's Decimal ROUND_HALF_UP: halves round away from zero. The toPrecision
// pass strips binary noise such as 1.005 * 100 = 100.49999999999999.
export function roundHalfUp(value: number, precision: number): number {
  const factor = 10 ** precision;
  const scaled = Number((Math.abs(value) * factor).toPrecision(12));
  const rounded = Math.floor(scaled + 0.5) / factor;
  if (rounded === 0) {
    return 0;
  }
  return value < 0 ? -rounded : rounded;
}

export function computeChangePercent(input: {
  from: number;
  to: number;
  precision?: number;
}): ChangePercentResult {
  if (input.from === 0) {
    return { unavailableReason: "zero_baseline" };
  }
  const precision = input.precision ?? DEFAULT_CHANGE_PERCENT_PRECISION;
  return {
    changePercent: roundHalfUp(((input.to - input.from) / input.from) * 100, precision),
  };
}

export function computeProgress(input: { current: number; total: number }): ProgressResult {
  const ratio = input.current / input.total;
  return { ratio, percent: roundHalfUp(ratio * 100, 0) };
}

export function computePieShares(values: readonly number[]): PieSharesResult {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    total,
    shares: values.map((value) => {
      const ratio = value / total;
      return { ratio, percent: roundHalfUp(ratio * 100, PIE_PERCENT_PRECISION) };
    }),
  };
}
