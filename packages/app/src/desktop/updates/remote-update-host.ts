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
  /** How long a check may take; defaults to CHECK_TIMEOUT_MS. */
  checkTimeoutMs?: number;
}

// The requesting daemon gives up after two minutes. A check that cannot reach the feed (a
// broken network or proxy) would otherwise hang past that with no explanation.
const CHECK_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    const timeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    check = await withTimeout(
      deps.check(channel),
      timeoutMs,
      `Paseo Desktop on this host could not reach the update feed within ${Math.round(timeoutMs / 1000)} s. Check its network or proxy.`,
    );
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
