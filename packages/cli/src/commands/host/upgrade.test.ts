import { describe, expect, it } from "vitest";
import type { HostDirectory } from "@getpaseo/client";
import { describeUpdate, selectUpdateTargets } from "./upgrade.js";

function host(overrides: Partial<HostDirectory["hosts"][number]>): HostDirectory["hosts"][number] {
  return {
    registrationId: "hst_1",
    serverId: "srv_mac",
    label: "mac-2",
    source: { id: "owner", key: "k" },
    metadata: {},
    enabled: true,
    status: "online",
    targetDescription: "relay://relay.example:443/srv_mac",
    lastOnlineAt: null,
    nextRetryAt: null,
    error: null,
    ...overrides,
  };
}

const directory: HostDirectory = {
  self: { serverId: "srv_linux", label: "linux" },
  hosts: [
    host({}),
    host({ registrationId: "hst_2", serverId: "srv_studio", label: "studio" }),
    host({ registrationId: "hst_3", serverId: "srv_off", label: "off", enabled: false }),
    host({ registrationId: "hst_4", serverId: null, label: "pending" }),
  ],
};

describe("host upgrade targets", () => {
  it("selects every enabled, identified host for --all, excluding the selected daemon", () => {
    expect(selectUpdateTargets([], true, directory).map((target) => target.serverId)).toEqual([
      "srv_mac",
      "srv_studio",
    ]);
  });

  it("resolves names once each and accepts self", () => {
    expect(selectUpdateTargets(["mac-2", "srv_mac", "self"], false, directory)).toEqual([
      { serverId: "srv_mac", label: "mac-2", self: false },
      { serverId: "srv_linux", label: "linux", self: true },
    ]);
  });

  it("requires names or --all, never both", () => {
    expect(() => selectUpdateTargets([], false, directory)).toThrow(
      expect.objectContaining({ code: "invalid_option" }),
    );
    expect(() => selectUpdateTargets(["mac-2"], true, directory)).toThrow(
      expect.objectContaining({ code: "invalid_option" }),
    );
  });

  it("names the running agents that block an upgrade", () => {
    expect(
      describeUpdate({
        requestId: "r",
        installKind: "headless",
        status: "busy",
        currentVersion: null,
        targetVersion: null,
        busyAgents: [{ id: "a1", title: "Refactor", status: "running" }],
        error: "1 agent(s) are running.",
      }),
    ).toBe("Running agents: Refactor (running). Wait for them, or pass --force to interrupt them.");
  });
});
