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
});
