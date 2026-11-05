import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SessionOutboundMessage } from "../../messages.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import { DesktopHostBroker, type Installation } from "../../install-update/index.js";
import {
  InstallUpdateSessionController,
  type InstallUpdateLifecycleIntent,
} from "./install-update-session-controller.js";

const headless: Installation = {
  kind: "headless",
  release: "/srv/paseo/releases/headless-111111111111",
  installRoot: "/srv/paseo",
  helper: "/srv/paseo/releases/headless-111111111111/bin/paseo-headless-update.sh",
  tag: "headless-111111111111",
  version: "0.15.2",
};

function runningAgent(): ManagedAgent {
  return {
    id: "agent-1",
    lifecycle: "running",
    pendingPermissions: new Map(),
    config: { title: "Refactor" },
  } as unknown as ManagedAgent;
}

function setup(
  options: { agents?: ManagedAgent[]; desktopManaged?: boolean; broker?: DesktopHostBroker } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const intents: InstallUpdateLifecycleIntent[] = [];
  const headlessCalls: unknown[] = [];
  const controller = new InstallUpdateSessionController({
    clientId: "client-1",
    daemonVersion: "0.15.2",
    desktopManaged: options.desktopManaged ?? false,
    listAgents: () => options.agents ?? [],
    emit: (msg) => emitted.push(msg),
    emitLifecycleIntent: (intent) => intents.push(intent),
    logger: pino({ level: "silent" }),
    broker: options.broker ?? new DesktopHostBroker(),
    detect: async () => (options.desktopManaged ? { kind: "desktop" } : headless),
    updateHeadless: async (_installation, input) => {
      headlessCalls.push(input);
      return {
        payload: {
          installKind: "headless",
          status: input.checkOnly ? "update_available" : "updating",
          currentVersion: "0.15.2 (headless-111111111111)",
          targetVersion: "headless-222222222222",
          error: null,
        },
        followUp: input.checkOnly ? "none" : "exit_for_service_restart",
      };
    },
    underService: () => true,
  });
  return { controller, emitted, intents, headlessCalls };
}

describe("install update session controller", () => {
  it("refuses while agents run, without touching the install", async () => {
    const { controller, emitted, intents, headlessCalls } = setup({ agents: [runningAgent()] });
    await controller.dispatch({ type: "daemon.install.update.request", requestId: "r1" });
    expect(emitted).toEqual([
      {
        type: "daemon.install.update.response",
        payload: expect.objectContaining({
          requestId: "r1",
          status: "busy",
          busyAgents: [{ id: "agent-1", title: "Refactor", status: "running" }],
        }),
      },
    ]);
    expect(headlessCalls).toEqual([]);
    expect(intents).toEqual([]);
  });

  it("still checks while agents run, listing them", async () => {
    const { controller, emitted } = setup({ agents: [runningAgent()] });
    await controller.dispatch({
      type: "daemon.install.update.request",
      requestId: "r2",
      checkOnly: true,
    });
    expect(emitted[0]).toMatchObject({
      payload: { status: "update_available", busyAgents: [{ id: "agent-1" }] },
    });
  });

  it("answers, then exits with the service restart code when forced", async () => {
    const { controller, emitted, intents } = setup({ agents: [runningAgent()] });
    await controller.dispatch({
      type: "daemon.install.update.request",
      requestId: "r3",
      force: true,
    });
    expect(emitted[0]).toMatchObject({ payload: { requestId: "r3", status: "updating" } });
    expect(intents).toEqual([
      {
        type: "shutdown",
        clientId: "client-1",
        requestId: "r3",
        reason: "install_update",
        keepTerminals: false,
        exitCode: 75,
      },
    ]);
  });

  it("registers a desktop host only on a desktop-managed daemon and forwards commands", async () => {
    const plain = setup();
    await plain.controller.dispatch({
      type: "daemon.desktop_host.register.request",
      requestId: "reg",
      releaseChannel: "stable",
      appVersion: null,
    });
    expect(plain.emitted).toEqual([
      {
        type: "daemon.desktop_host.register.response",
        payload: { requestId: "reg", registered: false },
      },
    ]);

    const broker = new DesktopHostBroker();
    const desktop = setup({ desktopManaged: true, broker });
    await desktop.controller.dispatch({
      type: "daemon.desktop_host.register.request",
      requestId: "reg",
      releaseChannel: "beta",
      appVersion: "0.15.2",
    });
    const updating = broker.update({ checkOnly: true });
    const command = desktop.emitted.find(
      (message) => message.type === "daemon.desktop_host.update.command",
    );
    expect(command).toMatchObject({ payload: { releaseChannel: null, checkOnly: true } });
    await desktop.controller.dispatch({
      type: "daemon.desktop_host.update.report.request",
      requestId: "rep",
      commandId: (command as { payload: { commandId: string } }).payload.commandId,
      status: "up_to_date",
      currentVersion: "0.15.2",
      latestVersion: "0.15.2",
      error: null,
    });
    expect((await updating).payload).toMatchObject({ status: "up_to_date" });

    desktop.controller.dispose();
    expect((await broker.update({ checkOnly: true }, 10)).payload.error).toContain(
      "No Paseo Desktop window",
    );
  });
});
