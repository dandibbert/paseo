import path from "node:path";
import { BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import log from "electron-log/main";
import {
  chooseNotchPlacement,
  probeScreens,
  type NotchPlacement,
  type ScreenProbe,
} from "./geometry.js";
import { NOTCH_WINDOW_HEIGHT, NOTCH_WINDOW_WIDTH, notchPanelPageHtml } from "./page.js";
import { parseNotchPanelAction, type NotchPanelState } from "./types.js";

/**
 * The panel under the MacBook notch: what needs you on every host, what is running, and what
 * just finished, with approvals answered in place. A main Paseo window builds the content and
 * publishes it here; this module owns the always-on-top window that draws it.
 */

interface NotchPanelDeps {
  openAgent(target: { serverId: string; agentId: string }): Promise<void>;
}

let panel: BrowserWindow | null = null;
let source: WebContents | null = null;
let lastState: NotchPanelState | null = null;
let placement: NotchPlacement | null = null;
let probes: ScreenProbe[] = [];

export function isNotchPanelWindow(win: BrowserWindow): boolean {
  return panel !== null && !panel.isDestroyed() && win.id === panel.id;
}

function isState(value: unknown): value is NotchPanelState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === "boolean" &&
    Array.isArray(record.needsYou) &&
    Array.isArray(record.running) &&
    Array.isArray(record.finished)
  );
}

function measure(): NotchPlacement {
  return chooseNotchPlacement({
    displays: screen.getAllDisplays(),
    primary: screen.getPrimaryDisplay(),
    probes,
  });
}

function send(): void {
  if (!panel || panel.isDestroyed() || !placement) return;
  panel.webContents.send("paseo:notch:update", {
    state: lastState,
    geometry: {
      notchWidth: placement.notchWidth,
      notchHeight: placement.notchHeight,
      hasNotch: placement.hasNotch,
    },
  });
}

function position(): void {
  if (!panel || panel.isDestroyed()) return;
  placement = measure();
  const { bounds } = placement.display;
  panel.setBounds({
    x: Math.round(bounds.x + (bounds.width - NOTCH_WINDOW_WIDTH) / 2),
    y: bounds.y,
    width: NOTCH_WINDOW_WIDTH,
    height: NOTCH_WINDOW_HEIGHT,
  });
  send();
}

async function remeasure(): Promise<void> {
  probes = await probeScreens();
  position();
}

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: NOTCH_WINDOW_WIDTH,
    height: NOTCH_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A non-activating panel: clicking it does not pull Paseo in front of the app you are in.
    type: "panel",
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // Above the menu bar, on every Space and over full-screen apps, without hiding the Dock icon.
  win.setAlwaysOnTop(true, "status");
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.once("did-finish-load", () => {
    position();
    win.showInactive();
  });
  win.on("closed", () => {
    if (panel === win) panel = null;
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(notchPanelPageHtml())}`);
  return win;
}

function ensurePanel(): void {
  if (panel && !panel.isDestroyed()) return;
  panel = createPanel();
  void remeasure();
}

function closePanel(): void {
  if (panel && !panel.isDestroyed()) panel.destroy();
  panel = null;
}

function fromPanel(sender: WebContents): boolean {
  return panel !== null && !panel.isDestroyed() && sender.id === panel.webContents.id;
}

export function registerNotchPanel(deps: NotchPanelDeps): void {
  if (process.platform !== "darwin") return;

  ipcMain.handle("paseo:notch-panel:publish", (event, value: unknown) => {
    if (!isState(value)) return;
    if (source !== event.sender) {
      source = event.sender;
      event.sender.once("destroyed", () => {
        if (source !== event.sender) return;
        source = null;
        lastState = null;
        closePanel();
      });
    }
    lastState = value;
    if (!value.enabled) {
      closePanel();
      return;
    }
    ensurePanel();
    send();
  });

  ipcMain.on("paseo:notch:interactive", (event, interactive: unknown) => {
    if (!fromPanel(event.sender) || !panel) return;
    if (interactive === true) panel.setIgnoreMouseEvents(false);
    else panel.setIgnoreMouseEvents(true, { forward: true });
  });

  ipcMain.on("paseo:notch:action", (event, value: unknown) => {
    if (!fromPanel(event.sender)) return;
    const action = parseNotchPanelAction(value);
    if (!action) return;
    if (action.type === "open") {
      void deps
        .openAgent({ serverId: action.serverId, agentId: action.agentId })
        .catch((error: unknown) => log.warn("[notch-panel] open failed", error));
      return;
    }
    if (source && !source.isDestroyed()) source.send("paseo:event:notch-panel-respond", action);
  });

  const onDisplaysChanged = () => {
    if (panel && !panel.isDestroyed()) void remeasure();
  };
  screen.on("display-added", onDisplaysChanged);
  screen.on("display-removed", onDisplaysChanged);
  screen.on("display-metrics-changed", onDisplaysChanged);
}
