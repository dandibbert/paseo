import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { TurnLiveness } from "@/timeline/turn-liveness";
import { isAgentWorking } from "@/utils/agent-activity";

/**
 * What the macOS notch panel shows. The main window builds it from every connected host and
 * sends it, already translated, to the panel window, which only draws it. The shape is mirrored
 * in packages/desktop/src/features/notch-panel/types.ts; keep the two in step.
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
  /** Finished but not yet looked at. */
  finished: string;
  /** Idle chats that changed recently, for a board that is useful when nothing needs you. */
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

export interface NotchPanelAgent {
  id: string;
  status: AgentLifecycleStatus;
  turn: TurnLiveness;
  backgroundWork?: { count: number } | null;
  title: string | null;
  cwd: string;
  workspaceId?: string;
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
  /** Workspaces the sidebar shows as running, which includes work only the host can see. */
  runningWorkspaceIds?: Iterable<string>;
}

export interface NotchPanelText {
  untitled: string;
  allow: string;
  deny: string;
  answer: string;
  translateAction(label: string): string;
}

const FINISHED_LIMIT = 8;
const RECENT_LIMIT = 8;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

function isShown(agent: NotchPanelAgent): boolean {
  return !agent.archivedAt && !agent.background && !agent.parentAgentId;
}

function topAncestor(
  agent: NotchPanelAgent,
  agentsById: ReadonlyMap<string, NotchPanelAgent>,
): NotchPanelAgent {
  const seen = new Set<string>();
  let current = agent;
  while (current.parentAgentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = agentsById.get(current.parentAgentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * The chats that count as running, by the sidebar's rules: a chat runs while its own turn is
 * open, while it has background work, and while any subagent under it does. A chat that stopped
 * to wait for its subagents is therefore still running.
 *
 * Provider subagents are not in the agent list, so the host's word that a workspace is running
 * covers them: when no chat in such a workspace accounts for it, its latest chat is the one
 * waiting.
 */
function workingAgentIds(host: NotchPanelHost, agents: readonly NotchPanelAgent[]): Set<string> {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const working = new Set<string>();
  for (const agent of agents) {
    if (agent.archivedAt || agent.background || !isAgentWorking(agent)) continue;
    working.add(topAncestor(agent, agentsById).id);
  }
  for (const workspaceId of host.runningWorkspaceIds ?? []) {
    let latest: NotchPanelAgent | null = null;
    let accountedFor = false;
    for (const agent of agents) {
      if (agent.workspaceId !== workspaceId || !isShown(agent)) continue;
      if (working.has(agent.id)) {
        accountedFor = true;
        break;
      }
      if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
    }
    if (!accountedFor && latest) working.add(latest.id);
  }
  return working;
}

function itemFor(
  host: NotchPanelHost,
  agent: NotchPanelAgent,
  text: NotchPanelText,
  now: number,
  working: ReadonlySet<string>,
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
  // An error needs you until you have seen it, as in the sidebar; after that the chat is recent.
  if (attention === "error") {
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
  if (working.has(agent.id)) {
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
  const settled = agent.status === "idle" || agent.status === "error";
  if (settled && now - agent.updatedAt.getTime() < RECENT_WINDOW_MS) {
    return {
      ...base,
      state: "recent",
      detail: null,
      since: agent.updatedAt.getTime(),
      requestId: null,
      buttons: [],
    };
  }
  return null;
}

function newestFirst(a: NotchPanelItem, b: NotchPanelItem): number {
  return b.since - a.since;
}

/**
 * Sorts every host's agents into a small board: what needs you, what is running, what finished
 * and waits to be looked at, and what changed in the last day.
 */
export function buildNotchPanelState(input: {
  enabled: boolean;
  hosts: readonly NotchPanelHost[];
  labels: NotchPanelLabels;
  text: NotchPanelText;
  now?: number;
}): NotchPanelState {
  const now = input.now ?? Date.now();
  const needsYou: NotchPanelItem[] = [];
  const running: NotchPanelItem[] = [];
  const finished: NotchPanelItem[] = [];
  const recent: NotchPanelItem[] = [];
  const hosts: NotchPanelHostSummary[] = [];
  const offlineHosts: string[] = [];
  for (const host of input.hosts) {
    if (!host.online) offlineHosts.push(host.label);
    const summary: NotchPanelHostSummary = {
      serverId: host.serverId,
      label: host.label,
      online: host.online,
      running: 0,
      needsYou: 0,
    };
    const agents = Array.from(host.agents);
    const working = workingAgentIds(host, agents);
    for (const agent of agents) {
      const item = itemFor(host, agent, input.text, now, working);
      if (!item) continue;
      if (item.state === "running") {
        running.push(item);
        summary.running += 1;
      } else if (item.state === "finished") finished.push(item);
      else if (item.state === "recent") recent.push(item);
      else {
        needsYou.push(item);
        summary.needsYou += 1;
      }
    }
    hosts.push(summary);
  }
  return {
    enabled: input.enabled,
    labels: input.labels,
    needsYou: needsYou.sort(newestFirst),
    running: running.sort(newestFirst),
    finished: finished.sort(newestFirst).slice(0, FINISHED_LIMIT),
    recent: recent.sort(newestFirst).slice(0, RECENT_LIMIT),
    hosts,
    offlineHosts,
  };
}
