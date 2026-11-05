import type { DaemonFileLocation } from "@getpaseo/protocol/file-location";
import type {
  DaemonClient,
  FileExplorerDirectoryPayload,
  FilePutResult,
  FileReadResult,
} from "../daemon-client.js";

/**
 * A file on the daemon this API is bound to. Use `toDaemonFileLocation` to address an absolute or
 * `~` path.
 */
export type PaseoFileLocation = DaemonFileLocation;

export interface PaseoFileReadOptions extends PaseoFileLocation {
  /** Fail instead of transferring a file larger than this. */
  maxBytes?: number;
  /** Bounds the whole transfer. `0` disables the timer. Defaults to no limit. */
  timeoutMs?: number;
}

export interface PaseoFileWriteOptions extends PaseoFileLocation {
  bytes: Uint8Array | ArrayBuffer;
  /** Replace an existing file. Without it, an existing target rejects with code `exists`. */
  overwrite?: boolean;
  /** Create missing parent directories inside `cwd`. */
  createParents?: boolean;
}

export interface PaseoFileActions {
  read(options: PaseoFileReadOptions): Promise<FileReadResult>;
  /** Streams bytes to the daemon. Requires a daemon with `server_info.features.filePut`. */
  write(options: PaseoFileWriteOptions): Promise<NonNullable<FilePutResult["file"]>>;
  list(location: PaseoFileLocation): Promise<FileExplorerDirectoryPayload>;
}

export class PaseoFileError extends Error {
  constructor(
    message: string,
    public readonly code: "exists" | "unsupported" | "failed",
  ) {
    super(message);
    this.name = "PaseoFileError";
  }
}

export function createFileActions(daemonClient: DaemonClient): PaseoFileActions {
  return {
    read: (options) =>
      daemonClient.readFile(
        options.cwd,
        options.path,
        undefined,
        options.maxBytes,
        options.timeoutMs ?? 0,
      ),
    async write(options) {
      const result = await daemonClient.putFile(options);
      if (result.file) return result.file;
      throw new PaseoFileError(
        result.error ?? "File write failed",
        fileErrorCode(result.errorCode),
      );
    },
    list: (location) => daemonClient.listDirectory(location.cwd, location.path),
  };
}

function fileErrorCode(code: string | null): PaseoFileError["code"] {
  if (code === "exists" || code === "unsupported") return code;
  return "failed";
}
