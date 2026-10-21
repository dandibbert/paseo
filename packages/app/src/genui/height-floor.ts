// Minimum height for a card body, so the timeline does not jump while a card streams in.
//
// The floor only grows from layouts measured while the card is generating, and only at
// the width it was measured at. A list can lay a row out first at a transient width (0 on
// iOS before the list has measured itself), where CJK text wraps one glyph per line and
// the row is hundreds of points tall. Keeping that height would leave a permanent gap
// below the card, so a width change resets the floor, and an accepted card (including one
// restored from history) never raises it.

export interface HeightFloor {
  width: number | null;
  minHeight: number;
}

export function createHeightFloor(estimate: number): HeightFloor {
  return { width: null, minHeight: estimate };
}

export function raiseHeightFloorToEstimate(floor: HeightFloor, estimate: number): HeightFloor {
  return estimate > floor.minHeight ? { ...floor, minHeight: estimate } : floor;
}

export function applyHeightFloorLayout(input: {
  floor: HeightFloor;
  layout: { width: number; height: number };
  estimate: number;
  generating: boolean;
}): HeightFloor {
  const { floor, layout, estimate, generating } = input;
  if (layout.width <= 0) {
    return floor;
  }
  if (floor.width !== layout.width) {
    // The current floor was set at another width; the height just measured is inflated by
    // it, so start over from the estimate rather than from that height.
    return { width: layout.width, minHeight: estimate };
  }
  if (!generating || layout.height <= floor.minHeight) {
    return floor;
  }
  return { ...floor, minHeight: layout.height };
}
