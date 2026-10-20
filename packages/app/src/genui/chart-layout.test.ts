import { describe, expect, it } from "vitest";
import {
  buildValueAxis,
  chartHeightForWidth,
  lineSegments,
  pieSlicePaths,
  roundedBarPath,
  scaleValue,
  visibleLabelIndices,
} from "./chart-layout";
import { formatAxisTick, formatCell, formatSignedPercent, formatWithUnit } from "./format";

describe("chartHeightForWidth", () => {
  it("uses 432px at 600px and wider", () => {
    expect(chartHeightForWidth(600)).toBe(432);
    expect(chartHeightForWidth(900)).toBe(432);
  });

  it("uses 0.72 of the width below 600px with a 280px floor", () => {
    expect(chartHeightForWidth(500)).toBe(360);
    expect(chartHeightForWidth(320)).toBe(280);
  });
});

describe("buildValueAxis", () => {
  it("anchors at zero and rounds the top to a nice step", () => {
    expect(buildValueAxis([7.8, 9.5, 1.1, 1.4])).toEqual({
      min: 0,
      max: 10,
      ticks: [0, 2.5, 5, 7.5, 10],
    });
  });

  it("extends below zero for negative values", () => {
    const axis = buildValueAxis([-30, 80]);
    expect(axis.min).toBeLessThan(0);
    expect(axis.ticks).toContain(0);
    expect(axis.max).toBeGreaterThanOrEqual(80);
  });

  it("returns a unit axis for all-zero data", () => {
    expect(buildValueAxis([0, 0])).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });

  it("maps values linearly between top and bottom", () => {
    const axis = { min: 0, max: 10, ticks: [] };
    expect(scaleValue({ value: 5, axis, top: 0, bottom: 100 })).toBe(50);
    expect(scaleValue({ value: 0, axis, top: 0, bottom: 100 })).toBe(100);
  });
});

describe("roundedBarPath", () => {
  it("rounds the top of a positive bar", () => {
    expect(roundedBarPath({ x: 0, width: 20, valueY: 10, baselineY: 100, radius: 8 })).toBe(
      "M0,100 L0,18 Q0,10 8,10 L12,10 Q20,10 20,18 L20,100 Z",
    );
  });

  it("shrinks the radius for short bars", () => {
    expect(roundedBarPath({ x: 0, width: 20, valueY: 97, baselineY: 100, radius: 8 })).toContain(
      "Q0,97 3,97",
    );
  });

  it("rounds the bottom of a negative bar", () => {
    expect(roundedBarPath({ x: 0, width: 20, valueY: 150, baselineY: 100, radius: 8 })).toContain(
      "Q20,150 12,150",
    );
  });
});

describe("pieSlicePaths", () => {
  it("starts at twelve o'clock and runs clockwise", () => {
    const [first, second] = pieSlicePaths({ ratios: [0.25, 0.75], cx: 50, cy: 50, radius: 50 });
    expect(first.path).toBe("M50,50 L50,0 A50,50 0 0 1 100,50 Z");
    expect(second.path).toBe("M50,50 L100,50 A50,50 0 1 1 50,0 Z");
  });

  it("draws a lone full slice as a closed circle", () => {
    const [only] = pieSlicePaths({ ratios: [1, 0], cx: 10, cy: 10, radius: 10 });
    expect(only.path).toBe("M10,0 A10,10 0 1 1 10,20 A10,10 0 1 1 10,0 Z");
  });
});

describe("lineSegments", () => {
  it("breaks the line at missing values", () => {
    expect(
      lineSegments([
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: null },
        { x: 3, y: 4 },
      ]),
    ).toEqual([
      [
        { x: 0, y: 1 },
        { x: 1, y: 2 },
      ],
      [{ x: 3, y: 4 }],
    ]);
  });
});

describe("visibleLabelIndices", () => {
  it("keeps every label when they fit", () => {
    expect(visibleLabelIndices({ count: 3, slotWidth: 100, minLabelWidth: 40 })).toEqual([0, 1, 2]);
  });

  it("skips labels that would overlap", () => {
    expect(visibleLabelIndices({ count: 7, slotWidth: 20, minLabelWidth: 50 })).toEqual([0, 3, 6]);
  });
});

describe("format", () => {
  it("formats values with units", () => {
    expect(formatWithUnit(7500, "HC")).toBe("7,500 HC");
    expect(formatWithUnit(92.4, "%")).toBe("92.4%");
    expect(formatWithUnit(46, undefined)).toBe("46");
  });

  it("signs percent changes", () => {
    expect(formatSignedPercent(-85.7, 1)).toBe("-85.7%");
    expect(formatSignedPercent(12, 1)).toBe("+12.0%");
    expect(formatSignedPercent(0, 0)).toBe("0%");
  });

  it("shows missing cells as a dash instead of zero", () => {
    expect(formatCell(null)).toBe("—");
    expect(formatCell(0)).toBe("0");
  });

  it("compacts large axis ticks", () => {
    expect(formatAxisTick(2500)).toBe("2,500");
    expect(formatAxisTick(25000)).toBe("25K");
    expect(formatAxisTick(3_400_000)).toBe("3.4M");
    expect(formatAxisTick(0.1 + 0.2)).toBe("0.3");
  });
});
