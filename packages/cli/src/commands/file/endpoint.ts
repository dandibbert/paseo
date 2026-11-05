import type { HostDirectory } from "@getpaseo/client";
import { resolveHostSelector } from "../host/selector.js";

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
 * `host:path` names a daemon as `resolveHostSelector` does.
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
  return { kind: "host", ...resolveHostSelector(host, directory), path };
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
