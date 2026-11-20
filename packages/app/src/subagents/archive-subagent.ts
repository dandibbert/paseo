import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import { i18n } from "@/i18n/i18next";
import type { Agent } from "@/stores/session-store";
import { isAgentWorking } from "@/utils/agent-activity";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ResolveArchiveSubagentDialogInput {
  title: Agent["title"] | null | undefined;
  status: Agent["status"] | null | undefined;
  turn?: Agent["turn"] | null | undefined;
  backgroundWork?: Agent["backgroundWork"];
}

function resolveSubagentLabel(title: Agent["title"] | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function resolveArchiveSubagentDialog(
  input: ResolveArchiveSubagentDialogInput,
): ConfirmDialogInput {
  const subagentLabel =
    resolveSubagentLabel(input.title) ?? i18n.t("subagents.dialogs.thisSubagentLower");
  const isRunning =
    input.status && input.turn
      ? isAgentWorking({
          status: input.status,
          turn: input.turn,
          backgroundWork:
            input.backgroundWork?.runningCount !== undefined
              ? { count: input.backgroundWork.runningCount }
              : input.backgroundWork,
        })
      : isAgentRunning(input);

  let message = i18n.t("subagents.dialogs.archiveMessage", { label: subagentLabel });
  if (isRunning) {
    message = i18n.t("subagents.dialogs.archiveRunningMessage", { label: subagentLabel });
  } else if (input.backgroundWork?.count) {
    message = i18n.t("subagents.dialogs.archiveBackgroundMessage", { label: subagentLabel });
  }

  return {
    title: isRunning
      ? i18n.t("subagents.dialogs.archiveRunningTitle")
      : i18n.t("subagents.dialogs.archiveTitle"),
    message,
    confirmLabel: i18n.t("subagents.dialogs.archiveConfirm"),
    cancelLabel: i18n.t("subagents.dialogs.cancel"),
    destructive: true,
  };
}

export interface ArchiveSubagentDeps {
  getSubagent: (subagentId: string) => ResolveArchiveSubagentDialogInput | undefined;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  archiveAgent: (input: { serverId: string; agentId: string }) => Promise<void>;
  reportError: (error: unknown) => void;
}

export interface RequestArchiveSubagentInput {
  serverId: string;
  subagentId: string;
}

export async function requestArchiveSubagent(
  input: RequestArchiveSubagentInput,
  deps: ArchiveSubagentDeps,
): Promise<void> {
  const subagent = deps.getSubagent(input.subagentId);
  const confirmed = await deps.confirm(
    resolveArchiveSubagentDialog({
      title: subagent?.title,
      status: subagent?.status,
      turn: subagent?.turn,
      backgroundWork: subagent?.backgroundWork,
    }),
  );
  if (!confirmed) {
    return;
  }
  try {
    await deps.archiveAgent({ serverId: input.serverId, agentId: input.subagentId });
  } catch (error) {
    deps.reportError(error);
  }
}
