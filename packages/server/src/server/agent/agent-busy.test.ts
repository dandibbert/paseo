import { describe, expect, it } from "vitest";
import { resolveAgentBusyReason, type AgentBusyInput } from "./agent-busy.js";

function reason(overrides: Partial<AgentBusyInput> = {}) {
  return resolveAgentBusyReason({
    lifecycle: "idle",
    pendingPermissionCount: 0,
    hasPendingTurn: false,
    backgroundWorkCount: 0,
    runningProviderSubagentCount: 0,
    ...overrides,
  });
}

describe("resolveAgentBusyReason", () => {
  it("is not busy once the turn and everything it started are done", () => {
    expect(reason()).toBeNull();
    expect(reason({ lifecycle: "error" })).toBeNull();
    expect(reason({ lifecycle: "closed" })).toBeNull();
  });

  it("stays busy after the turn ends while background work or a subagent goes on", () => {
    expect(reason({ backgroundWorkCount: 1 })).toBe("background_work");
    expect(reason({ runningProviderSubagentCount: 2 })).toBe("background_work");
  });

  it("counts a turn that is queued or being replaced before the lifecycle says running", () => {
    expect(reason({ hasPendingTurn: true })).toBe("running");
    expect(reason({ lifecycle: "running", backgroundWorkCount: 1 })).toBe("running");
  });

  it("puts a pending permission ahead of everything else", () => {
    expect(reason({ lifecycle: "running", pendingPermissionCount: 1 })).toBe(
      "waiting_for_permission",
    );
    expect(reason({ lifecycle: "initializing" })).toBe("initializing");
  });
});
