import { execFile } from "node:child_process";
import type { NotchGeometry } from "./types.js";

/** One macOS screen as AppKit reports it (Cocoa coordinates, points). */
export interface ScreenProbe {
  x: number;
  width: number;
  /** safeAreaInsets.top: the notch's height, 0 on a screen without one. */
  top: number;
  /** auxiliaryTopLeftArea / auxiliaryTopRightArea widths: the menu bar either side of it. */
  left: number;
  right: number;
}

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectronDisplayLike {
  id: number;
  bounds: DisplayBounds;
  workArea: DisplayBounds;
}

export interface NotchPlacement extends NotchGeometry {
  display: ElectronDisplayLike;
}

const FALLBACK_NOTCH_WIDTH = 190;

// Electron has no API for the notch, so ask AppKit through JavaScript for Automation, which
// ships with every macOS. A failure (older macOS, sandbox) falls back to the menu bar.
const PROBE_SCRIPT = `ObjC.import("AppKit");
var screens = $.NSScreen.screens, out = [];
for (var i = 0; i < screens.count; i++) {
  var s = screens.objectAtIndex(i), f = s.frame, l = s.auxiliaryTopLeftArea, r = s.auxiliaryTopRightArea, inset = s.safeAreaInsets;
  out.push({
    x: f.origin.x, width: f.size.width,
    top: inset ? inset.top : 0,
    left: l && l.size ? l.size.width : 0,
    right: r && r.size ? r.size.width : 0
  });
}
JSON.stringify(out);`;

export function probeScreens(): Promise<ScreenProbe[]> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", PROBE_SCRIPT],
      { timeout: 4000 },
      (error, stdout) => {
        resolve(error ? [] : parseProbes(stdout));
      },
    );
  });
}

function parseProbes(stdout: string): ScreenProbe[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isProbe) : [];
  } catch {
    return [];
  }
}

function isProbe(value: unknown): value is ScreenProbe {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["x", "width", "top", "left", "right"].every((key) => typeof record[key] === "number");
}

/**
 * Picks the screen with a notch and measures it. Without one, the panel sits as a pill in the
 * primary display's menu bar and only shows when there is something to show.
 */
export function chooseNotchPlacement(input: {
  displays: readonly ElectronDisplayLike[];
  primary: ElectronDisplayLike;
  probes: readonly ScreenProbe[];
}): NotchPlacement {
  for (const probe of input.probes) {
    if (probe.top <= 0 || (probe.left <= 0 && probe.right <= 0)) continue;
    const display = input.displays.find(
      (candidate) =>
        Math.round(candidate.bounds.x) === Math.round(probe.x) &&
        Math.round(candidate.bounds.width) === Math.round(probe.width),
    );
    if (!display) continue;
    return {
      display,
      hasNotch: true,
      notchWidth: Math.round(probe.width - probe.left - probe.right),
      notchHeight: Math.round(probe.top),
    };
  }
  const menuBar = input.primary.workArea.y - input.primary.bounds.y;
  return {
    display: input.primary,
    hasNotch: false,
    notchWidth: FALLBACK_NOTCH_WIDTH,
    notchHeight: Math.max(24, Math.round(menuBar)),
  };
}
