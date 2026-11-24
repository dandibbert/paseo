export type ParsedComposerInput =
  | { mode: "shell"; command: string }
  | { mode: "chat"; text: string };

export function parseComposerShellInput(text: string): ParsedComposerInput {
  if (text.startsWith("\\!")) {
    return {
      mode: "chat",
      text: `!${text.slice(2)}`,
    };
  }
  if (text.startsWith("!")) {
    return {
      mode: "shell",
      command: text.slice(1),
    };
  }
  return {
    mode: "chat",
    text,
  };
}

export type ShellSubmitBlockReason =
  | "unsupported"
  | "attachments_conflict"
  | "empty"
  | "disconnected";

export function validateComposerShellSubmit(params: {
  command: string;
  hasAttachments: boolean;
  isShellSupported: boolean;
  isConnected: boolean;
  hasAgent: boolean;
}): { allowed: boolean; reason: ShellSubmitBlockReason | null } {
  if (!params.isConnected || !params.hasAgent) {
    return { allowed: false, reason: "disconnected" };
  }
  if (!params.isShellSupported) {
    return { allowed: false, reason: "unsupported" };
  }
  if (params.hasAttachments) {
    return { allowed: false, reason: "attachments_conflict" };
  }
  if (params.command.trim().length === 0) {
    return { allowed: false, reason: "empty" };
  }
  return { allowed: true, reason: null };
}
