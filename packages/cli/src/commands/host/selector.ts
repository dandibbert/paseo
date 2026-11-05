import type { HostDirectory } from "@getpaseo/client";

/** A daemon named on the command line: the selected daemon itself or one of its saved hosts. */
export interface SelectedHost {
  serverId: string;
  label: string;
  self: boolean;
}

export interface HostSelectorError {
  code: "host_unknown" | "host_ambiguous";
  message: string;
  details?: string;
}

/**
 * Resolves `self`, the selected daemon's server ID or label, or a saved host's server ID, label,
 * or registration ID. IDs win over a label they also match.
 */
export function resolveHostSelector(name: string, directory: HostDirectory): SelectedHost {
  if (name === "self" || name === directory.self.serverId || name === directory.self.label) {
    return { serverId: directory.self.serverId, label: directory.self.label, self: true };
  }
  const matches = directory.hosts.filter(
    (entry) => entry.serverId === name || entry.registrationId === name || entry.label === name,
  );
  const exact = matches.filter((entry) => entry.serverId === name || entry.registrationId === name);
  const selected = exact.length === 1 ? exact : matches;
  if (selected.length > 1) {
    throw {
      code: "host_ambiguous",
      message: `"${name}" matches ${selected.length} saved hosts`,
      details: "Use the server ID or registration ID from: paseo host ls",
    } satisfies HostSelectorError;
  }
  const entry = selected[0];
  if (!entry) {
    throw {
      code: "host_unknown",
      message: `Unknown host "${name}"`,
      details: "List saved hosts with: paseo host ls",
    } satisfies HostSelectorError;
  }
  if (!entry.serverId) {
    throw {
      code: "host_unknown",
      message: `Host "${name}" has not connected yet, so its server ID is unknown`,
      details: `Check its status with: paseo host inspect ${entry.registrationId}`,
    } satisfies HostSelectorError;
  }
  return { serverId: entry.serverId, label: entry.label ?? entry.serverId, self: false };
}
