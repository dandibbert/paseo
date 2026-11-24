import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { TerminalControlBroker } from "./terminal-control-broker.js";

afterEach(() => {
  vi.useRealTimers();
});

function fixture(options?: {
  waitWindowMs?: number;
  ttlMs?: number;
  isTerminalBusy?: (terminalId: string) => boolean;
  captureLines?: string[];
}) {
  let exitInfo: { code: number | null; signal?: number } | null = null;
  const exitListeners = new Set<() => void>();
  const terminal = {
    id: "term-1",
    name: "Deploy terminal",
    cwd: "/work/example",
    workspaceId: "ws-1",
    getExitInfo: () => exitInfo,
    onExit: (listener: () => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  } as unknown as TerminalSession;
  let active: TerminalSession | undefined = terminal;
  const messages: unknown[] = [];
  let seq = 0;
  let nowMs = 1_000_000;
  const captureTerminal = vi.fn(async () => ({
    lines: options?.captureLines ?? ["? Choose target:", "> production", "  staging", ""],
    totalLines: 4,
  }));
  const broker = new TerminalControlBroker({
    terminalManager: {
      getTerminal: (id: string) => (id === "term-1" ? active : undefined),
      captureTerminal,
    } as Pick<TerminalManager, "getTerminal" | "captureTerminal">,
    publish: (message) => messages.push(SessionOutboundMessageSchema.parse(message)),
    isTerminalBusy: options?.isTerminalBusy,
    waitWindowMs: options?.waitWindowMs ?? 500,
    ttlMs: options?.ttlMs ?? 2_000,
    createId: () => `ctrl-${++seq}`,
    now: () => nowMs,
  });

  return {
    broker,
    messages,
    captureTerminal,
    advanceNow: (ms: number) => {
      nowMs += ms;
    },
    stopTerminal: () => {
      exitInfo = { code: 0 };
      active = undefined;
      for (const listener of exitListeners) listener();
    },
  };
}

const baseRequest = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  terminalId: "term-1",
  reason: "Select deployment target in interactive prompt",
};

describe("TerminalControlBroker", () => {
  it("publishes pending control, returns screen and note on return, and clears lock", async () => {
    const { broker, messages, captureTerminal } = fixture();
    const pending = broker.request(baseRequest);

    expect(broker.hasPendingForTerminal("term-1")).toBe(true);
    expect(broker.list()).toEqual([
      expect.objectContaining({
        id: "ctrl-1",
        agentId: "agent-1",
        terminalId: "term-1",
        reason: baseRequest.reason,
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "terminal_attention_required",
      payload: {
        kind: "control",
        shouldNotify: true,
        controlPrompt: { id: "ctrl-1", state: "pending" },
      },
    });

    const response = await broker.respond({
      controlId: "ctrl-1",
      action: "return",
      note: "Picked production",
    });
    expect(response).toEqual({ success: true, error: null });
    expect(captureTerminal).toHaveBeenCalledWith("term-1", { start: -60, stripAnsi: true });

    await expect(pending).resolves.toEqual({
      status: "returned",
      requestId: "ctrl-1",
      screen: "? Choose target:\n> production\n  staging",
      note: "Picked production",
    });
    expect(broker.hasPendingForTerminal("term-1")).toBe(false);
    expect(messages[1]).toMatchObject({
      type: "terminal_attention_required",
      payload: {
        kind: "control",
        shouldNotify: false,
        controlPrompt: {
          id: "ctrl-1",
          state: "resolved",
          resolution: "returned",
          note: "Picked production",
        },
      },
    });
  });

  it("omits captured screen when shareScreen is false", async () => {
    const { broker, captureTerminal } = fixture();
    const pending = broker.request(baseRequest);

    await broker.respond({
      controlId: "ctrl-1",
      action: "return",
      shareScreen: false,
      note: "Done",
    });

    expect(captureTerminal).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({
      status: "returned",
      requestId: "ctrl-1",
      screen: "",
      note: "Done",
    });
  });

  it("supports decline action", async () => {
    const { broker } = fixture();
    const pending = broker.request(baseRequest);

    const response = await broker.respond({
      controlId: "ctrl-1",
      action: "decline",
      note: "Not now",
    });
    expect(response).toEqual({ success: true, error: null });
    await expect(pending).resolves.toEqual({
      status: "declined",
      requestId: "ctrl-1",
      screen: "",
      note: "Not now",
    });
  });

  it("returns waiting when wait window elapses and resumes with requestId", async () => {
    vi.useFakeTimers();
    const { broker, advanceNow } = fixture({ waitWindowMs: 500, ttlMs: 2_000 });

    const firstCall = broker.request(baseRequest);
    advanceNow(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(firstCall).resolves.toEqual({
      status: "waiting",
      requestId: "ctrl-1",
      screen: "",
    });
    expect(broker.hasPendingForTerminal("term-1")).toBe(true);

    const secondCall = broker.request({ ...baseRequest, requestId: "ctrl-1" });
    await broker.respond({ controlId: "ctrl-1", action: "return" });

    await expect(secondCall).resolves.toEqual({
      status: "returned",
      requestId: "ctrl-1",
      screen: "? Choose target:\n> production\n  staging",
    });
  });

  it("delivers resolved result if responded between waiting calls", async () => {
    vi.useFakeTimers();
    const { broker, advanceNow } = fixture({ waitWindowMs: 500, ttlMs: 2_000 });

    const firstCall = broker.request(baseRequest);
    advanceNow(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(firstCall).resolves.toMatchObject({ status: "waiting", requestId: "ctrl-1" });

    await broker.respond({ controlId: "ctrl-1", action: "return", note: "Finished while away" });

    await expect(broker.request({ ...baseRequest, requestId: "ctrl-1" })).resolves.toEqual({
      status: "returned",
      requestId: "ctrl-1",
      screen: "? Choose target:\n> production\n  staging",
      note: "Finished while away",
    });
  });

  it("expires after overall TTL", async () => {
    vi.useFakeTimers();
    const { broker, advanceNow } = fixture({ waitWindowMs: 1_500, ttlMs: 2_000 });

    const firstCall = broker.request(baseRequest);
    advanceNow(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(firstCall).resolves.toEqual({
      status: "waiting",
      requestId: "ctrl-1",
      screen: "",
    });

    const secondCall = broker.request({ ...baseRequest, requestId: "ctrl-1" });
    advanceNow(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(secondCall).resolves.toEqual({
      status: "expired",
      requestId: "ctrl-1",
      screen: "",
    });
    expect(broker.hasPendingForTerminal("term-1")).toBe(false);
  });

  it("cancels when agent signal aborts and settles as terminal_exited when terminal closes", async () => {
    const { broker } = fixture();
    const controller = new AbortController();
    const pendingAbort = broker.request({ ...baseRequest, signal: controller.signal });
    controller.abort();
    await expect(pendingAbort).resolves.toEqual({
      status: "canceled",
      requestId: "ctrl-1",
      screen: "",
    });
    expect(broker.hasPendingForTerminal("term-1")).toBe(false);

    const { broker: broker2, stopTerminal } = fixture();
    const pendingExit = broker2.request(baseRequest);
    stopTerminal();
    await expect(pendingExit).resolves.toEqual({
      status: "terminal_exited",
      requestId: "ctrl-1",
      screen: "",
    });
    expect(broker2.hasPendingForTerminal("term-1")).toBe(false);
  });

  it("rejects cross-workspace, duplicate requests, and busy terminals", async () => {
    const { broker } = fixture();
    await expect(broker.request({ ...baseRequest, workspaceId: "ws-other" })).rejects.toThrow(
      /workspace/i,
    );

    const pending = broker.request(baseRequest);
    await expect(broker.request(baseRequest)).rejects.toThrow(/already pending/i);
    await broker.respond({ controlId: "ctrl-1", action: "decline" });
    await pending;

    const busyFixture = fixture({ isTerminalBusy: () => true });
    await expect(busyFixture.broker.request(baseRequest)).rejects.toThrow(/active/i);
  });
});
