import os from "node:os";
import path from "node:path";

/**
 * The host's personal space: a folder the user can see, where a conversation starts when it is
 * about the whole computer rather than one project. Paseo treats it as an ordinary workspace but
 * never watches or indexes it, since agents there reach far beyond it.
 */
export function personalSpaceRoot(homeDir: string = os.homedir()): string {
  // Tests and unusual setups point it elsewhere; the default is a folder the user can see.
  const override = process.env.PASEO_PERSONAL_SPACE_DIR?.trim();
  return override ? path.resolve(override) : path.join(homeDir, "Paseo");
}

export function isPersonalSpacePath(cwd: string | null | undefined, homeDir?: string): boolean {
  if (!cwd) return false;
  return path.resolve(cwd) === path.resolve(personalSpaceRoot(homeDir));
}

/** Told to every agent that starts in the personal space, on every launch and resume. */
export function personalSpaceSystemPrompt(input: {
  cwd: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  const homeDir = input.homeDir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const search =
    platform === "darwin"
      ? "To find files, use Spotlight (`mdfind`, e.g. `mdfind -onlyin ~ 'kMDItemFSName == \"*.pdf\"'`) instead of walking the disk."
      : "To find files, prefer an index (`locate`, `plocate`) or a bounded search (`fd`, `rg` with a root) over walking the whole disk.";
  return [
    "You are running in the user's Paseo personal space: you are their general personal assistant, not working in one project.",
    `Their home directory is ${homeDir}. Your working directory, ${input.cwd}, is your scratch area for notes, temporary scripts and files you create; tasks are not limited to it, so use absolute paths anywhere on the computer.`,
    search,
    "Do not delete or move files outside your working directory unless the user asks you to.",
  ].join("\n");
}
