import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { i18n } from "@/i18n/i18next";

export type AgentHistoryMutation = "rename" | "stop" | "archive" | "unarchive" | "detach";

export function canStopHistoryAgent(
  agent: Pick<AgentDirectoryEntry, "status" | "turn" | "archivedAt">,
): boolean {
  return !agent.archivedAt && (agent.status === "running" || agent.turn.phase === "open");
}

export function isHistoryMutationApplicable(
  action: AgentHistoryMutation,
  agent: Pick<AgentSnapshotPayload, "status" | "activeTurn" | "archivedAt" | "labels">,
): boolean {
  switch (action) {
    case "stop":
      return !agent.archivedAt && (agent.status === "running" || agent.activeTurn != null);
    case "archive":
      return !agent.archivedAt;
    case "unarchive":
      return Boolean(agent.archivedAt);
    case "detach":
      return !agent.archivedAt && Boolean(getParentAgentIdFromLabels(agent.labels));
    case "rename":
      return true;
  }
}

type AgentHistoryChild = Pick<AgentDirectoryEntry, "id" | "title" | "workspaceId" | "labels">;

export function mergeAgentHistoryChildren(
  parentId: string,
  knownChildren: readonly AgentHistoryChild[],
  liveAgents: Iterable<AgentHistoryChild>,
): AgentHistoryChild[] {
  const children = new Map(knownChildren.map((child) => [child.id, child]));
  for (const child of liveAgents) {
    if (getParentAgentIdFromLabels(child.labels) === parentId) children.set(child.id, child);
    else children.delete(child.id);
  }
  return Array.from(children.values()).filter(
    (child) => getParentAgentIdFromLabels(child.labels) === parentId,
  );
}

type HistoryMutationClient = Pick<
  DaemonClient,
  "fetchAgent" | "cancelAgent" | "archiveAgent" | "refreshAgent" | "updateAgent" | "detachAgent"
>;

/** Re-read after confirmation: restoring a stale History row must never reload an active agent. */
export async function runAgentHistoryMutation(input: {
  client: HistoryMutationClient;
  agentId: string;
  action: AgentHistoryMutation;
  name?: string;
}): Promise<{ archivedAt?: string }> {
  const { client, agentId, action } = input;
  const current = await client.fetchAgent(agentId);
  if (!current) throw new Error(i18n.t("agentList.actions.notFound"));
  if (!isHistoryMutationApplicable(action, current.agent)) return {};

  switch (action) {
    case "archive":
      return client.archiveAgent(agentId);
    case "unarchive":
      await client.refreshAgent(agentId);
      break;
    case "stop":
      await client.cancelAgent(agentId);
      break;
    case "detach":
      await client.detachAgent(agentId);
      break;
    case "rename": {
      const name = input.name?.trim();
      if (!name) throw new Error(i18n.t("common.errors.nameRequired"));
      await client.updateAgent(agentId, { name });
      break;
    }
  }
  return {};
}
