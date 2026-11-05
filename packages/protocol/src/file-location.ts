/** A file on a daemon: `path` is resolved against `cwd`, and reads and writes cannot leave `cwd`. */
export interface DaemonFileLocation {
  cwd: string;
  path: string;
}

/**
 * Maps a path on a daemon's machine to a file location. Absolute paths are scoped to their
 * filesystem root; `~` paths and relative paths to the daemon user's home directory. The daemon may
 * run a different OS than the caller, so POSIX and Windows drive forms are both recognized.
 */
export function toDaemonFileLocation(path: string): DaemonFileLocation {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("A file path is required");
  const drive = /^([a-zA-Z]:)[\\/]/.exec(trimmed);
  if (drive) return { cwd: `${drive[1]}\\`, path: trimmed };
  if (trimmed.startsWith("/")) return { cwd: "/", path: trimmed };
  return { cwd: "~", path: trimmed };
}
