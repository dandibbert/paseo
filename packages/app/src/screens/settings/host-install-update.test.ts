import { describe, expect, it } from "vitest";
import { describeInstallUpdate } from "./host-install-update";

const base = {
  requestId: "r1",
  installKind: "desktop",
  currentVersion: "0.15.3-personal.79",
  targetVersion: null,
  error: null,
};

describe("describeInstallUpdate", () => {
  it("offers to install an available update", () => {
    expect(
      describeInstallUpdate({
        ...base,
        status: "update_available",
        targetVersion: "0.15.3-personal.80",
      }),
    ).toEqual({
      tone: "info",
      messageKey: "available",
      params: { current: "0.15.3-personal.79", target: "0.15.3-personal.80" },
      next: "install",
    });
  });

  it("reports a host that is already current", () => {
    expect(describeInstallUpdate({ ...base, status: "up_to_date" })).toMatchObject({
      tone: "success",
      messageKey: "upToDate",
      next: null,
    });
  });

  it("names running agents and offers to update anyway", () => {
    expect(
      describeInstallUpdate({
        ...base,
        status: "busy",
        busyAgents: [
          { id: "a1", title: "Fix login", status: "running" },
          { id: "a2", title: null, status: "waiting_for_permission" },
        ],
      }),
    ).toEqual({
      tone: "warning",
      messageKey: "busy",
      params: { agents: "Fix login, a2" },
      next: "force",
    });
  });

  it("tells a restarting host apart from one that needs a manual restart", () => {
    const updating = describeInstallUpdate({
      ...base,
      installKind: "headless",
      status: "updating",
      targetVersion: "headless-2229932d4b76",
    });
    const installed = describeInstallUpdate({
      ...base,
      installKind: "headless",
      status: "installed",
      targetVersion: "headless-2229932d4b76",
    });
    expect([updating.messageKey, installed.messageKey]).toEqual(["restarting", "installed"]);
    expect(installed.tone).toBe("warning");
  });

  it("surfaces the host's error, and an unsupported install", () => {
    expect(
      describeInstallUpdate({
        ...base,
        status: "failed",
        error: "No Paseo Desktop window is connected to this daemon.",
      }),
    ).toMatchObject({
      tone: "error",
      messageKey: "failed",
      params: { error: "No Paseo Desktop window is connected to this daemon." },
    });
    expect(
      describeInstallUpdate({
        ...base,
        installKind: "unsupported",
        status: "failed",
        error: "Not a Paseo Desktop, headless release, or npm global install",
      }).messageKey,
    ).toBe("unsupported");
  });
});
