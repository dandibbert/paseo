import { describe, expect, it } from "vitest";
import { withAutoApprovedPaseoTools } from "./options.js";

describe("withAutoApprovedPaseoTools", () => {
  it("allows render_ui without a prompt when the Paseo MCP server is attached", () => {
    expect(withAutoApprovedPaseoTools(["Read"], ["paseo"])).toEqual([
      "Read",
      "mcp__paseo__render_ui",
    ]);
  });

  it("does not duplicate an entry the user already allowed", () => {
    expect(withAutoApprovedPaseoTools(["mcp__paseo__render_ui"], ["paseo"])).toEqual([
      "mcp__paseo__render_ui",
    ]);
  });

  it("leaves allowedTools alone without the Paseo MCP server", () => {
    expect(withAutoApprovedPaseoTools(undefined, ["other"])).toBeUndefined();
    expect(withAutoApprovedPaseoTools(["Read"], [])).toEqual(["Read"]);
  });
});
