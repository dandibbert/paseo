/**
 * The notch panel's content, built and translated by the main window and drawn by the panel.
 * Mirrors packages/app/src/desktop/notch-panel/model.ts; keep the two in step.
 */
export type NotchPanelItemState =
  | "permission"
  | "question"
  | "error"
  | "running"
  | "finished"
  | "recent";

export interface NotchPanelButton {
  key: string;
  label: string;
  tone: "primary" | "secondary" | "danger";
  kind: "respond" | "open";
}

export interface NotchPanelItem {
  key: string;
  serverId: string;
  agentId: string;
  title: string;
  subtitle: string;
  state: NotchPanelItemState;
  detail: string | null;
  since: number;
  requestId: string | null;
  buttons: NotchPanelButton[];
}

export interface NotchPanelLabels {
  needsYou: string;
  running: string;
  finished: string;
  recent: string;
  columnEmpty: string;
  empty: string;
  offline: string;
  open: string;
  states: Record<NotchPanelItemState, string>;
}

export interface NotchPanelState {
  enabled: boolean;
  labels: NotchPanelLabels;
  needsYou: NotchPanelItem[];
  running: NotchPanelItem[];
  finished: NotchPanelItem[];
  recent: NotchPanelItem[];
  hosts: NotchPanelHostSummary[];
  offlineHosts: string[];
}

export interface NotchPanelHostSummary {
  serverId: string;
  label: string;
  online: boolean;
  running: number;
  needsYou: number;
}

/** What the panel page needs to draw itself under the notch. */
export interface NotchGeometry {
  /** Width and height of the notch in points; on a screen without one, a pill of this size. */
  notchWidth: number;
  notchHeight: number;
  hasNotch: boolean;
}

export type NotchPanelAction =
  | { type: "open"; serverId: string; agentId: string }
  | {
      type: "respond";
      serverId: string;
      agentId: string;
      requestId: string;
      buttonKey: string;
    };

export function parseNotchPanelAction(value: unknown): NotchPanelAction | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId : "";
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  if (!serverId || !agentId) return null;
  if (record.type === "open") return { type: "open", serverId, agentId };
  if (
    record.type === "respond" &&
    typeof record.requestId === "string" &&
    typeof record.buttonKey === "string"
  ) {
    return {
      type: "respond",
      serverId,
      agentId,
      requestId: record.requestId,
      buttonKey: record.buttonKey,
    };
  }
  return null;
}
