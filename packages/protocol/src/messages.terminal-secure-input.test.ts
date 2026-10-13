import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("terminal secure input wire contract", () => {
  const request = {
    type: "terminal.secure_input.request",
    requestId: "request-1",
    terminalId: "terminal-1",
    secret: "example-sensitive-value",
    submit: true,
  } as const;

  it("accepts a one-time secret in a dedicated terminal request", () => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });

  it("rejects empty and oversized secrets", () => {
    expect(SessionInboundMessageSchema.safeParse({ ...request, secret: "" }).success).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({ ...request, secret: "x".repeat(8193) }).success,
    ).toBe(false);
  });

  it("accepts an acknowledgment that contains no secret", () => {
    const response = {
      type: "terminal.secure_input.response",
      payload: {
        requestId: request.requestId,
        terminalId: request.terminalId,
        success: true,
        error: null,
      },
    } as const;
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(JSON.stringify(response)).not.toContain(request.secret);
  });

  it("serializes the Agent secure input request flow without revealing credentials in responses", () => {
    const prompt = {
      id: "prompt-1",
      agentId: "agent-1",
      terminalId: "term-1",
      terminalName: "Terminal",
      workspaceId: "ws-1",
      cwd: "/work",
      reason: "sudo requires a password",
      expiresAt: 10000,
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "terminal_attention_required",
        payload: {
          terminalId: "term-1",
          cwd: "/work",
          workspaceId: "ws-1",
          reason: "needs_input",
          title: "Secure input",
          body: "sudo requires a password",
          shouldNotify: true,
          securePrompt: { ...prompt, state: "pending" },
        },
      }),
    ).toHaveProperty("payload.securePrompt.id", "prompt-1");
    expect(
      SessionInboundMessageSchema.parse({
        type: "terminal.secure_prompt.list.request",
        requestId: "list-1",
      }),
    ).toBeTruthy();
    expect(
      SessionOutboundMessageSchema.parse({
        type: "terminal.secure_prompt.list.response",
        payload: { requestId: "list-1", prompts: [prompt] },
      }),
    ).toBeTruthy();
    const reply = SessionOutboundMessageSchema.parse({
      type: "terminal.secure_prompt.respond.response",
      payload: { requestId: "reply-1", success: true, error: null },
    });
    expect(JSON.stringify(reply)).not.toContain("password-value");
  });
});
