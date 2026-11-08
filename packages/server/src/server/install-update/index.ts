import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { DaemonInstallUpdateResponse } from "@getpaseo/protocol/messages";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";

export type InstallUpdatePayload = Omit<DaemonInstallUpdateResponse["payload"], "requestId">;
export type InstallUpdateChannel = "stable" | "beta";

export interface InstallUpdateInput {
  channel?: InstallUpdateChannel;
  checkOnly: boolean;
}

/** What the daemon does after it has answered the request. */
export type InstallUpdateFollowUp = "none" | "restart" | "exit_for_service_restart";

export interface InstallUpdateOutcome {
  payload: InstallUpdatePayload;
  followUp: InstallUpdateFollowUp;
}

export interface BusyAgent {
  id: string;
  title: string | null;
  status: string;
}

// systemd's Restart=on-failure starts the current release again after this code.
export const SERVICE_RESTART_EXIT_CODE = 75;

const HeadlessBuildSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  version: z.string(),
});

const HEADLESS_TAG = /^headless-[0-9a-f]{12}$/;

export type Installation =
  | { kind: "desktop" }
  | {
      kind: "headless";
      release: string;
      installRoot: string;
      helper: string;
      tag: string;
      version: string;
    }
  | { kind: "npm" }
  | { kind: "unsupported"; reason: string };

/**
 * Finds the installation this daemon runs from. A headless release is a directory under
 * `<root>/releases/` holding `headless-build.json`, with the server package inside its
 * `lib/node_modules`.
 */
export async function detectInstallation(input: {
  desktopManaged: boolean;
  serverPackageRoot: string | null;
  isNpmGlobal: boolean;
}): Promise<Installation> {
  if (input.desktopManaged) return { kind: "desktop" };
  const release = input.serverPackageRoot
    ? await findHeadlessRelease(input.serverPackageRoot)
    : null;
  if (release) {
    const parsed = HeadlessBuildSchema.safeParse(
      JSON.parse(await readFile(path.join(release, "headless-build.json"), "utf8")),
    );
    if (!parsed.success) {
      return { kind: "unsupported", reason: "headless-build.json is unreadable" };
    }
    const releases = path.dirname(release);
    if (path.basename(releases) !== "releases") {
      return {
        kind: "unsupported",
        reason: `Headless release ${release} is not inside an install root's releases directory`,
      };
    }
    return {
      kind: "headless",
      release,
      installRoot: path.dirname(releases),
      helper: path.join(release, "bin", "paseo-headless-update.sh"),
      tag: `headless-${parsed.data.sha.slice(0, 12)}`,
      version: parsed.data.version,
    };
  }
  if (input.isNpmGlobal) return { kind: "npm" };
  return {
    kind: "unsupported",
    reason: "This daemon is not a Paseo Desktop, headless release, or npm global install",
  };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function findHeadlessRelease(start: string): Promise<string | null> {
  let directory = start;
  while (path.dirname(directory) !== directory) {
    if (
      (await exists(path.join(directory, "headless-build.json"))) &&
      (await exists(path.join(directory, "bin", "paseo")))
    ) {
      return directory;
    }
    directory = path.dirname(directory);
  }
  return null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (command, args, env) => {
  const result = await execFileAsync(command, args, {
    env,
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

/**
 * Stages and activates the latest headless release with the helper shipped in the running
 * release. Activation only swaps symlinks; the running process keeps its files until it exits.
 */
export async function updateHeadless(
  installation: Extract<Installation, { kind: "headless" }>,
  input: InstallUpdateInput & { underService: boolean },
  run: CommandRunner = runCommand,
): Promise<InstallUpdateOutcome> {
  const base = {
    installKind: "headless",
    currentVersion: `${installation.version} (${installation.tag})`,
  };
  if (!(await exists(installation.helper))) {
    return {
      payload: {
        ...base,
        status: "failed",
        targetVersion: null,
        error:
          "This release predates remote updates. Update it once on the host with paseo-headless-update.sh.",
      },
      followUp: "none",
    };
  }
  const env = { ...process.env, PASEO_INSTALL_ROOT: installation.installRoot };
  try {
    const latest = (await run("bash", [installation.helper, "latest-tag"], env)).stdout.trim();
    if (!HEADLESS_TAG.test(latest)) throw new Error(`Unexpected latest release tag: ${latest}`);
    if (latest === installation.tag) {
      return {
        payload: { ...base, status: "up_to_date", targetVersion: latest, error: null },
        followUp: "none",
      };
    }
    if (input.checkOnly) {
      return {
        payload: { ...base, status: "update_available", targetVersion: latest, error: null },
        followUp: "none",
      };
    }
    await run("bash", [installation.helper, "stage", latest], env);
    await run("bash", [installation.helper, "activate", latest], {
      ...env,
      // The daemon exits right after this swap so its service starts the new release.
      PASEO_HEADLESS_LIVE_ACTIVATE: "1",
    });
    return {
      payload: {
        ...base,
        status: input.underService ? "updating" : "installed",
        targetVersion: latest,
        error: input.underService
          ? null
          : "Installed. This daemon is not running under systemd; restart it to use the new release.",
      },
      followUp: input.underService ? "exit_for_service_restart" : "none",
    };
  } catch (error) {
    return {
      payload: { ...base, status: "failed", targetVersion: null, error: commandError(error) },
      followUp: "none",
    };
  }
}

function commandError(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim())
    return stderr.trim().split("\n").slice(-5).join("\n");
  return getErrorMessage(error);
}

export interface DesktopHostReport {
  status: string;
  currentVersion: string | null;
  latestVersion: string | null;
  error: string | null;
}

interface DesktopHost {
  releaseChannel: InstallUpdateChannel;
  appVersion: string | null;
  command(input: {
    commandId: string;
    releaseChannel: InstallUpdateChannel | null;
    checkOnly: boolean;
  }): void;
}

/**
 * Connects remote install updates to the Paseo Desktop window that owns this daemon. Only the
 * desktop app can replace itself, so the daemon forwards the request and relays the report the
 * window sends before it quits to install.
 */
export class DesktopHostBroker {
  private readonly hosts = new Set<DesktopHost>();
  private readonly pending = new Map<string, (report: DesktopHostReport) => void>();

  register(host: DesktopHost): () => void {
    this.hosts.add(host);
    return () => {
      this.hosts.delete(host);
    };
  }

  report(commandId: string, report: DesktopHostReport): boolean {
    const resolve = this.pending.get(commandId);
    if (!resolve) return false;
    this.pending.delete(commandId);
    resolve(report);
    return true;
  }

  async update(input: InstallUpdateInput, timeoutMs = 120_000): Promise<InstallUpdateOutcome> {
    const host = [...this.hosts].at(-1);
    const base = { installKind: "desktop", targetVersion: null };
    if (!host) {
      return {
        payload: {
          ...base,
          status: "failed",
          currentVersion: null,
          error:
            "No Paseo Desktop window is connected to this daemon. Open Paseo Desktop on the host, or update it there.",
        },
        followUp: "none",
      };
    }
    const commandId = randomUUID();
    const reported = new Promise<DesktopHostReport>((resolve) => {
      this.pending.set(commandId, resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    host.command({
      commandId,
      releaseChannel: input.channel ?? null,
      checkOnly: input.checkOnly,
    });
    const report = await Promise.race([reported, timedOut]);
    clearTimeout(timer);
    this.pending.delete(commandId);
    if (!report) {
      return {
        payload: {
          ...base,
          status: "failed",
          currentVersion: host.appVersion,
          error:
            "Paseo Desktop did not answer the update request in time. Its window may be closed or not connected to this daemon.",
        },
        followUp: "none",
      };
    }
    return {
      payload: {
        installKind: "desktop",
        status: report.status === "installing" ? "updating" : report.status,
        currentVersion: report.currentVersion ?? host.appVersion,
        targetVersion: report.latestVersion,
        error: report.error,
      },
      // The desktop app quits, installs and relaunches; it restarts this daemon itself.
      followUp: "none",
    };
  }
}

export const desktopHostBroker = new DesktopHostBroker();

export function busyAgents(
  agents: Array<{
    id: string;
    lifecycle: string;
    pendingPermissions: { size: number };
    config: { title?: string | null };
  }>,
): BusyAgent[] {
  return agents
    .filter(
      (agent) =>
        agent.lifecycle === "running" ||
        agent.lifecycle === "initializing" ||
        agent.pendingPermissions.size > 0,
    )
    .map((agent) => ({
      id: agent.id,
      title: agent.config.title ?? null,
      status: agent.pendingPermissions.size > 0 ? "waiting_for_permission" : agent.lifecycle,
    }));
}
