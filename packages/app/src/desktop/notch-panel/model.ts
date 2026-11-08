import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

/**
 * What the macOS notch panel shows. The main window builds it from every connected host and
 * sends it, already translated, to the panel window, which only draws it. The shape is mirrored
 * in packages/desktop/src/features/notch-panel/types.ts; keep the two in step.
 */
export type NotchPanelItemState = "permission" | "question" | "error" | "running" | "finished";

export interface NotchPanelButton {
  key: string;
  label: string;
  tone: "primary" | "secondary" | "danger";
  /** `open` jumps to the chat; questions and plans with free text are answered there. */
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
  /** Epoch ms of the moment this state began, for "3 min" labels. */
  since: number;
  requestId: string | null;
  buttons: NotchPanelButton[];
}

export interface NotchPanelLabels {
  needsYou: string;
  running: string;
  finished: string;
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
  offlineHosts: string[];
}

export interface NotchPanelAgent {
  id: string;
  status: string;
  title: string | null;
  cwd: string;
  pendingPermissions: AgentPermissionRequest[];
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: Date | null;
  lastActivityAt: Date;
  updatedAt: Date;
  lastError?: string | null;
  archivedAt?: Date | null;
  background?: boolean;
  parentAgentId?: string | null;
}

export interface NotchPanelHost {
  serverId: string;
  label: string;
  online: boolean;
  agents: Iterable<NotchPanelAgent>;
}

export interface NotchPanelText {
  untitled: string;
  allow: string;
  deny: string;
  answer: string;
  translateAction(label: string): string;
}

const FINISHED_LIMIT = 6;

function folderName(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || cwd
  );
}

function firstLine(value: string | null | undefined, max = 160): string | null {
  const line = value?.trim().split("\n")[0]?.trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function permissionDetail(request: AgentPermissionRequest): string | null {
  const command = request.input?.command;
  if (typeof command === "string") return firstLine(command);
  return firstLine(request.description) ?? firstLine(request.title) ?? request.name;
}

function opensChat(request: AgentPermissionRequest): boolean {
  return request.kind === "question" || request.kind === "other";
}

/** The buttons a permission gets in the panel; same rules as Better Paseo's task board. */
export function permissionButtons(
  request: AgentPermissionRequest,
  text: NotchPanelText,
): NotchPanelButton[] {
  if (opensChat(request)) {
    return [{ key: "open", label: text.answer, tone: "primary", kind: "open" }];
  }
  if (request.actions && request.actions.length > 0) {
    return request.actions.map((action) => ({
      key: action.id,
      label: text.translateAction(action.label),
      tone: action.variant ?? (action.behavior === "allow" ? "primary" : "secondary"),
      kind: "respond",
    }));
  }
  return [
    { key: "allow", label: text.allow, tone: "primary", kind: "respond" },
    { key: "deny", label: text.deny, tone: "secondary", kind: "respond" },
  ];
}

/** The answer a pressed button sends, or null when that button no longer applies. */
export function permissionResponse(
  request: AgentPermissionRequest,
  buttonKey: string,
): AgentPermissionResponse | null {
  if (opensChat(request)) return null;
  if (request.actions && request.actions.length > 0) {
    const action = request.actions.find((candidate) => candidate.id === buttonKey);
    if (!action) return null;
    return action.behavior === "allow"
      ? { behavior: "allow", selectedActionId: action.id }
      : { behavior: "deny", selectedActionId: action.id, message: "Denied by user" };
  }
  if (buttonKey === "allow") return { behavior: "allow" };
  if (buttonKey === "deny") return { behavior: "deny", message: "Denied by user" };
  return null;
}

function itemFor(
  host: NotchPanelHost,
  agent: NotchPanelAgent,
  text: NotchPanelText,
): NotchPanelItem | null {
  if (agent.archivedAt || agent.background) return null;
  const base = {
    key: `${host.serverId}:${agent.id}`,
    serverId: host.serverId,
    agentId: agent.id,
    title: firstLine(agent.title, 80) ?? text.untitled,
    subtitle: `${host.label} · ${folderName(agent.cwd)}`,
  };
  const request = agent.pendingPermissions[0];
  if (request) {
    return {
      ...base,
      state: opensChat(request) ? "question" : "permission",
      detail: permissionDetail(request),
      since: (agent.attentionTimestamp ?? agent.updatedAt).getTime(),
      requestId: request.id,
      buttons: permissionButtons(request, text),
    };
  }
  const attention = agent.requiresAttention ? agent.attentionReason : null;
  if (agent.status === "error" || attention === "error") {
    return {
      ...base,
      state: "error",
      detail: firstLine(agent.lastError),
      since: (agent.attentionTimestamp ?? agent.updatedAt).getTime(),
      requestId: null,
      buttons: [],
    };
  }
  // A subagent is shown when it needs you; its parent already stands for its running work.
  if (agent.parentAgentId) return null;
  if (agent.status === "running") {
    return {
      ...base,
      state: "running",
      detail: null,
      since: agent.lastActivityAt.getTime(),
      requestId: null,
      buttons: [],
    };
  }
  if (attention === "finished") {
    return {
      ...base,
      state: "finished",
      detail: null,
      since: (agent.attentionTimestamp ?? agent.updatedAt).getTime(),
      requestId: null,
      buttons: [],
    };
  }
  return null;
}

function newestFirst(a: NotchPanelItem, b: NotchPanelItem): number {
  return b.since - a.since;
}

/** Sorts every host's agents into what needs you, what is running, and what just finished. */
export function buildNotchPanelState(input: {
  enabled: boolean;
  hosts: readonly NotchPanelHost[];
  labels: NotchPanelLabels;
  text: NotchPanelText;
}): NotchPanelState {
  const needsYou: NotchPanelItem[] = [];
  const running: NotchPanelItem[] = [];
  const finished: NotchPanelItem[] = [];
  const offlineHosts: string[] = [];
  for (const host of input.hosts) {
    if (!host.online) offlineHosts.push(host.label);
    for (const agent of host.agents) {
      const item = itemFor(host, agent, input.text);
      if (!item) continue;
      if (item.state === "running") running.push(item);
      else if (item.state === "finished") finished.push(item);
      else needsYou.push(item);
    }
  }
  return {
    enabled: input.enabled,
    labels: input.labels,
    needsYou: needsYou.sort(newestFirst),
    running: running.sort(newestFirst),
    finished: finished.sort(newestFirst).slice(0, FINISHED_LIMIT),
    offlineHosts,
  };
}
