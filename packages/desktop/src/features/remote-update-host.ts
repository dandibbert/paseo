import type { AppReleaseChannel } from "./app-update-rollout.js";

/**
 * Answers `paseo host update` for this Mac from the main process. The renderer used to do this,
 * but a locked Mac with its display asleep throttles or suspends the window, so the daemon's
 * two-minute wait ran out with no answer. The main process keeps running.
 */

export interface DesktopHostUpdateCommand {
  commandId: string;
  releaseChannel: AppReleaseChannel | null;
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
  defaultChannel(): Promise<AppReleaseChannel>;
  check(channel: AppReleaseChannel): Promise<{
    hasUpdate: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
    errorMessage: string | null;
  }>;
  install(channel: AppReleaseChannel): Promise<unknown>;
  report(report: DesktopHostUpdateReport): Promise<unknown>;
  checkTimeoutMs?: number;
}

// The requesting daemon gives up after two minutes; a feed that never answers must not outlast it.
const CHECK_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Installing quits the app, so the report goes out before the download starts. */
export async function runDesktopHostUpdateCommand(
  command: DesktopHostUpdateCommand,
  deps: DesktopHostUpdateDeps,
): Promise<void> {
  const base = { commandId: command.commandId };
  let channel: AppReleaseChannel;
  let check: Awaited<ReturnType<DesktopHostUpdateDeps["check"]>>;
  try {
    channel = command.releaseChannel ?? (await deps.defaultChannel());
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
      error: messageOf(error),
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

/** The slice of DaemonClient this needs, so tests can drive it without a daemon. */
export interface RemoteUpdateHostClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { features?: { installUpdate?: boolean } } | null;
  subscribeConnectionStatus(listener: (status: { status: string }) => void): () => void;
  on(
    type: "daemon.desktop_host.update.command",
    handler: (message: { payload: DesktopHostUpdateCommand }) => void,
  ): () => void;
  registerDesktopHost(input: {
    releaseChannel: AppReleaseChannel;
    appVersion: string | null;
  }): Promise<boolean>;
  reportDesktopHostUpdate(report: DesktopHostUpdateReport): Promise<boolean>;
}

export interface RemoteUpdateHostDeps extends Omit<DesktopHostUpdateDeps, "report"> {
  /** The desktop-managed daemon this app should serve, or null when there is none. */
  readTarget(): Promise<{ listen: string; key: string } | null>;
  createClient(listen: string): RemoteUpdateHostClient;
  appVersion: string;
  log: { info(message: string): void; warn(message: string, error?: unknown): void };
  intervalMs?: number;
}

/**
 * Keeps one connection to this app's own daemon, registered as its desktop host. Rechecks on an
 * interval so a daemon restart, a new port or a dropped link is picked up without the window.
 */
export function startRemoteUpdateHost(deps: RemoteUpdateHostDeps): () => void {
  let current: { key: string; client: RemoteUpdateHostClient; detach: () => void } | null = null;
  let stopped = false;
  let busy = false;

  async function drop(): Promise<void> {
    const previous = current;
    current = null;
    if (!previous) return;
    previous.detach();
    await previous.client.close().catch(() => undefined);
  }

  async function attach(target: { listen: string; key: string }): Promise<void> {
    const client = deps.createClient(target.listen);
    await client.connect();
    if (client.getLastServerInfoMessage()?.features?.installUpdate !== true) {
      await client.close().catch(() => undefined);
      return;
    }
    const offCommand = client.on("daemon.desktop_host.update.command", (message) => {
      void runDesktopHostUpdateCommand(message.payload, {
        ...deps,
        report: (report) => client.reportDesktopHostUpdate(report),
      }).catch((error: unknown) => deps.log.warn("Remote desktop update failed", error));
    });
    const offStatus = client.subscribeConnectionStatus((status) => {
      if (status.status === "disconnected" && current?.client === client) void drop();
    });
    current = {
      key: target.key,
      client,
      detach: () => {
        offCommand();
        offStatus();
      },
    };
    const registered = await client.registerDesktopHost({
      releaseChannel: await deps.defaultChannel(),
      appVersion: deps.appVersion,
    });
    deps.log.info(`Registered as this daemon's desktop host: ${registered}`);
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const target = await deps.readTarget();
      if (current && current.key === target?.key) return;
      await drop();
      if (target) await attach(target);
    } catch (error) {
      deps.log.warn("Could not attach the desktop update host", error);
      await drop();
    } finally {
      busy = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 15_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    void drop();
  };
}
