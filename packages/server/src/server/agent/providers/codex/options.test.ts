import { describe, expect, it } from "vitest";
import { approveAutoApprovedPaseoTools } from "./options.js";

describe("approveAutoApprovedPaseoTools", () => {
  it("approves render_ui on the Paseo MCP server and keeps its connection config", () => {
    expect(
      approveAutoApprovedPaseoTools({
        paseo: { url: "http://127.0.0.1:6767/mcp/agents" },
        other: { command: "other-mcp" },
      }),
    ).toEqual({
      paseo: {
        url: "http://127.0.0.1:6767/mcp/agents",
        tools: { render_ui: { approval_mode: "approve" } },
      },
      other: { command: "other-mcp" },
    });
  });

  it("leaves configs without the Paseo MCP server unchanged", () => {
    const servers = { other: { command: "other-mcp" } };
    expect(approveAutoApprovedPaseoTools(servers)).toBe(servers);
  });
});
