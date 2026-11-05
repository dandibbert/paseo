import { Command } from "commander";
import {
  createPaseoApi,
  type DaemonInstallUpdateResult,
  type HostDirectory,
  type PaseoApi,
} from "@getpaseo/client";
import {
  withOutput,
  type CommandOptions,
  type CommandResult,
  type OutputSchema,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { resolveHostSelector, type SelectedHost } from "./selector.js";

interface UpdateOptions extends CommandOptions {
  all?: boolean;
  channel?: string;
  check?: boolean;
  force?: boolean;
  wait?: boolean;
  timeout?: string;
}

export interface HostUpdateRow {
  host: string;
  serverId: string;
  installKind: string;
  status: string;
  currentVersion: string | null;
  targetVersion: string | null;
  detail: string | null;
}

const schema: OutputSchema<HostUpdateRow> = {
  idField: "serverId",
  columns: [
    { header: "HOST", field: "host" },
    { header: "KIND", field: "installKind" },
    { header: "STATUS", field: "status" },
    { header: "CURRENT", field: (row) => row.currentVersion ?? "-" },
    { header: "TARGET", field: (row) => row.targetVersion ?? "-" },
    { header: "DETAIL", field: (row) => row.detail ?? "" },
  ],
};

/** Hosts to update: the names given, or every connected host for `--all`. */
export function selectUpdateTargets(
  names: string[],
  all: boolean,
  directory: HostDirectory,
): SelectedHost[] {
  if (all && names.length > 0) {
    throw { code: "invalid_option", message: "Pass host names or --all, not both" };
  }
  if (all) {
    return directory.hosts.flatMap((entry) =>
      entry.enabled && entry.serverId
        ? [{ serverId: entry.serverId, label: entry.label ?? entry.serverId, self: false }]
        : [],
    );
  }
  if (names.length === 0) {
    throw {
      code: "invalid_option",
      message: "Name the hosts to update, or pass --all",
      details: "List hosts with: paseo host ls. Use `self` for the selected daemon.",
    };
  }
  const selected = names.map((name) => resolveHostSelector(name, directory));
  return selected.filter(
    (host, index) => selected.findIndex((other) => other.serverId === host.serverId) === index,
  );
}

export function describeUpdate(result: DaemonInstallUpdateResult): string | null {
  if (result.status === "busy") {
    const agents = (result.busyAgents ?? [])
      .map((agent) => `${agent.title ?? agent.id} (${agent.status})`)
      .join(", ");
    return `Running agents: ${agents}. Wait for them, or pass --force to interrupt them.`;
  }
  return result.error;
}

function parseChannel(value: string | undefined): "stable" | "beta" | undefined {
  if (value === undefined) return undefined;
  if (value === "stable" || value === "beta") return value;
  throw { code: "invalid_option", message: "--channel must be stable or beta" };
}

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) return 10 * 60_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw { code: "invalid_option", message: "--timeout must be a positive number of seconds" };
  }
  return seconds * 1000;
}

/** Waits for a routed host to drop its link for the restart and come back online. */
async function waitForReturn(api: PaseoApi, serverId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wentAway = false;
  while (Date.now() < deadline) {
    const entry = (await api.hosts.list()).hosts.find((host) => host.serverId === serverId);
    if (entry?.status !== "online") wentAway = true;
    else if (wentAway) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function updateOne(input: {
  api: PaseoApi;
  host: SelectedHost;
  channel: "stable" | "beta" | undefined;
  check: boolean;
  force: boolean;
  wait: boolean;
  timeoutMs: number;
}): Promise<HostUpdateRow> {
  const { api, host } = input;
  const row = { host: host.self ? `${host.label} (self)` : host.label, serverId: host.serverId };
  const scope = host.self ? api : await api.hosts.client(host.serverId);
  try {
    if (!scope.daemon.supportsInstallUpdate()) {
      return {
        ...row,
        installKind: "unknown",
        status: "unsupported",
        currentVersion: null,
        targetVersion: null,
        detail: "This host's Paseo predates remote updates. Update it once on the host itself.",
      };
    }
    const result = await scope.daemon.installUpdate({
      channel: input.channel,
      checkOnly: input.check,
      force: input.force,
    });
    const updated: HostUpdateRow = {
      ...row,
      installKind: result.installKind,
      status: result.status,
      currentVersion: result.currentVersion,
      targetVersion: result.targetVersion,
      detail: describeUpdate(result),
    };
    if (result.status !== "updating" || !input.wait) return updated;
    if (host.self) {
      return { ...updated, detail: "The selected daemon is restarting; reconnect to check it." };
    }
    const back = await waitForReturn(api, host.serverId, input.timeoutMs);
    return back
      ? { ...updated, status: "updated", detail: "Back online" }
      : { ...updated, detail: "Restarting; not back online before --timeout" };
  } finally {
    if (scope !== api) await scope.dispose().catch(() => undefined);
  }
}

async function runUpdate(
  names: string[],
  options: UpdateOptions,
): Promise<CommandResult<HostUpdateRow>> {
  const channel = parseChannel(options.channel);
  const timeoutMs = parseTimeoutMs(options.timeout);
  const daemon = await connectToDaemon({ target: options.daemonTarget });
  const api = createPaseoApi(daemon);
  try {
    const targets = selectUpdateTargets(names, options.all === true, await daemon.listHosts());
    // Update the selected daemon last: restarting it ends this connection.
    const ordered = [
      ...targets.filter((host) => !host.self),
      ...targets.filter((host) => host.self),
    ];
    const rows: HostUpdateRow[] = [];
    for (const host of ordered) {
      rows.push(
        await updateOne({
          api,
          host,
          channel,
          check: options.check === true,
          force: options.force === true,
          wait: options.wait !== false,
          timeoutMs,
        }).catch((error: unknown) => ({
          host: host.label,
          serverId: host.serverId,
          installKind: "unknown",
          status: "failed",
          currentVersion: null,
          targetVersion: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      );
    }
    return { type: "list", data: rows, schema };
  } finally {
    await api.dispose().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

export function addHostUpgradeCommand(host: Command): void {
  addJsonAndDaemonHostOptions(
    host
      .command("upgrade")
      .description(
        "Upgrade Paseo on connected hosts: Paseo Desktop installs its app update, a headless Linux release installs the latest headless release and restarts its service, and an npm install updates the package. Name hosts as in `paseo host ls`, `self` for the selected daemon, or pass --all.",
      )
      .argument("[hosts...]")
      .option("--all", "Update every enabled connected host")
      .option(
        "--channel <channel>",
        "Paseo Desktop release channel: stable or beta (default: the host's setting)",
      )
      .option("--check", "Report installed and available versions without installing")
      .option("--force", "Update even while agents are running; their turns are interrupted")
      .option("--no-wait", "Return once each host starts restarting")
      .option("--timeout <seconds>", "How long to wait for each host to come back (default 600)"),
  ).action(
    withOutput((names: string[], options: UpdateOptions, _command: Command) =>
      runUpdate(names, options),
    ),
  );
}
