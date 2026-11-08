import type { DaemonInstallUpdateResult } from "@getpaseo/client";

/** What the host settings card shows for an install update answer from a connected host. */
export interface InstallUpdateOutcome {
  tone: "success" | "info" | "warning" | "error";
  /** Translation key under `settings.host.daemon.installUpdate`. */
  messageKey:
    | "upToDate"
    | "available"
    | "restarting"
    | "installed"
    | "busy"
    | "failed"
    | "unsupported";
  params: Record<string, string>;
  /** The install button the card offers next, if any. */
  next: "install" | "force" | null;
}

function agentNames(result: DaemonInstallUpdateResult): string {
  return (result.busyAgents ?? []).map((agent) => agent.title || agent.id).join(", ");
}

export function describeInstallUpdate(result: DaemonInstallUpdateResult): InstallUpdateOutcome {
  const current = result.currentVersion ?? "?";
  const target = result.targetVersion ?? "?";
  switch (result.status) {
    case "up_to_date":
      return { tone: "success", messageKey: "upToDate", params: { version: current }, next: null };
    case "update_available":
      return {
        tone: "info",
        messageKey: "available",
        params: { current, target },
        next: "install",
      };
    case "updating":
      return { tone: "success", messageKey: "restarting", params: { version: target }, next: null };
    case "installed":
      return { tone: "warning", messageKey: "installed", params: { version: target }, next: null };
    case "busy":
      return {
        tone: "warning",
        messageKey: "busy",
        params: { agents: agentNames(result) },
        next: "force",
      };
    default:
      if (result.installKind === "unsupported") {
        return {
          tone: "error",
          messageKey: "unsupported",
          params: { error: result.error ?? "" },
          next: null,
        };
      }
      return {
        tone: "error",
        messageKey: "failed",
        params: { error: result.error ?? result.status },
        next: null,
      };
  }
}
