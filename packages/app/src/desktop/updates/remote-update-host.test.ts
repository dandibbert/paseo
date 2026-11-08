import { describe, expect, it } from "vitest";
import {
  runDesktopHostUpdateCommand,
  type DesktopHostUpdateDeps,
  type DesktopHostUpdateReport,
} from "./remote-update-host";

function deps(check: Awaited<ReturnType<DesktopHostUpdateDeps["check"]>> | Error) {
  const events: Array<string | DesktopHostUpdateReport> = [];
  const value: DesktopHostUpdateDeps = {
    defaultChannel: "stable",
    check: async (channel) => {
      events.push(`check:${channel}`);
      if (check instanceof Error) throw check;
      return check;
    },
    install: async (channel) => {
      events.push(`install:${channel}`);
    },
    report: async (report) => {
      events.push(report);
    },
  };
  return { events, deps: value };
}

const available = {
  hasUpdate: true,
  currentVersion: "0.15.0",
  latestVersion: "0.15.2",
  errorMessage: null,
};

describe("remote desktop update", () => {
  it("reports installing before it installs on the requested channel", async () => {
    const { events, deps: value } = deps(available);
    await runDesktopHostUpdateCommand(
      { commandId: "c1", releaseChannel: "beta", checkOnly: false },
      value,
    );
    expect(events).toEqual([
      "check:beta",
      {
        commandId: "c1",
        status: "installing",
        currentVersion: "0.15.0",
        latestVersion: "0.15.2",
        error: null,
      },
      "install:beta",
    ]);
  });

  it("uses the app's own channel and never installs for a check", async () => {
    const { events, deps: value } = deps(available);
    await runDesktopHostUpdateCommand(
      { commandId: "c2", releaseChannel: null, checkOnly: true },
      value,
    );
    expect(events).toEqual([
      "check:stable",
      expect.objectContaining({ status: "update_available" }),
    ]);
  });

  it("reports up to date and failures without installing", async () => {
    const current = deps({ ...available, hasUpdate: false, latestVersion: "0.15.0" });
    await runDesktopHostUpdateCommand(
      { commandId: "c3", releaseChannel: null, checkOnly: false },
      current.deps,
    );
    expect(current.events.at(-1)).toMatchObject({ status: "up_to_date" });

    const broken = deps(new Error("feed unreachable"));
    await runDesktopHostUpdateCommand(
      { commandId: "c4", releaseChannel: null, checkOnly: false },
      broken.deps,
    );
    expect(broken.events.at(-1)).toMatchObject({ status: "failed", error: "feed unreachable" });

    const rejected = deps({ ...available, errorMessage: "signature mismatch" });
    await runDesktopHostUpdateCommand(
      { commandId: "c5", releaseChannel: null, checkOnly: false },
      rejected.deps,
    );
    expect(rejected.events).not.toContain("install:stable");
    expect(rejected.events.at(-1)).toMatchObject({ status: "failed", error: "signature mismatch" });
  });

  it("reports a check that hangs instead of leaving the requester waiting", async () => {
    const reports: DesktopHostUpdateReport[] = [];
    await runDesktopHostUpdateCommand(
      { commandId: "c9", releaseChannel: "beta", checkOnly: true },
      {
        defaultChannel: "stable",
        check: () => new Promise(() => {}),
        install: async () => {},
        report: async (report) => {
          reports.push(report);
        },
        checkTimeoutMs: 10,
      },
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ commandId: "c9", status: "failed" });
    expect(reports[0]!.error).toContain("could not reach the update feed");
  });
});
