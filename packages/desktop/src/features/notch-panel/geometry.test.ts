import { describe, expect, it } from "vitest";
import { chooseNotchPlacement, type ElectronDisplayLike } from "./geometry";

const builtIn: ElectronDisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
};
const external: ElectronDisplayLike = {
  id: 2,
  bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
  workArea: { x: 1512, y: -175, width: 2560, height: 1415 },
};

describe("chooseNotchPlacement", () => {
  it("measures the notch on the built-in screen even when another display is primary", () => {
    const placement = chooseNotchPlacement({
      displays: [builtIn, external],
      primary: external,
      probes: [
        { x: 1512, width: 2560, top: 0, left: 0, right: 0 },
        { x: 0, width: 1512, top: 38, left: 662, right: 665 },
      ],
    });
    expect(placement).toMatchObject({
      hasNotch: true,
      notchWidth: 185,
      notchHeight: 38,
      display: { id: 1 },
    });
  });

  it("falls back to a pill in the primary menu bar when no screen has a notch", () => {
    const placement = chooseNotchPlacement({ displays: [external], primary: external, probes: [] });
    expect(placement).toMatchObject({ hasNotch: false, notchHeight: 25, display: { id: 2 } });
  });
});
