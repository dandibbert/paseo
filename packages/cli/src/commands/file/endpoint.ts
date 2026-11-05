import type { HostDirectory } from "@getpaseo/client";

/** One side of `paseo file cp`. */
export type FileEndpoint =
  | { kind: "local"; path: string }
  | { kind: "host"; serverId: string; label: string; self: boolean; path: string };

export interface FileEndpointError {
  code: "invalid_path" | "host_unknown" | "host_ambiguous";
  message: string;
  details?: string;
}

/** Splits `host:path`. A Windows drive (`C:\` or `C:/`) is a local path, not a host named `C`. */
export function splitFileEndpoint(value: string): { host: string | null; path: string } {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return { host: null, path: value };
  const match = /^([^:/\\]+):(.*)$/.exec(value);
  if (!match) return { host: null, path: value };
  return { host: match[1]!, path: match[2]! };
}

/**
 * Resolves an endpoint argument. Unprefixed paths are on the machine running the CLI, like `scp`.
 * `host:path` selects the daemon itself (its server ID, its label, or `self`) or a saved host by
 * server ID, label, or registration ID.
 */
export function resolveFileEndpoint(value: string, directory: HostDirectory): FileEndpoint {
  const { host, path } = splitFileEndpoint(value);
  if (!path) {
    throw {
      code: "invalid_path",
      message: `Missing file path in "${value}"`,
    } satisfies FileEndpointError;
  }
  if (host === null) return { kind: "local", path };
  if (host === "self" || host === directory.self.serverId || host === directory.self.label) {
    return {
      kind: "host",
      serverId: directory.self.serverId,
      label: directory.self.label,
      self: true,
      path,
    };
  }
  const matches = directory.hosts.filter(
    (entry) => entry.serverId === host || entry.registrationId === host || entry.label === host,
  );
  const exact = matches.filter((entry) => entry.serverId === host || entry.registrationId === host);
  const selected = exact.length === 1 ? exact : matches;
  if (selected.length > 1) {
    throw {
      code: "host_ambiguous",
      message: `"${host}" matches ${selected.length} saved hosts`,
      details: "Use the server ID or registration ID from: paseo host ls",
    } satisfies FileEndpointError;
  }
  const entry = selected[0];
  if (!entry) {
    throw {
      code: "host_unknown",
      message: `Unknown host "${host}"`,
      details: "List saved hosts with: paseo host ls",
    } satisfies FileEndpointError;
  }
  if (!entry.serverId) {
    throw {
      code: "host_unknown",
      message: `Host "${host}" has not connected yet, so its server ID is unknown`,
      details: `Check its status with: paseo host inspect ${entry.registrationId}`,
    } satisfies FileEndpointError;
  }
  return {
    kind: "host",
    serverId: entry.serverId,
    label: entry.label ?? entry.serverId,
    self: false,
    path,
  };
}

/** Appends the source file name when the destination names a directory with a trailing slash. */
export function destinationFilePath(destination: string, sourcePath: string): string {
  if (!/[\\/]$/.test(destination) && destination !== "." && destination !== "~") {
    return destination;
  }
  const name = sourcePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  if (!name) throw { code: "invalid_path", message: `Cannot name a file after "${sourcePath}"` };
  const separator = /[\\/]$/.test(destination) ? "" : "/";
  return `${destination}${separator}${name}`;
}
