import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { AgentAttentionReason } from "@getpaseo/protocol/agent-state-bucket";
import type { TurnLiveness } from "@/timeline/turn-liveness";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "./sidebar-agent-state";

/**
 * The one place the app decides what an agent is doing. Every surface that marks an agent as
 * running, waiting on you or done (sidebar, tabs, History, favicon, notch panel) reads it from
 * here, so they cannot disagree.
 *
 * The inputs and what each one means:
 * - `turn` is the turn the client tracks from the stream. It decides "running"; the snapshot's
 *   `status` can lag it in either direction.
 * - `backgroundWork` is work the agent left running after its turn ended (background subagents,
 *   shells). The agent is still running while any of it is.
 * - `pendingPermissionCount` and the attention fields outrank running: see
 *   `deriveAgentStateBucket` for the order.
 */
export interface AgentActivityInput {
  status: AgentLifecycleStatus;
  turn: TurnLiveness;
  backgroundWork?: { count: number } | null;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
}

/**
 * The lifecycle to show once the caller knows whether a turn is active: "running" exactly while
 * it is. Callers that hold an agent use `resolveAgentLifecycle`; this is for a chat, whose turn
 * also counts as active from the moment a message is submitted.
 */
export function settleAgentLifecycle(
  status: AgentLifecycleStatus,
  isTurnActive: boolean,
): AgentLifecycleStatus {
  if (isTurnActive) return "running";
  return status === "running" ? "idle" : status;
}

/** The lifecycle to show: "running" exactly while the tracked turn is open. */
export function resolveAgentLifecycle(
  agent: Pick<AgentActivityInput, "status" | "turn">,
): AgentLifecycleStatus {
  return settleAgentLifecycle(agent.status, agent.turn.phase === "open");
}

/** True while the agent has an open turn or work it left running in the background. */
export function isAgentWorking(
  agent: Pick<AgentActivityInput, "status" | "turn" | "backgroundWork">,
): boolean {
  return resolveAgentLifecycle(agent) === "running" || (agent.backgroundWork?.count ?? 0) > 0;
}

export function deriveAgentActivityBucket(agent: AgentActivityInput): SidebarStateBucket {
  return deriveSidebarStateBucket({
    status: resolveAgentLifecycle(agent),
    backgroundWork: agent.backgroundWork,
    pendingPermissionCount: agent.pendingPermissionCount,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
}
