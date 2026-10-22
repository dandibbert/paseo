import { describe, expect, it } from "vitest";
import { computeChangePercent, computePieShares, computeProgress, roundHalfUp } from "./compute.js";

describe("roundHalfUp", () => {
  it("rounds halves away from zero like decimal ROUND_HALF_UP", () => {
    expect(roundHalfUp(12.5, 0)).toBe(13);
    expect(roundHalfUp(-12.5, 0)).toBe(-13);
    expect(roundHalfUp(0.05, 1)).toBe(0.1);
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
  });

  it("does not turn negative values that round to zero into -0", () => {
    expect(Object.is(roundHalfUp(-0.04, 1), 0)).toBe(true);
  });
});

describe("computeChangePercent", () => {
  it("computes (to - from) / from * 100 at the requested precision", () => {
    expect(computeChangePercent({ from: 7500, to: 1071, precision: 1 })).toEqual({
      changePercent: -85.7,
    });
  });

  it("defaults to one decimal place", () => {
    expect(computeChangePercent({ from: 3, to: 4 })).toEqual({ changePercent: 33.3 });
  });

  it("rounds a half step away from zero", () => {
    expect(computeChangePercent({ from: 8, to: 7, precision: 0 })).toEqual({
      changePercent: -13,
    });
    expect(computeChangePercent({ from: 200, to: 200.1, precision: 1 })).toEqual({
      changePercent: 0.1,
    });
  });

  it("reports a zero baseline instead of dividing by zero", () => {
    expect(computeChangePercent({ from: 0, to: 12 })).toEqual({
      unavailableReason: "zero_baseline",
    });
  });
});

describe("computeProgress", () => {
  it("returns the unclamped ratio and a whole-number percent", () => {
    expect(computeProgress({ current: 46, total: 50 })).toEqual({ ratio: 0.92, percent: 92 });
  });

  it("keeps overshoot instead of capping at 100%", () => {
    expect(computeProgress({ current: 60, total: 50 })).toEqual({ ratio: 1.2, percent: 120 });
  });

  it("rounds the percent to a whole number", () => {
    expect(computeProgress({ current: 2, total: 3 })).toEqual({
      ratio: 2 / 3,
      percent: 67,
    });
  });
});

describe("computePieShares", () => {
  it("normalizes values against their total", () => {
    expect(computePieShares([46, 27, 17, 10])).toEqual({
      total: 100,
      shares: [
        { ratio: 0.46, percent: 46 },
        { ratio: 0.27, percent: 27 },
        { ratio: 0.17, percent: 17 },
        { ratio: 0.1, percent: 10 },
      ],
    });
  });

  it("derives percentages from raw counts", () => {
    const result = computePieShares([1, 2]);
    expect(result.total).toBe(3);
    expect(result.shares.map((share) => share.percent)).toEqual([33.3, 66.7]);
  });
});
