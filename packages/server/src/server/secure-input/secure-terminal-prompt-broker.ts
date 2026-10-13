import { randomUUID } from "node:crypto";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { SecureTerminalPrompt, TerminalAttentionRequired } from "@getpaseo/protocol/messages";

export type SecureTerminalPromptOutcome = "submitted" | "denied" | "expired" | "canceled";

interface PendingPrompt {
  descriptor: SecureTerminalPrompt;
  terminal: TerminalSession;
  settle: (outcome: SecureTerminalPromptOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
  unsubscribeExit: () => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface SecureTerminalPromptBrokerOptions {
  terminalManager: Pick<TerminalManager, "getTerminal">;
  publish: (message: TerminalAttentionRequired) => void;
  ttlMs?: number;
  createId?: () => string;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_PENDING_PROMPTS = 32;

/**
 * Holds only request metadata. The credential is delivered directly to the
 * selected PTY and never stored, returned to an agent, or published as an event.
 */
export class SecureTerminalPromptBroker {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly terminalManager: SecureTerminalPromptBrokerOptions["terminalManager"];
  private readonly publish: SecureTerminalPromptBrokerOptions["publish"];
  private readonly ttlMs: number;
  private readonly createId: () => string;

  constructor(options: SecureTerminalPromptBrokerOptions) {
    this.terminalManager = options.terminalManager;
    this.publish = options.publish;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.createId = options.createId ?? randomUUID;
  }

  list(): SecureTerminalPrompt[] {
    return [...this.pending.values()].map((item) => item.descriptor);
  }

  request(input: {
    agentId: string;
    workspaceId: string;
    terminalId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<SecureTerminalPromptOutcome> {
    const terminal = this.terminalManager.getTerminal(input.terminalId);
    if (!terminal) throw new Error("The target terminal no longer exists");
    if (terminal.workspaceId !== input.workspaceId) {
      throw new Error("Secure input can only target a terminal in the calling agent's workspace");
    }
    if (input.signal?.aborted) return Promise.resolve("canceled");
    if ([...this.pending.values()].some((item) => item.terminal.id === terminal.id)) {
      throw new Error("Another secure input request is already pending for this terminal");
    }
    if (this.pending.size >= MAX_PENDING_PROMPTS) {
      throw new Error("Too many secure input requests are pending");
    }

    const now = Date.now();
    const descriptor: SecureTerminalPrompt = {
      id: this.createId(),
      agentId: input.agentId,
      terminalId: terminal.id,
      terminalName: terminal.name,
      cwd: terminal.cwd,
      workspaceId: terminal.workspaceId,
      reason: input.reason.trim(),
      expiresAt: now + this.ttlMs,
    };

    return new Promise<SecureTerminalPromptOutcome>((resolve) => {
      const abortListener = () => this.finish(descriptor.id, "canceled");
      const timeout = setTimeout(() => this.finish(descriptor.id, "expired"), this.ttlMs);
      timeout.unref?.();
      const unsubscribeExit = terminal.onExit(() => this.finish(descriptor.id, "canceled"));
      this.pending.set(descriptor.id, {
        descriptor,
        terminal,
        settle: resolve,
        timeout,
        unsubscribeExit,
        abortSignal: input.signal,
        abortListener,
      });
      input.signal?.addEventListener("abort", abortListener, { once: true });
      if (input.signal?.aborted) {
        this.finish(descriptor.id, "canceled");
      } else {
        this.publishChange(descriptor, "pending");
      }
    });
  }

  respond(input: {
    promptId: string;
    action: "submit" | "deny";
    secret?: string;
    submitNewline?: boolean;
  }): { success: boolean; error: string | null } {
    const item = this.pending.get(input.promptId);
    if (!item) return { success: false, error: "This secure input request is no longer pending" };
    if (input.action === "deny") {
      this.finish(input.promptId, "denied");
      return { success: true, error: null };
    }

    const secret = input.secret;
    if (!secret || secret.length > 8192) {
      return { success: false, error: "Enter a secret of at most 8192 characters" };
    }
    if (secret.includes("\n") || secret.includes("\r") || secret.includes("\0")) {
      return { success: false, error: "A secret cannot contain newline or NUL characters" };
    }
    if (this.terminalManager.getTerminal(item.terminal.id) !== item.terminal) {
      this.finish(input.promptId, "canceled");
      return { success: false, error: "The target terminal is no longer available" };
    }
    try {
      item.terminal.send({
        type: "input",
        data: secret + (input.submitNewline === false ? "" : "\r"),
      });
    } catch {
      this.finish(input.promptId, "canceled");
      return { success: false, error: "Unable to send input to the terminal" };
    }
    this.finish(input.promptId, "submitted");
    return { success: true, error: null };
  }

  dispose(): void {
    for (const id of this.pending.keys()) this.finish(id, "canceled");
  }

  private finish(id: string, outcome: SecureTerminalPromptOutcome): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    clearTimeout(item.timeout);
    item.unsubscribeExit();
    if (item.abortListener) item.abortSignal?.removeEventListener("abort", item.abortListener);
    item.settle(outcome);
    this.publishChange(item.descriptor, "resolved");
  }

  private publishChange(prompt: SecureTerminalPrompt, state: "pending" | "resolved"): void {
    this.publish({
      type: "terminal_attention_required",
      payload: {
        terminalId: prompt.terminalId,
        cwd: prompt.cwd,
        workspaceId: prompt.workspaceId,
        reason: "needs_input",
        title: "Secure input requested",
        body: state === "pending" ? prompt.reason : "Secure input request resolved",
        shouldNotify: state === "pending",
        securePrompt: { ...prompt, state },
      },
    });
  }
}
