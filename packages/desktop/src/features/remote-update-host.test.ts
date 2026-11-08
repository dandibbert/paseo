import { describe, expect, it, vi } from "vitest";
import {
  runDesktopHostUpdateCommand,
  startRemoteUpdateHost,
  type DesktopHostUpdateCommand,
  type RemoteUpdateHostClient,
} from "./remote-update-host";

function fakeClient(installUpdate = true) {
  let commandHandler: ((message: { payload: DesktopHostUpdateCommand }) => void) | null = null;
  const reports: unknown[] = [];
  const client: RemoteUpdateHostClient = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getLastServerInfoMessage: () => ({ features: { installUpdate } }),
    subscribeConnectionStatus: () => () => {},
    on: (_type, handler) => {
      commandHandler = handler;
      return () => {
        commandHandler = null;
      };
    },
    registerDesktopHost: vi.fn(async () => true),
    reportDesktopHostUpdate: vi.fn(async (report) => {
      reports.push(report);
      return true;
    }),
  };
  return {
    client,
    reports,
    send: (payload: DesktopHostUpdateCommand) => commandHandler?.({ payload }),
  };
}

const log = { info: () => {}, warn: () => {} };

describe("runDesktopHostUpdateCommand", () => {
  it("reports installing before it starts the download that quits the app", async () => {
    const order: string[] = [];
    await runDesktopHostUpdateCommand(
      { commandId: "c1", releaseChannel: null, checkOnly: false },
      {
        defaultChannel: async () => "beta",
        check: async () => ({
          hasUpdate: true,
          currentVersion: "1",
          latestVersion: "2",
          errorMessage: null,
        }),
        install: async (channel) => order.push(`install:${channel}`),
        report: async (report) => order.push(`report:${report.status}`),
      },
    );
    expect(order).toEqual(["report:installing", "install:beta"]);
  });

  it("answers within its own deadline when the feed never responds", async () => {
    const reports: Array<{ status: string }> = [];
    await runDesktopHostUpdateCommand(
      { commandId: "c2", releaseChannel: "stable", checkOnly: true },
      {
        defaultChannel: async () => "stable",
        check: () => new Promise(() => {}),
        install: async () => {},
        report: async (report) => reports.push(report),
        checkTimeoutMs: 10,
      },
    );
    expect(reports.map((report) => report.status)).toEqual(["failed"]);
  });
});

describe("startRemoteUpdateHost", () => {
  it("registers with this app's daemon and answers a remote update without a window", async () => {
    const fake = fakeClient();
    const stop = startRemoteUpdateHost({
      readTarget: async () => ({ listen: "127.0.0.1:6767", key: "1:6767" }),
      createClient: () => fake.client,
      appVersion: "1",
      log,
      defaultChannel: async () => "beta",
      check: async () => ({
        hasUpdate: false,
        currentVersion: "1",
        latestVersion: "1",
        errorMessage: null,
      }),
      install: async () => {},
    });
    try {
      await vi.waitFor(() => expect(fake.client.registerDesktopHost).toHaveBeenCalled());
      fake.send({ commandId: "c3", releaseChannel: null, checkOnly: false });
      await vi.waitFor(() =>
        expect(fake.reports).toEqual([
          {
            commandId: "c3",
            status: "up_to_date",
            currentVersion: "1",
            latestVersion: "1",
            error: null,
          },
        ]),
      );
    } finally {
      stop();
    }
  });

  it("does not register with a daemon too old to take remote updates", async () => {
    const fake = fakeClient(false);
    const stop = startRemoteUpdateHost({
      readTarget: async () => ({ listen: "127.0.0.1:6767", key: "1:6767" }),
      createClient: () => fake.client,
      appVersion: "1",
      log,
      defaultChannel: async () => "beta",
      check: async () => ({
        hasUpdate: false,
        currentVersion: null,
        latestVersion: null,
        errorMessage: null,
      }),
      install: async () => {},
    });
    try {
      await vi.waitFor(() => expect(fake.client.close).toHaveBeenCalled());
      expect(fake.client.registerDesktopHost).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
