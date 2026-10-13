import { describe, expect, it, vi } from "vitest";
import type pino from "pino";
import { SessionDelivery } from "../server/session/owned-subscriptions/index.js";
import { TerminalSessionController } from "./terminal-session-controller.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

describe("secure terminal input", () => {
  function setup(terminalExists = true) {
    const send = vi.fn();
    const terminal = { send } as unknown as TerminalSession;
    const terminalManager = {
      getTerminal: (id: string) => (id === "terminal-1" && terminalExists ? terminal : undefined),
    } as unknown as TerminalManager;
    const output: SessionOutboundMessage[] = [];
    const controller = new TerminalSessionController({
      terminalManager,
      emit: (message) => output.push(message),
      hasBinaryChannel: () => false,
      isPathWithinRoot: () => false,
      sessionLogger: { warn: vi.fn() } as unknown as pino.Logger,
    });
    const delivery = new SessionDelivery(() => {});
    return { send, output, controller, delivery };
  }

  it("sends a secret only to the requested PTY, and never echoes it in the acknowledgment", async () => {
    const { send, output, controller, delivery } = setup();
    const secret = "example-sensitive-value";
    await controller.dispatch(
      {
        type: "terminal.secure_input.request",
        terminalId: "terminal-1",
        requestId: "request-1",
        secret,
        submit: true,
      },
      delivery,
    );

    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "input", data: secret + "\r" });
    expect(output).toEqual([
      {
        type: "terminal.secure_input.response",
        payload: {
          requestId: "request-1",
          terminalId: "terminal-1",
          success: true,
          error: null,
        },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("supports supplying text without automatically pressing Enter", async () => {
    const { send, controller, delivery } = setup();
    await controller.dispatch(
      {
        type: "terminal.secure_input.request",
        terminalId: "terminal-1",
        requestId: "request-2",
        secret: "value",
        submit: false,
      },
      delivery,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "input", data: "value" });
  });

  it.each(["one\ntwo", "one\rtwo", "one\0two"])(
    "rejects control characters without sending to the terminal",
    async (secret) => {
      const { send, output, controller, delivery } = setup();
      await controller.dispatch(
        {
          type: "terminal.secure_input.request",
          terminalId: "terminal-1",
          requestId: "request-3",
          secret,
          submit: true,
        },
        delivery,
      );
      expect(send).not.toHaveBeenCalled();
      expect(output[0]?.type).toBe("terminal.secure_input.response");
      if (output[0]?.type === "terminal.secure_input.response") {
        expect(output[0].payload.success).toBe(false);
        expect(JSON.stringify(output[0])).not.toContain(secret);
      }
    },
  );

  it("does not write to a missing terminal", async () => {
    const { send, output, controller, delivery } = setup(false);
    await controller.dispatch(
      {
        type: "terminal.secure_input.request",
        terminalId: "terminal-1",
        requestId: "request-4",
        secret: "no-session",
        submit: true,
      },
      delivery,
    );
    expect(send).not.toHaveBeenCalled();
    expect(output).toEqual([
      {
        type: "terminal.secure_input.response",
        payload: {
          requestId: "request-4",
          terminalId: "terminal-1",
          success: false,
          error: "Terminal not found",
        },
      },
    ]);
  });
});
