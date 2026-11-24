import { randomUUID } from "node:crypto";
import type { AgentAttachment, AgentShellContextEntry } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";

type TextAttachment = Extract<AgentAttachment, { type: "text" }>;

export const MAX_SHELL_CONTEXT_ENTRIES = 20;
export const MAX_SHELL_ENTRY_OUTPUT_BYTES = 8 * 1024;
export const MAX_SHELL_ATTACHMENT_BYTES = 32 * 1024;
export const MAX_SHELL_DISPLAY_LINES = 200;

const TRUNCATION_MARKER = "[...earlier output truncated...]\n";

export class AgentShellBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentShellBusyError";
  }
}

export class AgentShellInvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentShellInvalidRequestError";
  }
}

export interface AgentShellRunResult {
  callId: string;
  terminalId: string;
  command: string;
  cwd: string;
  status: "running";
  startedAt: string;
}

export interface AgentShellFinishResult {
  callId: string;
  terminalId: string;
  status: "completed" | "failed";
  exitCode: number | null;
  entry: AgentShellContextEntry;
}

export interface AgentShellServiceDependencies {
  agentManager: Pick<
    AgentManager,
    | "getAgent"
    | "listAgents"
    | "setShellTerminalId"
    | "getPendingShellContext"
    | "updatePendingShellContext"
    | "upsertUserShellTimelineItem"
  >;
  terminalManager: TerminalManager;
  logger: Logger;
  resolveWorkspaceId?: (cwd: string) => Promise<string>;
  isTerminalBusyByOther?: (terminalId: string) => boolean;
}

interface ActiveShellCommand {
  agentId: string;
  callId: string;
  command: string;
  cwd: string;
  terminalId: string;
  startedAt: string;
  isWrapped: boolean;
  baselineLines: string[];
  finished: boolean;
  unsubscribeCommandFinished: () => void;
  unsubscribeExit: () => void;
  finalizePromise: Promise<AgentShellFinishResult> | null;
}

export function formatShellCommandInput(rawCommand: string): {
  input: string;
  isWrapped: boolean;
  normalizedCommand: string;
} {
  const normalizedCommand = rawCommand.replaceAll("\r\n", "\n").replace(/\n+$/g, "");
  if (normalizedCommand.includes("\n")) {
    return {
      input: `\x15{\n${normalizedCommand}\n}\r`,
      isWrapped: true,
      normalizedCommand,
    };
  }
  return {
    input: `\x15${normalizedCommand}\r`,
    isWrapped: false,
    normalizedCommand,
  };
}

function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function trimLeadingEmptyLines(lines: readonly string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "") {
    start += 1;
  }
  return lines.slice(start);
}

function findBaselineContinuationStart(
  baselineLines: readonly string[],
  afterLines: readonly string[],
): number {
  const trimmedBaseline = trimTrailingEmptyLines(baselineLines);
  if (trimmedBaseline.length <= 1) {
    return 0;
  }

  // Keep everything up to (but not including) the last non-empty prompt line so that
  // line edits caused by \x15 + echoed command still leave the prompt+echo in the slice.
  const prefix = trimmedBaseline.slice(0, -1);
  if (
    afterLines.length >= prefix.length &&
    prefix.every((line, index) => afterLines[index] === line)
  ) {
    return prefix.length;
  }

  // Fallback when scrollback shifted between baseline and completion: search backwards
  // for a short anchor from the end of `prefix`.
  const anchorLen = Math.min(4, prefix.length);
  const anchor = prefix.slice(prefix.length - anchorLen);
  for (let i = afterLines.length - anchorLen; i >= 0; i -= 1) {
    let matched = true;
    for (let j = 0; j < anchorLen; j += 1) {
      if (afterLines[i + j] !== anchor[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i + anchorLen;
    }
  }

  return 0;
}

function isBraceOpenLine(trimmed: string): boolean {
  return (
    trimmed === "{" ||
    trimmed.endsWith(" {") ||
    trimmed.endsWith("% {") ||
    trimmed.endsWith("$ {") ||
    trimmed.endsWith("❯ {")
  );
}

function stripWrappedCommandEcho(lines: readonly string[], cmdLineCount: number): string[] | null {
  const searchLimit = Math.min(lines.length, cmdLineCount + 12);
  let sawOpenBrace = false;
  for (let i = 0; i < searchLimit; i += 1) {
    const trimmed = lines[i]?.trimEnd() ?? "";
    if (!sawOpenBrace && isBraceOpenLine(trimmed)) {
      sawOpenBrace = true;
      continue;
    }
    if (sawOpenBrace && (trimmed === "}" || /\s\}$/.test(trimmed))) {
      return lines.slice(i + 1);
    }
  }
  return null;
}

function stripLeadingCommandEcho(
  lines: readonly string[],
  command: string,
  isWrapped: boolean,
): string[] {
  if (lines.length === 0) {
    return [];
  }
  if (isWrapped) {
    const cmdLineCount = command
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    const stripped = stripWrappedCommandEcho(lines, cmdLineCount);
    if (stripped) {
      return stripped;
    }
  }

  const normalizedTarget = command.trim();
  if (!normalizedTarget) {
    return [...lines];
  }

  // Single-line (or long wrapped single-line) echo check at start of slice.
  let combined = "";
  const maxEchoRows = Math.min(lines.length, 6);
  for (let i = 0; i < maxEchoRows; i += 1) {
    const line = lines[i]?.trimEnd() ?? "";
    combined = i === 0 ? line : `${combined}${line}`;
    if (line.endsWith(normalizedTarget) || combined.endsWith(normalizedTarget)) {
      return lines.slice(i + 1);
    }
  }

  return [...lines];
}

function stripTrailingPromptLine(
  lines: readonly string[],
  baselineLines: readonly string[],
): string[] {
  if (lines.length === 0) {
    return [];
  }
  const trimmedBaseline = trimTrailingEmptyLines(baselineLines);
  const lastBaselineLine = trimmedBaseline[trimmedBaseline.length - 1]?.trimEnd();
  const lastLine = lines[lines.length - 1]?.trimEnd() ?? "";
  if (lastBaselineLine && lastLine === lastBaselineLine) {
    return lines.slice(0, -1);
  }
  return [...lines];
}

export function extractCommandOutput(params: {
  baselineLines: readonly string[];
  afterLines: readonly string[];
  command: string;
  isWrapped: boolean;
  stripTrailingPrompt?: boolean;
}): string {
  const start = findBaselineContinuationStart(params.baselineLines, params.afterLines);
  let extracted = trimTrailingEmptyLines(params.afterLines.slice(start));
  extracted = stripLeadingCommandEcho(extracted, params.command, params.isWrapped);
  extracted = trimLeadingEmptyLines(extracted);
  extracted = trimTrailingEmptyLines(extracted);
  if (params.stripTrailingPrompt) {
    extracted = stripTrailingPromptLine(extracted, params.baselineLines);
    extracted = trimTrailingEmptyLines(extracted);
  }
  return extracted.join("\n");
}

export function formatShellDisplayOutput(output: string): string {
  if (!output) {
    return "";
  }
  const lines = output.split("\n");
  if (lines.length <= MAX_SHELL_DISPLAY_LINES) {
    return output;
  }
  const tail = lines.slice(-MAX_SHELL_DISPLAY_LINES).join("\n");
  return `...(showing last ${MAX_SHELL_DISPLAY_LINES} lines)\n${tail}`;
}

function sliceUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  let start = buf.byteLength - maxBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx) so we never split a multi-byte char.
  while (start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

export function truncateShellContextOutput(
  output: string,
  maxBytes = MAX_SHELL_ENTRY_OUTPUT_BYTES,
): {
  output: string;
  outputBytes: number;
  truncated: boolean;
} {
  const totalBytes = Buffer.byteLength(output, "utf8");
  if (totalBytes <= maxBytes) {
    return {
      output,
      outputBytes: totalBytes,
      truncated: false,
    };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const lines = output.split("\n");
  const kept: string[] = [];
  let usedBytes = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const separatorBytes = kept.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (usedBytes + separatorBytes + lineBytes <= budget) {
      kept.unshift(line);
      usedBytes += separatorBytes + lineBytes;
    } else {
      break;
    }
  }

  const body = kept.length > 0 ? kept.join("\n") : sliceUtf8Tail(output, budget);
  const finalOutput = `${TRUNCATION_MARKER}${body}`;
  return {
    output: finalOutput,
    outputBytes: Buffer.byteLength(finalOutput, "utf8"),
    truncated: true,
  };
}

function formatShellEntryBlock(entry: AgentShellContextEntry): string {
  const exitText = entry.exitCode === null ? "unknown" : String(entry.exitCode);
  const header = `$ ${entry.command}\n[cwd: ${entry.cwd} | exit: ${exitText} | completed: ${entry.completedAt}]`;
  if (!entry.output) {
    return `${header}\n(no output)`;
  }
  return `${header}\n${entry.output}`;
}

export function buildPendingShellTextAttachment(
  entries: readonly AgentShellContextEntry[],
  maxTotalBytes = MAX_SHELL_ATTACHMENT_BYTES,
): {
  attachment: TextAttachment;
  attachedIds: string[];
} | null {
  if (entries.length === 0) {
    return null;
  }

  const intro =
    "The user executed the following terminal command(s) in this workspace prior to sending this message:\n\n";
  const introBytes = Buffer.byteLength(intro, "utf8");
  const selectedReversed: Array<{ id: string; block: string }> = [];
  let runningBytes = introBytes;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const block = formatShellEntryBlock(entry);
    const sepBytes = selectedReversed.length > 0 ? 2 : 0; // "\n\n"
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (runningBytes + sepBytes + blockBytes <= maxTotalBytes) {
      selectedReversed.push({ id: entry.id, block });
      runningBytes += sepBytes + blockBytes;
    } else if (selectedReversed.length === 0) {
      // Always include at least the most recent entry, trimmed to fit budget.
      const trimmedBudget = Math.max(0, maxTotalBytes - introBytes - 200);
      const truncated = truncateShellContextOutput(entry.output, trimmedBudget);
      const fallbackBlock = formatShellEntryBlock({
        ...entry,
        output: truncated.output,
        outputBytes: truncated.outputBytes,
        truncated: true,
      });
      selectedReversed.push({ id: entry.id, block: fallbackBlock });
      break;
    } else {
      break;
    }
  }

  const selected = selectedReversed.toReversed();
  const text = `${intro}${selected.map((item) => item.block).join("\n\n")}`;
  const attachment: TextAttachment = {
    type: "text",
    mimeType: "text/plain",
    contextKind: "user_shell_commands",
    title:
      selected.length === 1
        ? "User terminal command"
        : `User terminal commands (${selected.length})`,
    text,
  };
  return {
    attachment,
    attachedIds: selected.map((item) => item.id),
  };
}

export function appendShellAttachmentsToPrompt(
  existing: readonly AgentAttachment[] | undefined,
  shellAttachment: TextAttachment | null,
): AgentAttachment[] | undefined {
  if (!shellAttachment) {
    return existing ? [...existing] : undefined;
  }
  return [...(existing ?? []), shellAttachment];
}

export class AgentShellService {
  private readonly agentManager: AgentShellServiceDependencies["agentManager"];
  private readonly terminalManager: TerminalManager;
  private readonly logger: Logger;
  private readonly resolveWorkspaceId?: (cwd: string) => Promise<string>;
  private readonly isTerminalBusyByOther?: (terminalId: string) => boolean;

  private readonly activeByAgentId = new Map<string, ActiveShellCommand>();
  private readonly activeByTerminalId = new Map<string, ActiveShellCommand>();
  private readonly dedicatedTerminalIds = new Set<string>();
  private readonly agentMutationQueues = new Map<string, Promise<unknown>>();

  constructor(deps: AgentShellServiceDependencies) {
    this.agentManager = deps.agentManager;
    this.terminalManager = deps.terminalManager;
    this.logger = deps.logger.child({ module: "agent", component: "agent-shell-service" });
    this.resolveWorkspaceId = deps.resolveWorkspaceId;
    this.isTerminalBusyByOther = deps.isTerminalBusyByOther;
  }

  isDedicatedShellTerminal(terminalId: string): boolean {
    if (this.dedicatedTerminalIds.has(terminalId)) {
      return true;
    }
    for (const agent of this.agentManager.listAgents({ includeInternal: true })) {
      if (agent.shellTerminalId === terminalId) {
        this.dedicatedTerminalIds.add(terminalId);
        return true;
      }
    }
    return false;
  }

  /**
   * Closes an archived or deleted agent's dedicated shell. A command still running in it is
   * killed with the terminal; its card ends through the terminal's exit like any other exit.
   * Unarchiving does not bring the shell back: the next ! command opens a new one.
   */
  async closeDedicatedTerminal(terminalId: string | undefined): Promise<void> {
    if (!terminalId || !this.isDedicatedShellTerminal(terminalId)) return;
    // End the running command's card first, while the agent is still loaded to record it.
    const active = this.activeByTerminalId.get(terminalId);
    if (active && !active.finished) {
      await this.finalizeActiveCommand(active, {
        exitCode: null,
        stripTrailingPrompt: false,
        exited: true,
      }).catch((error: unknown) =>
        this.logger.warn({ err: error, terminalId }, "Could not end the shell command's card"),
      );
    }
    if (this.terminalManager.getTerminal(terminalId)) {
      this.terminalManager.killTerminal(terminalId);
    }
    this.dedicatedTerminalIds.delete(terminalId);
  }

  isTerminalBusy(terminalId: string): boolean {
    return this.activeByTerminalId.has(terminalId);
  }

  hasRunningCommandForAgent(agentId: string): boolean {
    return this.activeByAgentId.has(agentId);
  }

  async runCommand(params: { agentId: string; command: string }): Promise<AgentShellRunResult> {
    const trimmed = params.command.trim();
    if (!trimmed) {
      throw new AgentShellInvalidRequestError("Command cannot be empty");
    }

    const agent = this.requirePublicLiveAgent(params.agentId);
    if (this.activeByAgentId.has(agent.id)) {
      throw new AgentShellBusyError("A terminal command is already running for this agent");
    }

    const terminal = await this.ensureDedicatedTerminal(agent);
    if (this.activeByTerminalId.has(terminal.id) || this.isTerminalBusyByOther?.(terminal.id)) {
      throw new AgentShellBusyError(`Terminal ${terminal.id} is currently busy`);
    }

    const baseline = await this.terminalManager.captureTerminal(terminal.id, {
      start: 0,
      stripAnsi: true,
    });

    const formatted = formatShellCommandInput(params.command);
    const callId = `user-shell-${randomUUID()}`;
    const startedAt = new Date().toISOString();

    const active: ActiveShellCommand = {
      agentId: agent.id,
      callId,
      command: formatted.normalizedCommand,
      cwd: terminal.cwd,
      terminalId: terminal.id,
      startedAt,
      isWrapped: formatted.isWrapped,
      baselineLines: baseline.lines,
      finished: false,
      unsubscribeCommandFinished: () => undefined,
      unsubscribeExit: () => undefined,
      finalizePromise: null,
    };

    this.activeByAgentId.set(agent.id, active);
    this.activeByTerminalId.set(terminal.id, active);

    active.unsubscribeCommandFinished = terminal.onCommandFinished((info) => {
      this.finalizeInBackground(active, {
        exitCode: info.exitCode,
        stripTrailingPrompt: false,
      });
    });

    active.unsubscribeExit = terminal.onExit((info) => {
      this.finalizeInBackground(active, {
        exitCode: info.exitCode,
        stripTrailingPrompt: false,
        exited: true,
        signal: info.signal,
      });
    });

    try {
      const runningItem: Extract<AgentTimelineItem, { type: "tool_call" }> = {
        type: "tool_call",
        callId,
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: formatted.normalizedCommand,
          cwd: terminal.cwd,
          origin: "user",
          terminalId: terminal.id,
        },
      };
      await this.agentManager.upsertUserShellTimelineItem(agent.id, runningItem, {
        timestamp: startedAt,
      });

      terminal.send({ type: "input", data: formatted.input });
    } catch (error) {
      this.cleanupActive(active);
      throw error;
    }

    return {
      callId,
      terminalId: terminal.id,
      command: formatted.normalizedCommand,
      cwd: terminal.cwd,
      status: "running",
      startedAt,
    };
  }

  async finishCommand(params: {
    agentId: string;
    callId?: string;
  }): Promise<AgentShellFinishResult> {
    this.requirePublicLiveAgent(params.agentId);
    const active = this.activeByAgentId.get(params.agentId);
    if (!active) {
      throw new AgentShellInvalidRequestError("No running terminal command for this agent");
    }
    if (params.callId && active.callId !== params.callId) {
      throw new AgentShellInvalidRequestError(
        `Command ${params.callId} is not the active terminal command`,
      );
    }

    return this.finalizeActiveCommand(active, {
      exitCode: null,
      stripTrailingPrompt: true,
    });
  }

  async updatePendingContext(params: {
    agentId: string;
    remove?: readonly string[];
    clear?: boolean;
  }): Promise<AgentShellContextEntry[]> {
    this.requirePublicLiveAgent(params.agentId);
    return this.runAgentContextMutation(params.agentId, async () => {
      const current = this.agentManager.getPendingShellContext(params.agentId);
      let next = current;
      if (params.clear) {
        next = [];
      } else if (params.remove?.length) {
        const removeSet = new Set(params.remove);
        next = current.filter((entry) => !removeSet.has(entry.id));
      }
      return this.agentManager.updatePendingShellContext(params.agentId, next);
    });
  }

  async consumePendingContextIds(
    agentId: string,
    consumedIds: readonly string[],
  ): Promise<AgentShellContextEntry[]> {
    if (consumedIds.length === 0) {
      return this.agentManager.getPendingShellContext(agentId);
    }
    const idSet = new Set(consumedIds);
    return this.runAgentContextMutation(agentId, async () => {
      const current = this.agentManager.getPendingShellContext(agentId);
      const remaining = current.filter((entry) => !idSet.has(entry.id));
      return this.agentManager.updatePendingShellContext(agentId, remaining);
    });
  }

  buildPromptAttachmentForAgent(agentId: string): {
    attachment: TextAttachment;
    attachedIds: string[];
  } | null {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !agent.pendingShellContext?.length) {
      return null;
    }
    return buildPendingShellTextAttachment(agent.pendingShellContext);
  }

  private requirePublicLiveAgent(agentId: string): ManagedAgent {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.internal || agent.lifecycle === "closed") {
      throw new AgentShellInvalidRequestError(`Unknown or closed agent '${agentId}'`);
    }
    return agent;
  }

  private async ensureDedicatedTerminal(agent: ManagedAgent): Promise<TerminalSession> {
    if (agent.shellTerminalId) {
      this.dedicatedTerminalIds.add(agent.shellTerminalId);
      const existing = this.terminalManager.getTerminal(agent.shellTerminalId);
      if (existing && existing.getExitInfo() === null) {
        return existing;
      }
    }

    const workspaceId =
      agent.workspaceId ??
      (this.resolveWorkspaceId ? await this.resolveWorkspaceId(agent.cwd) : agent.cwd);
    const titlePrefix = agent.config.title?.trim() || "Agent";
    const terminal = await this.terminalManager.createTerminal({
      cwd: agent.cwd,
      workspaceId,
      name: `${titlePrefix} · shell`,
    });
    this.dedicatedTerminalIds.add(terminal.id);
    await this.agentManager.setShellTerminalId(agent.id, terminal.id);
    return terminal;
  }

  private cleanupActive(active: ActiveShellCommand): void {
    active.unsubscribeCommandFinished();
    active.unsubscribeExit();
    if (this.activeByAgentId.get(active.agentId) === active) {
      this.activeByAgentId.delete(active.agentId);
    }
    if (this.activeByTerminalId.get(active.terminalId) === active) {
      this.activeByTerminalId.delete(active.terminalId);
    }
  }

  private finalizeActiveCommand(
    active: ActiveShellCommand,
    options: {
      exitCode: number | null;
      stripTrailingPrompt: boolean;
      exited?: boolean;
      signal?: number | null;
    },
  ): Promise<AgentShellFinishResult> {
    if (active.finalizePromise) {
      return active.finalizePromise;
    }
    active.finished = true;
    this.cleanupActive(active);

    active.finalizePromise = (async () => {
      let rawOutput = "";
      try {
        const after = await this.terminalManager.captureTerminal(active.terminalId, {
          start: 0,
          stripAnsi: true,
        });
        rawOutput = extractCommandOutput({
          baselineLines: active.baselineLines,
          afterLines: after.lines,
          command: active.command,
          isWrapped: active.isWrapped,
          stripTrailingPrompt: options.stripTrailingPrompt,
        });
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: active.agentId, terminalId: active.terminalId },
          "Failed to capture terminal output on shell command finish",
        );
      }

      const displayOutput = formatShellDisplayOutput(rawOutput);
      const contextOutput = truncateShellContextOutput(rawOutput);
      const completedAt = new Date().toISOString();

      const failed =
        (options.exitCode !== null && options.exitCode !== 0) ||
        (options.exited === true && options.exitCode === null);
      const detail = {
        type: "shell" as const,
        command: active.command,
        cwd: active.cwd,
        output: displayOutput,
        exitCode: options.exitCode,
        origin: "user" as const,
        terminalId: active.terminalId,
      };
      let failedError = "Command exited with unknown status";
      if (options.exited) {
        failedError =
          options.signal == null
            ? "Terminal exited before command completed"
            : `Terminal exited (signal ${options.signal})`;
      } else if (options.exitCode !== null) {
        failedError = `Command exited with status ${options.exitCode}`;
      }
      const updatedItem: Extract<AgentTimelineItem, { type: "tool_call" }> = failed
        ? {
            type: "tool_call",
            callId: active.callId,
            name: "shell",
            status: "failed",
            detail,
            error: failedError,
          }
        : {
            type: "tool_call",
            callId: active.callId,
            name: "shell",
            status: "completed",
            detail,
            error: null,
          };

      if (!this.agentManager.getAgent(active.agentId)) {
        // The agent was archived or deleted while the command ran; nothing is left to record on.
        return {
          callId: active.callId,
          terminalId: active.terminalId,
          status: updatedItem.status,
          exitCode: options.exitCode,
          entry: {
            id: active.callId,
            command: active.command,
            cwd: active.cwd,
            exitCode: options.exitCode,
            output: contextOutput.output,
            outputBytes: contextOutput.outputBytes,
            completedAt,
            terminalId: active.terminalId,
          },
        };
      }
      await this.agentManager.upsertUserShellTimelineItem(active.agentId, updatedItem, {
        timestamp: active.startedAt,
      });

      const entry: AgentShellContextEntry = {
        id: active.callId,
        command: active.command,
        cwd: active.cwd,
        exitCode: options.exitCode,
        output: contextOutput.output,
        outputBytes: contextOutput.outputBytes,
        ...(contextOutput.truncated ? { truncated: true } : {}),
        completedAt,
        terminalId: active.terminalId,
      };

      await this.runAgentContextMutation(active.agentId, async () => {
        const current = this.agentManager.getPendingShellContext(active.agentId);
        const next = [...current, entry].slice(-MAX_SHELL_CONTEXT_ENTRIES);
        return this.agentManager.updatePendingShellContext(active.agentId, next);
      });

      return {
        callId: active.callId,
        terminalId: active.terminalId,
        status: updatedItem.status,
        exitCode: options.exitCode,
        entry,
      };
    })();

    return active.finalizePromise;
  }

  /** Terminal callbacks cannot await; a failed finish is logged, never left unhandled. */
  private finalizeInBackground(
    active: ActiveShellCommand,
    options: Parameters<AgentShellService["finalizeActiveCommand"]>[1],
  ): void {
    this.finalizeActiveCommand(active, options).catch((error: unknown) =>
      this.logger.warn(
        { err: error, agentId: active.agentId, callId: active.callId },
        "Could not record the end of a shell command",
      ),
    );
  }

  private async runAgentContextMutation<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.agentMutationQueues.get(agentId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.agentMutationQueues.set(agentId, settled);
    void settled.finally(() => {
      if (this.agentMutationQueues.get(agentId) === settled) {
        this.agentMutationQueues.delete(agentId);
      }
    });
    return next;
  }
}
