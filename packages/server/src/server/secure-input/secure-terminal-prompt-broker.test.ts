import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../../terminal/terminal.js";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { SecureTerminalPromptBroker } from "./secure-terminal-prompt-broker.js";

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  const send = vi.fn();
  const exitListeners = new Set<() => void>();
  const terminal = {
    id: "term-1",
    name: "SSH terminal",
    cwd: "/work/example",
    workspaceId: "ws-1",
    send,
    onExit: (listener: () => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  } as unknown as TerminalSession;
  let active: TerminalSession | undefined = terminal;
  const messages: unknown[] = [];
  const broker = new SecureTerminalPromptBroker({
    terminalManager: {
      getTerminal: (id: string) => (id === "term-1" ? active : undefined),
    } as Pick<TerminalManager, "getTerminal">,
    publish: (message) => messages.push(SessionOutboundMessageSchema.parse(message)),
    ttlMs: 1_000,
    createId: () => "prompt-1",
  });
  return {
    broker,
    send,
    messages,
    terminal,
    stopTerminal: () => {
      active = undefined;
      for (const listener of exitListeners) listener();
    },
    replaceTerminal: () => {
      active = { ...terminal } as TerminalSession;
    },
  };
}

const request = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  terminalId: "term-1",
  reason: "sudo requires a password",
};

describe("agent-initiated secure terminal input", () => {
  it("publishes a prompt, sends the secret only to the PTY and returns a nonsecret status", async () => {
    const { broker, send, messages } = fixture();
    const outcome = broker.request(request);
    expect(broker.list()).toEqual([
      {
        id: "prompt-1",
        agentId: "agent-1",
        workspaceId: "ws-1",
        terminalId: "term-1",
        terminalName: "SSH terminal",
        cwd: "/work/example",
        reason: request.reason,
        expiresAt: expect.any(Number),
      },
    ]);
    expect(messages).toHaveLength(1);
    const wire = SessionInboundMessageSchema.parse({
      type: "terminal.secure_prompt.respond.request",
      requestId: "reply-1",
      promptId: "prompt-1",
      action: "submit",
      secret: "secret-example-value",
      submitNewline: true,
    });
    if (wire.type !== "terminal.secure_prompt.respond.request") throw new Error("Invalid test input");
    expect(broker.respond(wire)).toEqual({ success: true, error: null });
    expect(await outcome).toBe("submitted");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "input",
      data: "secret-example-value\r",
    });
    expect(broker.list()).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("secret-example-value");
    expect(broker.respond(wire)).toEqual({
      success: false,
      error: "This secure input request is no longer pending",
    });
  });

  it("denies without writing anything to the terminal", async () => {
    const { broker, send } = fixture();
    const outcome = broker.request(request);
    expect(broker.respond({ promptId: "prompt-1", action: "deny" })).toEqual({
      success: true,
      error: null,
    });
    expect(await outcome).toBe("denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects prompts for terminals owned by another workspace", () => {
    const { broker, send } = fixture();
    expect(() => broker.request({ ...request, workspaceId: "other-workspace" })).toThrow(
      "calling agent's workspace",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects control characters and keeps the request pending for retry", async () => {
    const { broker, send } = fixture();
    const outcome = broker.request(request);
    expect(
      broker.respond({ promptId: "prompt-1", action: "submit", secret: "first\nsecond" }),
    ).toEqual({ success: false, error: "A secret cannot contain newline or NUL characters" });
    expect(send).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
    broker.respond({ promptId: "prompt-1", action: "deny" });
    expect(await outcome).toBe("denied");
  });

  it("does not write to a replaced terminal or after it exits", async () => {
    const { broker, replaceTerminal, stopTerminal, send } = fixture();
    const result = broker.request(request);
    replaceTerminal();
    expect(broker.respond({ promptId: "prompt-1", action: "submit", secret: "value" }).success).toBe(
      false,
    );
    expect(await result).toBe("canceled");
    expect(send).not.toHaveBeenCalled();

    const next = broker.request(request);
    stopTerminal();
    expect(await next).toBe("canceled");
  });

  it("expires requests and responds to tool cancellation", async () => {
    vi.useFakeTimers();
    const { broker, send } = fixture();
    const first = broker.request(request);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe("expired");

    const abort = new AbortController();
    const next = broker.request({ ...request, signal: abort.signal });
    abort.abort();
    expect(await next).toBe("canceled");
    expect(send).not.toHaveBeenCalled();
  });

  it("limits one unresolved request per target terminal", async () => {
    const { broker } = fixture();
    const first = broker.request(request);
    expect(() => broker.request(request)).toThrow("already pending");
    broker.dispose();
    expect(await first).toBe("canceled");
  });
});
