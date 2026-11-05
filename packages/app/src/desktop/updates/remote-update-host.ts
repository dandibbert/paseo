import type { DesktopReleaseChannel } from "@/desktop/updates/desktop-updates";

export interface DesktopHostUpdateCommand {
  commandId: string;
  releaseChannel: DesktopReleaseChannel | null;
  checkOnly: boolean;
}

export interface DesktopHostUpdateReport {
  commandId: string;
  status: "up_to_date" | "update_available" | "installing" | "failed";
  currentVersion: string | null;
  latestVersion: string | null;
  error: string | null;
}

export interface DesktopHostUpdateDeps {
  defaultChannel: DesktopReleaseChannel;
  check(channel: DesktopReleaseChannel): Promise<{
    hasUpdate: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
    errorMessage: string | null;
  }>;
  install(channel: DesktopReleaseChannel): Promise<unknown>;
  report(report: DesktopHostUpdateReport): Promise<unknown>;
}

/**
 * Runs an update the daemon forwarded from a remote `paseo host update`. Installing quits this
 * app, so the report goes out first; the daemon relays it to the requester before the restart.
 */
export async function runDesktopHostUpdateCommand(
  command: DesktopHostUpdateCommand,
  deps: DesktopHostUpdateDeps,
): Promise<void> {
  const channel = command.releaseChannel ?? deps.defaultChannel;
  const base = { commandId: command.commandId };
  let check: Awaited<ReturnType<DesktopHostUpdateDeps["check"]>>;
  try {
    check = await deps.check(channel);
  } catch (error) {
    await deps.report({
      ...base,
      status: "failed",
      currentVersion: null,
      latestVersion: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const versions = { currentVersion: check.currentVersion, latestVersion: check.latestVersion };
  if (check.errorMessage) {
    await deps.report({ ...base, ...versions, status: "failed", error: check.errorMessage });
    return;
  }
  if (!check.hasUpdate) {
    await deps.report({ ...base, ...versions, status: "up_to_date", error: null });
    return;
  }
  if (command.checkOnly) {
    await deps.report({ ...base, ...versions, status: "update_available", error: null });
    return;
  }
  await deps.report({ ...base, ...versions, status: "installing", error: null });
  await deps.install(channel);
}
