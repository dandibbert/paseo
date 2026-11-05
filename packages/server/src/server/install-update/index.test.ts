import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  busyAgents,
  DesktopHostBroker,
  detectInstallation,
  updateHeadless,
  type CommandRunner,
  type Installation,
} from "./index.js";

const SHA = "1234567890ab".padEnd(40, "c");
const dirs: string[] = [];

function headlessLayout(): { root: string; release: string; serverRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-install-"));
  dirs.push(root);
  const release = path.join(root, "releases", `headless-${SHA.slice(0, 12)}`);
  const serverRoot = path.join(release, "lib", "node_modules", "@getpaseo", "server");
  mkdirSync(serverRoot, { recursive: true });
  mkdirSync(path.join(release, "bin"));
  writeFileSync(path.join(release, "bin", "paseo"), "#!/bin/sh\n");
  writeFileSync(path.join(release, "bin", "paseo-headless-update.sh"), "#!/bin/sh\n");
  writeFileSync(
    path.join(release, "headless-build.json"),
    JSON.stringify({ sha: SHA, version: "0.15.2", platform: "linux", arch: "amd64" }),
  );
  return { root, release, serverRoot };
}

async function headless(): Promise<Extract<Installation, { kind: "headless" }>> {
  const { serverRoot } = headlessLayout();
  const installation = await detectInstallation({
    desktopManaged: false,
    serverPackageRoot: serverRoot,
    isNpmGlobal: false,
  });
  if (installation.kind !== "headless") throw new Error("Expected a headless install");
  return installation;
}

function recorder(latest: string): {
  calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
  run: CommandRunner;
} {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    run: async (_command, args, env) => {
      calls.push({ args, env });
      return { stdout: args[1] === "latest-tag" ? `${latest}\n` : "", stderr: "" };
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("install detection", () => {
  it("prefers the desktop app, then a headless release, then npm", async () => {
    const { root, release, serverRoot } = headlessLayout();
    expect(
      await detectInstallation({
        desktopManaged: true,
        serverPackageRoot: serverRoot,
        isNpmGlobal: true,
      }),
    ).toEqual({ kind: "desktop" });
    expect(
      await detectInstallation({
        desktopManaged: false,
        serverPackageRoot: serverRoot,
        isNpmGlobal: true,
      }),
    ).toEqual({
      kind: "headless",
      release,
      installRoot: root,
      helper: path.join(release, "bin", "paseo-headless-update.sh"),
      tag: `headless-${SHA.slice(0, 12)}`,
      version: "0.15.2",
    });
    expect(
      await detectInstallation({
        desktopManaged: false,
        serverPackageRoot: tmpdir(),
        isNpmGlobal: true,
      }),
    ).toEqual({ kind: "npm" });
    expect(
      (
        await detectInstallation({
          desktopManaged: false,
          serverPackageRoot: null,
          isNpmGlobal: false,
        })
      ).kind,
    ).toBe("unsupported");
  });
});

describe("headless update", () => {
  it("reports the running release as current without staging", async () => {
    const installation = await headless();
    const { calls, run } = recorder(installation.tag);
    const outcome = await updateHeadless(
      installation,
      { checkOnly: false, underService: true },
      run,
    );
    expect(outcome).toMatchObject({
      payload: { status: "up_to_date", targetVersion: installation.tag },
      followUp: "none",
    });
    expect(calls.map((call) => call.args[1])).toEqual(["latest-tag"]);
  });

  it("checks without staging", async () => {
    const { calls, run } = recorder("headless-ffffffffffff");
    const outcome = await updateHeadless(
      await headless(),
      { checkOnly: true, underService: true },
      run,
    );
    expect(outcome.payload).toMatchObject({
      status: "update_available",
      targetVersion: "headless-ffffffffffff",
    });
    expect(calls).toHaveLength(1);
  });

  it("stages and activates live, then exits for the service to restart", async () => {
    const installation = await headless();
    const { calls, run } = recorder("headless-ffffffffffff");
    const outcome = await updateHeadless(
      installation,
      { checkOnly: false, underService: true },
      run,
    );
    expect(outcome).toMatchObject({
      payload: { installKind: "headless", status: "updating", error: null },
      followUp: "exit_for_service_restart",
    });
    expect(calls.map((call) => call.args.slice(1))).toEqual([
      ["latest-tag"],
      ["stage", "headless-ffffffffffff"],
      ["activate", "headless-ffffffffffff"],
    ]);
    expect(calls.every((call) => call.env.PASEO_INSTALL_ROOT === installation.installRoot)).toBe(
      true,
    );
    expect(calls[2]!.env.PASEO_HEADLESS_LIVE_ACTIVATE).toBe("1");
    expect(calls[1]!.env.PASEO_HEADLESS_LIVE_ACTIVATE).toBeUndefined();
  });

  it("asks for a manual restart outside a service", async () => {
    const { run } = recorder("headless-ffffffffffff");
    const outcome = await updateHeadless(
      await headless(),
      { checkOnly: false, underService: false },
      run,
    );
    expect(outcome).toMatchObject({ payload: { status: "installed" }, followUp: "none" });
  });

  it("explains a release without the helper and surfaces helper failures", async () => {
    const installation = await headless();
    rmSync(installation.helper);
    const missing = await updateHeadless(
      installation,
      { checkOnly: false, underService: true },
      recorder("headless-ffffffffffff").run,
    );
    expect(missing.payload).toMatchObject({ status: "failed" });
    expect(missing.payload.error).toContain("predates remote updates");

    const failing: CommandRunner = async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "paseo-headless: SHA256 mismatch\n" });
    };
    const failed = await updateHeadless(
      await headless(),
      { checkOnly: false, underService: true },
      failing,
    );
    expect(failed).toMatchObject({
      payload: { status: "failed", error: "paseo-headless: SHA256 mismatch" },
      followUp: "none",
    });
  });
});

describe("desktop host broker", () => {
  it("fails without a desktop window", async () => {
    const outcome = await new DesktopHostBroker().update({ checkOnly: false });
    expect(outcome.payload).toMatchObject({ installKind: "desktop", status: "failed" });
  });

  it("relays the window's report and maps installing to updating", async () => {
    const broker = new DesktopHostBroker();
    const commands: Array<{ commandId: string; releaseChannel: string | null }> = [];
    broker.register({
      releaseChannel: "stable",
      appVersion: "0.15.0",
      command: (command) => {
        commands.push(command);
        queueMicrotask(() =>
          broker.report(command.commandId, {
            status: "installing",
            currentVersion: "0.15.0",
            latestVersion: "0.15.2-beta.1",
            error: null,
          }),
        );
      },
    });
    const outcome = await broker.update({ channel: "beta", checkOnly: false });
    expect(commands).toEqual([
      { commandId: expect.any(String), releaseChannel: "beta", checkOnly: false },
    ]);
    expect(outcome.payload).toEqual({
      installKind: "desktop",
      status: "updating",
      currentVersion: "0.15.0",
      targetVersion: "0.15.2-beta.1",
      error: null,
    });
    expect(
      broker.report(commands[0]!.commandId, {
        status: "failed",
        currentVersion: null,
        latestVersion: null,
        error: null,
      }),
    ).toBe(false);
  });

  it("times out when the window never answers and forgets closed windows", async () => {
    const broker = new DesktopHostBroker();
    const unregister = broker.register({
      releaseChannel: "stable",
      appVersion: null,
      command: () => {},
    });
    const outcome = await broker.update({ checkOnly: true }, 10);
    expect(outcome.payload.error).toContain("did not answer");
    unregister();
    expect((await broker.update({ checkOnly: true }, 10)).payload.error).toContain(
      "No Paseo Desktop window",
    );
  });
});

describe("busy agents", () => {
  it("counts running, starting, and permission-blocked agents", () => {
    const agent = (id: string, lifecycle: string, permissions = 0) => ({
      id,
      lifecycle,
      pendingPermissions: { size: permissions },
      config: { title: `Agent ${id}` },
    });
    expect(
      busyAgents([
        agent("a", "running"),
        agent("b", "idle"),
        agent("c", "initializing"),
        agent("d", "idle", 1),
        agent("e", "closed"),
      ]),
    ).toEqual([
      { id: "a", title: "Agent a", status: "running" },
      { id: "c", title: "Agent c", status: "initializing" },
      { id: "d", title: "Agent d", status: "waiting_for_permission" },
    ]);
  });
});
