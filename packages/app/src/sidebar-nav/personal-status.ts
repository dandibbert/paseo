import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { PendingCreateAttempt } from "@/stores/create-flow-store";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import { deriveEffectiveWorkspaceStatus } from "@/workspace-status";

/**
 * Most urgent status across a host's personal project. Agents started in the personal folder
 * without naming the workspace used to get workspaces of their own in that project, and the
 * project list hides them, so every workspace in it counts.
 */
export function derivePersonalSpaceStatus(input: {
  serverId: string;
  session:
    | {
        workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
        workspaceAgentActivity: ReadonlyMap<string, WorkspaceAgentActivity>;
      }
    | undefined;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
}): SidebarStateBucket {
  const { session } = input;
  if (!session) return "done";
  const personalProjectIds = new Set<string>();
  for (const workspace of session.workspaces.values()) {
    if (workspace.personal) personalProjectIds.add(workspace.projectId);
  }
  if (personalProjectIds.size === 0) return "done";
  const buckets: SidebarStateBucket[] = [];
  for (const workspace of session.workspaces.values()) {
    if (!personalProjectIds.has(workspace.projectId)) continue;
    buckets.push(
      deriveEffectiveWorkspaceStatus({
        serverId: input.serverId,
        workspace,
        pendingCreateAttempts: input.pendingCreateAttempts,
        workspaceAgentActivity: session.workspaceAgentActivity,
      }).status,
    );
  }
  return aggregateSidebarStateBuckets(buckets);
}
