import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  busyAgents,
  desktopHostBroker,
  detectInstallation,
  SERVICE_RESTART_EXIT_CODE,
  updateHeadless,
  type DesktopHostBroker,
  type Installation,
  type InstallUpdateOutcome,
} from "../../install-update/index.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import { daemonInstallOriginRuntime, resolveNpmGlobalPrefix } from "./install-origin.js";
import { daemonSelfUpdater, type DaemonSelfUpdater } from "./daemon-self-updater.js";

type InstallUpdateMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "daemon.install.update.request"
      | "daemon.desktop_host.register.request"
      | "daemon.desktop_host.update.report.request";
  }
>;

export type InstallUpdateLifecycleIntent =
  | { type: "restart"; clientId: string; requestId: string; reason: string; keepTerminals: boolean }
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
      exitCode: number;
    };

export interface InstallUpdateSessionControllerOptions {
  clientId: string;
  daemonVersion: string | null;
  desktopManaged: boolean;
  listAgents: () => ManagedAgent[];
  emit: (msg: SessionOutboundMessage) => void;
  emitLifecycleIntent: (intent: InstallUpdateLifecycleIntent) => void;
  logger: pino.Logger;
  broker?: DesktopHostBroker;
  detect?: () => Promise<Installation>;
  updateHeadless?: typeof updateHeadless;
  npmUpdater?: Pick<DaemonSelfUpdater, "update">;
  underService?: () => boolean;
}

const INSTALL_UPDATE_MESSAGE_TYPES: ReadonlySet<SessionInboundMessage["type"]> = new Set([
  "daemon.install.update.request",
  "daemon.desktop_host.register.request",
  "daemon.desktop_host.update.report.request",
]);

/**
 * Owns remote install updates for one session: the requester's `daemon.install.update` and, when
 * the session is the Paseo Desktop window that owns this daemon, its desktop-host registration.
 */
export class InstallUpdateSessionController {
  private readonly options: InstallUpdateSessionControllerOptions;
  private readonly broker: DesktopHostBroker;
  private unregisterDesktopHost: (() => void) | null = null;

  constructor(options: InstallUpdateSessionControllerOptions) {
    this.options = options;
    this.broker = options.broker ?? desktopHostBroker;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!INSTALL_UPDATE_MESSAGE_TYPES.has(msg.type)) return undefined;
    const message = msg as InstallUpdateMessage;
    if (message.type === "daemon.desktop_host.register.request") {
      this.registerDesktopHost(message);
      return undefined;
    }
    if (message.type === "daemon.desktop_host.update.report.request") {
      const accepted = this.broker.report(message.commandId, {
        status: message.status,
        currentVersion: message.currentVersion,
        latestVersion: message.latestVersion,
        error: message.error,
      });
      this.options.emit({
        type: "daemon.desktop_host.update.report.response",
        payload: { requestId: message.requestId, accepted },
      });
      return undefined;
    }
    return this.handleUpdate(message);
  }

  dispose(): void {
    this.unregisterDesktopHost?.();
    this.unregisterDesktopHost = null;
  }

  private registerDesktopHost(
    msg: Extract<InstallUpdateMessage, { type: "daemon.desktop_host.register.request" }>,
  ): void {
    this.dispose();
    // Only the app that launched this daemon can install it; other windows stay ordinary clients.
    if (this.options.desktopManaged) {
      this.unregisterDesktopHost = this.broker.register({
        releaseChannel: msg.releaseChannel,
        appVersion: msg.appVersion,
        command: (payload) =>
          this.options.emit({ type: "daemon.desktop_host.update.command", payload }),
      });
    }
    this.options.emit({
      type: "daemon.desktop_host.register.response",
      payload: { requestId: msg.requestId, registered: this.options.desktopManaged },
    });
  }

  private async handleUpdate(
    msg: Extract<InstallUpdateMessage, { type: "daemon.install.update.request" }>,
  ): Promise<void> {
    const checkOnly = msg.checkOnly === true;
    let outcome: InstallUpdateOutcome;
    try {
      const installation = await (this.options.detect ?? this.detect)();
      const busy = busyAgents(this.options.listAgents());
      if (!checkOnly && msg.force !== true && busy.length > 0) {
        outcome = {
          payload: {
            installKind: installation.kind,
            status: "busy",
            currentVersion: this.options.daemonVersion,
            targetVersion: null,
            busyAgents: busy,
            error: `${busy.length} agent(s) are running. Wait for them, or pass force to interrupt them.`,
          },
          followUp: "none",
        };
      } else {
        outcome = await this.update(installation, { channel: msg.channel, checkOnly });
        if (busy.length > 0) outcome.payload.busyAgents = busy;
      }
    } catch (error) {
      this.options.logger.error({ err: error }, "Install update failed");
      outcome = {
        payload: {
          installKind: "unsupported",
          status: "failed",
          currentVersion: this.options.daemonVersion,
          targetVersion: null,
          error: getErrorMessage(error),
        },
        followUp: "none",
      };
    }
    this.options.emit({
      type: "daemon.install.update.response",
      payload: { requestId: msg.requestId, ...outcome.payload },
    });
    if (outcome.followUp === "restart") {
      this.options.emitLifecycleIntent({
        type: "restart",
        clientId: this.options.clientId,
        requestId: msg.requestId,
        reason: "install_update",
        keepTerminals: true,
      });
    } else if (outcome.followUp === "exit_for_service_restart") {
      this.options.emitLifecycleIntent({
        type: "shutdown",
        clientId: this.options.clientId,
        requestId: msg.requestId,
        reason: "install_update",
        // systemd stops the whole service, terminal worker included.
        keepTerminals: false,
        exitCode: SERVICE_RESTART_EXIT_CODE,
      });
    }
  }

  private async update(
    installation: Installation,
    input: { channel?: "stable" | "beta"; checkOnly: boolean },
  ): Promise<InstallUpdateOutcome> {
    if (installation.kind === "desktop") return this.broker.update(input);
    if (installation.kind === "headless") {
      return (this.options.updateHeadless ?? updateHeadless)(installation, {
        ...input,
        underService: (this.options.underService ?? (() => Boolean(process.env.INVOCATION_ID)))(),
      });
    }
    if (installation.kind === "unsupported") {
      return {
        payload: {
          installKind: "unsupported",
          status: "failed",
          currentVersion: this.options.daemonVersion,
          targetVersion: null,
          error: installation.reason,
        },
        followUp: "none",
      };
    }
    const base = { installKind: "npm", currentVersion: this.options.daemonVersion };
    if (input.checkOnly) {
      return {
        payload: {
          ...base,
          status: "check_unsupported",
          targetVersion: null,
          error: "npm installs report their new version only after installing.",
        },
        followUp: "none",
      };
    }
    const result = await (this.options.npmUpdater ?? daemonSelfUpdater).update({
      daemonVersion: this.options.daemonVersion,
      desktopManaged: false,
      onProgress: () => {},
      logger: this.options.logger,
    });
    return {
      payload: {
        ...base,
        status: result.success ? "updating" : "failed",
        targetVersion: result.newVersion,
        error: result.error,
      },
      followUp: result.success ? "restart" : "none",
    };
  }

  private readonly detect = (): Promise<Installation> => {
    const serverPackageRoot = daemonInstallOriginRuntime.resolveCurrentServerPackageRoot();
    return detectInstallation({
      desktopManaged: this.options.desktopManaged,
      serverPackageRoot,
      isNpmGlobal: resolveNpmGlobalPrefix(serverPackageRoot) !== undefined,
    });
  };
}
