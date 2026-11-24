import { randomUUID } from "node:crypto";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { TerminalAttentionRequired, TerminalControlPrompt } from "@getpaseo/protocol/messages";

export type TerminalControlStatus =
  | "returned"
  | "declined"
  | "waiting"
  | "expired"
  | "canceled"
  | "terminal_exited";

export interface TerminalControlResult {
  status: TerminalControlStatus;
  requestId: string;
  screen: string;
  note?: string;
}

interface PendingWaiter {
  resolve: (result: TerminalControlResult) => void;
  waitTimer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface ActiveControlRequest {
  descriptor: TerminalControlPrompt;
  terminal: TerminalSession;
  ttlTimer: ReturnType<typeof setTimeout>;
  unsubscribeExit: () => void;
  waiters: Set<PendingWaiter>;
}

export interface TerminalControlBrokerOptions {
  terminalManager: Pick<TerminalManager, "getTerminal" | "captureTerminal">;
  publish: (message: TerminalAttentionRequired) => void;
  isTerminalBusy?: (terminalId: string) => boolean;
  waitWindowMs?: number;
  ttlMs?: number;
  screenLines?: number;
  createId?: () => string;
  now?: () => number;
}

export const TERMINAL_CONTROL_WAIT_WINDOW_MS = 9 * 60_000;
export const TERMINAL_CONTROL_TTL_MS = 30 * 60_000;
export const TERMINAL_CONTROL_SCREEN_LINES = 60;
const MAX_PENDING_CONTROLS = 32;
const SETTLED_CACHE_TTL_MS = 5 * 60_000;

export class TerminalControlBroker {
  private readonly pending = new Map<string, ActiveControlRequest>();
  private readonly settled = new Map<
    string,
    {
      agentId: string;
      workspaceId: string;
      terminalId: string;
      result: TerminalControlResult;
      expiresAt: number;
    }
  >();
  private readonly terminalManager: TerminalControlBrokerOptions["terminalManager"];
  private readonly publish: TerminalControlBrokerOptions["publish"];
  private readonly isTerminalBusy?: (terminalId: string) => boolean;
  private readonly waitWindowMs: number;
  private readonly ttlMs: number;
  private readonly screenLines: number;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(options: TerminalControlBrokerOptions) {
    this.terminalManager = options.terminalManager;
    this.publish = options.publish;
    this.isTerminalBusy = options.isTerminalBusy;
    this.waitWindowMs = options.waitWindowMs ?? TERMINAL_CONTROL_WAIT_WINDOW_MS;
    this.ttlMs = options.ttlMs ?? TERMINAL_CONTROL_TTL_MS;
    this.screenLines = options.screenLines ?? TERMINAL_CONTROL_SCREEN_LINES;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  hasPendingForTerminal(terminalId: string): boolean {
    for (const item of this.pending.values()) {
      if (item.terminal.id === terminalId) return true;
    }
    return false;
  }

  list(): TerminalControlPrompt[] {
    return [...this.pending.values()].map((item) => item.descriptor);
  }

  async request(input: {
    agentId: string;
    workspaceId: string;
    terminalId: string;
    reason: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<TerminalControlResult> {
    this.pruneSettled();
    if (input.requestId) {
      return this.continueWait(input as Required<Pick<typeof input, "requestId">> & typeof input);
    }

    const terminal = this.terminalManager.getTerminal(input.terminalId);
    if (!terminal) throw new Error("The target terminal no longer exists");
    if (terminal.workspaceId !== input.workspaceId) {
      throw new Error(
        "Terminal control can only target a terminal in the calling agent's workspace",
      );
    }
    if (terminal.getExitInfo() !== null) {
      return { status: "terminal_exited", requestId: this.createId(), screen: "" };
    }
    if (input.signal?.aborted) {
      return { status: "canceled", requestId: this.createId(), screen: "" };
    }
    if (this.hasPendingForTerminal(terminal.id)) {
      throw new Error("Another terminal control request is already pending for this terminal");
    }
    if (this.isTerminalBusy?.(terminal.id)) {
      throw new Error("Another interactive prompt or shell command is active on this terminal");
    }
    if (this.pending.size >= MAX_PENDING_CONTROLS) {
      throw new Error("Too many terminal control requests are pending");
    }

    const id = this.createId();
    const descriptor: TerminalControlPrompt = {
      id,
      agentId: input.agentId,
      terminalId: terminal.id,
      terminalName: terminal.name,
      cwd: terminal.cwd,
      workspaceId: terminal.workspaceId,
      reason: input.reason.trim(),
      expiresAt: this.now() + this.ttlMs,
    };

    const ttlTimer = setTimeout(() => {
      this.finish(id, "expired", "");
    }, this.ttlMs);
    ttlTimer.unref?.();

    const unsubscribeExit = terminal.onExit(() => {
      this.finish(id, "terminal_exited", "");
    });

    const entry: ActiveControlRequest = {
      descriptor,
      terminal,
      ttlTimer,
      unsubscribeExit,
      waiters: new Set(),
    };
    this.pending.set(id, entry);
    this.publishChange(descriptor, "pending");

    return this.awaitWaitWindow(entry, input.signal);
  }

  private async continueWait(input: {
    agentId: string;
    workspaceId: string;
    terminalId: string;
    requestId: string;
    signal?: AbortSignal;
  }): Promise<TerminalControlResult> {
    const active = this.pending.get(input.requestId);
    if (active) {
      if (
        active.descriptor.agentId !== input.agentId ||
        active.descriptor.workspaceId !== input.workspaceId ||
        active.descriptor.terminalId !== input.terminalId
      ) {
        throw new Error("Terminal control request does not match this agent or terminal");
      }
      if (input.signal?.aborted) {
        this.finish(active.descriptor.id, "canceled", "");
        return { status: "canceled", requestId: active.descriptor.id, screen: "" };
      }
      if (
        this.terminalManager.getTerminal(active.terminal.id) !== active.terminal ||
        active.terminal.getExitInfo() !== null
      ) {
        this.finish(active.descriptor.id, "terminal_exited", "");
        return { status: "terminal_exited", requestId: active.descriptor.id, screen: "" };
      }
      return this.awaitWaitWindow(active, input.signal);
    }

    const cached = this.settled.get(input.requestId);
    if (cached) {
      if (
        cached.agentId !== input.agentId ||
        cached.workspaceId !== input.workspaceId ||
        cached.terminalId !== input.terminalId
      ) {
        throw new Error("Terminal control request does not match this agent or terminal");
      }
      this.settled.delete(input.requestId);
      return cached.result;
    }

    return { status: "expired", requestId: input.requestId, screen: "" };
  }

  private awaitWaitWindow(
    entry: ActiveControlRequest,
    signal?: AbortSignal,
  ): Promise<TerminalControlResult> {
    const remainingTtl = Math.max(0, entry.descriptor.expiresAt - this.now());
    if (remainingTtl === 0) {
      this.finish(entry.descriptor.id, "expired", "");
      return Promise.resolve({ status: "expired", requestId: entry.descriptor.id, screen: "" });
    }
    const windowMs = Math.min(this.waitWindowMs, remainingTtl);

    return new Promise<TerminalControlResult>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        waitTimer: setTimeout(() => {
          this.removeWaiter(entry, waiter);
          if (!this.pending.has(entry.descriptor.id)) {
            return;
          }
          if (entry.descriptor.expiresAt <= this.now()) {
            this.finish(entry.descriptor.id, "expired", "");
            return;
          }
          resolve({ status: "waiting", requestId: entry.descriptor.id, screen: "" });
        }, windowMs),
        abortSignal: signal,
      };
      waiter.waitTimer.unref?.();

      if (signal) {
        waiter.abortListener = () => {
          this.finish(entry.descriptor.id, "canceled", "");
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }

      entry.waiters.add(waiter);
      if (signal?.aborted) {
        this.finish(entry.descriptor.id, "canceled", "");
      }
    });
  }

  async respond(input: {
    controlId: string;
    action: "return" | "decline";
    shareScreen?: boolean;
    note?: string;
  }): Promise<{ success: boolean; error: string | null }> {
    const entry = this.pending.get(input.controlId);
    if (!entry) {
      return { success: false, error: "This terminal control request is no longer pending" };
    }
    const note = input.note?.trim() || undefined;
    if (input.action === "decline") {
      this.finish(input.controlId, "declined", "", note);
      return { success: true, error: null };
    }

    let screen = "";
    if (input.shareScreen !== false) {
      try {
        const capture = await this.terminalManager.captureTerminal(entry.terminal.id, {
          start: -this.screenLines,
          stripAnsi: true,
        });
        screen = trimScreenLines(capture.lines);
      } catch {
        screen = "";
      }
    }

    this.finish(input.controlId, "returned", screen, note);
    return { success: true, error: null };
  }

  dispose(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.finish(id, "canceled", "");
    }
    this.settled.clear();
  }

  private removeWaiter(entry: ActiveControlRequest, waiter: PendingWaiter): void {
    entry.waiters.delete(waiter);
    clearTimeout(waiter.waitTimer);
    if (waiter.abortListener) {
      waiter.abortSignal?.removeEventListener("abort", waiter.abortListener);
    }
  }

  private finish(
    id: string,
    status: Exclude<TerminalControlStatus, "waiting">,
    screen: string,
    note?: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.ttlTimer);
    entry.unsubscribeExit();

    const result: TerminalControlResult = {
      status,
      requestId: id,
      screen,
      ...(note ? { note } : {}),
    };

    const hadWaiters = entry.waiters.size > 0;
    for (const waiter of Array.from(entry.waiters)) {
      this.removeWaiter(entry, waiter);
      waiter.resolve(result);
    }

    if (!hadWaiters) {
      this.settled.set(id, {
        agentId: entry.descriptor.agentId,
        workspaceId: entry.descriptor.workspaceId,
        terminalId: entry.descriptor.terminalId,
        result,
        expiresAt: this.now() + SETTLED_CACHE_TTL_MS,
      });
    }

    this.publishChange(entry.descriptor, "resolved", status, note);
  }

  private pruneSettled(): void {
    const now = this.now();
    for (const [id, item] of this.settled) {
      if (item.expiresAt <= now) {
        this.settled.delete(id);
      }
    }
  }

  private publishChange(
    prompt: TerminalControlPrompt,
    state: "pending" | "resolved",
    resolution?: Exclude<TerminalControlStatus, "waiting">,
    note?: string,
  ): void {
    this.publish({
      type: "terminal_attention_required",
      payload: {
        terminalId: prompt.terminalId,
        cwd: prompt.cwd,
        workspaceId: prompt.workspaceId,
        reason: "needs_input",
        title: state === "pending" ? "Terminal control requested" : "Terminal control resolved",
        body: state === "pending" ? prompt.reason : "Terminal control resolved",
        shouldNotify: state === "pending",
        kind: "control",
        controlPrompt: {
          ...prompt,
          state,
          ...(resolution ? { resolution } : {}),
          ...(note ? { note } : {}),
        },
      },
    });
  }
}

function trimScreenLines(lines: readonly string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(0, end).join("\n");
}
