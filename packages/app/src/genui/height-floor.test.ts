import { describe, expect, it } from "vitest";
import {
  applyHeightFloorLayout,
  createHeightFloor,
  raiseHeightFloorToEstimate,
  type HeightFloor,
} from "./height-floor";

function layout(
  floor: HeightFloor,
  width: number,
  height: number,
  generating: boolean,
  estimate = 200,
): HeightFloor {
  return applyHeightFloorLayout({ floor, layout: { width, height }, estimate, generating });
}

describe("height floor", () => {
  it("only grows while generating at the same width", () => {
    let floor = createHeightFloor(200);
    floor = layout(floor, 390, 200, true);
    floor = layout(floor, 390, 260, true);
    expect(floor).toEqual({ width: 390, minHeight: 260 });
    floor = layout(floor, 390, 240, true);
    expect(floor.minHeight).toBe(260);
  });

  it("ignores the tall transient layout a list reports at width 0", () => {
    let floor = createHeightFloor(200);
    floor = layout(floor, 0, 1400, true);
    expect(floor).toEqual({ width: null, minHeight: 200 });
  });

  it("resets to the estimate when the width changes", () => {
    let floor = createHeightFloor(200);
    floor = layout(floor, 40, 200, true);
    floor = layout(floor, 40, 1400, true);
    expect(floor.minHeight).toBe(1400);
    floor = layout(floor, 390, 1400, true);
    expect(floor).toEqual({ width: 390, minHeight: 200 });
  });

  it("never grows for an accepted card, such as one restored from history", () => {
    let floor = createHeightFloor(200);
    floor = layout(floor, 390, 200, false);
    floor = layout(floor, 390, 1400, false);
    expect(floor).toEqual({ width: 390, minHeight: 200 });
  });

  it("keeps the generating height when the card is accepted", () => {
    let floor = createHeightFloor(120);
    floor = layout(floor, 390, 120, true, 120);
    floor = layout(floor, 390, 180, true, 120);
    floor = raiseHeightFloorToEstimate(floor, 200);
    expect(floor.minHeight).toBe(200);
    floor = layout(floor, 390, 220, false, 200);
    expect(floor.minHeight).toBe(200);
  });
});
