// Number and cell formatting shared by every GenUI component and the copy-as-text output.

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export const MISSING_VALUE_TEXT = "—";

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

// "%" hugs the number; any other unit is separated by a space ("7,500 HC", "46 项").
export function formatWithUnit(value: number, unit: string | undefined): string {
  const formatted = formatNumber(value);
  if (!unit) {
    return formatted;
  }
  return unit === "%" ? `${formatted}%` : `${formatted} ${unit}`;
}

export function formatSignedPercent(value: number, precision: number): string {
  const fixed = Math.abs(value).toFixed(precision);
  if (value > 0) {
    return `+${fixed}%`;
  }
  if (value < 0) {
    return `-${fixed}%`;
  }
  return `${fixed}%`;
}

export function formatCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return MISSING_VALUE_TEXT;
  }
  return typeof value === "number" ? formatNumber(value) : value;
}

// Compact axis labels: 1,200 -> 1.2K, 3,400,000 -> 3.4M.
export function formatAxisTick(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) {
    return `${formatNumber(Number((value / 1_000_000_000).toPrecision(3)))}B`;
  }
  if (magnitude >= 1_000_000) {
    return `${formatNumber(Number((value / 1_000_000).toPrecision(3)))}M`;
  }
  if (magnitude >= 10_000) {
    return `${formatNumber(Number((value / 1_000).toPrecision(3)))}K`;
  }
  return formatNumber(Number(value.toPrecision(6)));
}
