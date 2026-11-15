import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

/**
 * What an agent would lose if it were interrupted now, most blocking first. Anything that asks
 * "is this agent busy" reads it from here, so a restart, a wait and a stop agree with each other.
 *
 * `background_work` covers what outlives the agent's turn: background subagents and shells the
 * provider reports, and provider subagents still running under an idle parent.
 */
export type AgentBusyReason =
  | "waiting_for_permission"
  | "initializing"
  | "running"
  | "background_work";

export interface AgentBusyInput {
  lifecycle: AgentLifecycleStatus;
  pendingPermissionCount: number;
  /** A foreground turn is open, queued to start, or being replaced. */
  hasPendingTurn: boolean;
  backgroundWorkCount: number;
  runningProviderSubagentCount: number;
}

export function resolveAgentBusyReason(input: AgentBusyInput): AgentBusyReason | null {
  if (input.pendingPermissionCount > 0) return "waiting_for_permission";
  if (input.lifecycle === "initializing") return "initializing";
  if (input.lifecycle === "running" || input.hasPendingTurn) return "running";
  if (input.backgroundWorkCount > 0 || input.runningProviderSubagentCount > 0) {
    return "background_work";
  }
  return null;
}
