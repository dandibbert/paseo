import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind =
  | "archive-agent"
  | "replace-agent-with-draft"
  | "open-settings"
  | "open-agent-settings"
  | "open-provider-skills"
  | "refresh-provider-skills"
  | "open-provider-plugins"
  | "open-plugin-settings"
  | "open-provider-settings"
  | "open-terminal-settings";
export type ClientSlashCommandExecution = "immediate" | "insert";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.settings"
    | "composer.clientCommands.skills"
    | "composer.clientCommands.plugins"
    | "composer.clientCommands.providers"
    | "composer.clientCommands.terminals";
  argumentHint: string;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    kind: "archive-agent",
    execution: "immediate",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
    execution: "immediate",
  },
  {
    name: "skills",
    aliases: ["skill-manager"],
    description: "Manage skills for the current agent provider",
    descriptionKey: "composer.clientCommands.skills",
    argumentHint: "",
    kind: "open-provider-skills",
    execution: "immediate",
  },
  {
    name: "skills-refresh",
    aliases: ["refresh-skills"],
    description: "Reload skills from the current agent provider",
    descriptionKey: "composer.clientCommands.skills",
    argumentHint: "",
    kind: "refresh-provider-skills",
    execution: "immediate",
  },
  {
    name: "paseo-skills",
    aliases: [],
    description: "Manage Paseo orchestration skills for this host",
    descriptionKey: "composer.clientCommands.skills",
    argumentHint: "",
    kind: "open-agent-settings",
    execution: "immediate",
  },
  {
    name: "plugins",
    aliases: ["plugin-manager"],
    description: "Manage plugins for the current agent provider",
    descriptionKey: "composer.clientCommands.plugins",
    argumentHint: "",
    kind: "open-provider-plugins",
    execution: "immediate",
  },
  {
    name: "paseo-plugins",
    aliases: [],
    description: "Manage Paseo plugins for this host",
    descriptionKey: "composer.clientCommands.plugins",
    argumentHint: "",
    kind: "open-plugin-settings",
    execution: "immediate",
  },
  {
    name: "providers",
    aliases: ["provider-settings"],
    description: "Manage agent providers for this host",
    descriptionKey: "composer.clientCommands.providers",
    argumentHint: "",
    kind: "open-provider-settings",
    execution: "immediate",
  },
  {
    name: "terminals",
    aliases: ["terminal-settings"],
    description: "Manage terminal profiles for this host",
    descriptionKey: "composer.clientCommands.terminals",
    argumentHint: "",
    kind: "open-terminal-settings",
    execution: "immediate",
  },
  {
    name: "settings",
    aliases: [],
    description: "Open Paseo settings",
    descriptionKey: "composer.clientCommands.settings",
    argumentHint: "",
    kind: "open-settings",
    execution: "immediate",
  },
];

const COMMAND_BY_NAME = new Map<string, ClientSlashCommand>();
for (const command of CLIENT_SLASH_COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) {
    COMMAND_BY_NAME.set(alias, command);
  }
}

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
}): ClientSlashCommand | null {
  if (input.hasAttachments) {
    return null;
  }

  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const commandName = trimmed.slice(1);
  if (!commandName || /\s/.test(commandName)) {
    return null;
  }

  return COMMAND_BY_NAME.get(commandName) ?? null;
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}
