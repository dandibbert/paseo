import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { isGroupableToolCall } from "./grouping";

function makeToolItem(overrides: {
  id: string;
  name: string;
  detail: Record<string, unknown>;
  status?: "running" | "completed" | "failed" | "canceled";
  turnId?: string;
}): StreamItem {
  return {
    kind: "tool_call",
    id: overrides.id,
    turnId: overrides.turnId,
    timestamp: new Date("2026-11-23T00:00:00Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: overrides.id,
        name: overrides.name,
        status: overrides.status ?? "completed",
        error: null,
        detail: overrides.detail as never,
      },
    },
  };
}

describe("user shell and terminal control timeline grouping", () => {
  it("never groups user-origin shell cards or request_terminal_control into tool overview groups", () => {
    const userShell = makeToolItem({
      id: "user-shell-1",
      name: "shell",
      detail: { type: "shell", command: "ls", origin: "user", terminalId: "term-1" },
    });
    const agentShell = makeToolItem({
      id: "agent-shell-1",
      name: "shell",
      detail: { type: "shell", command: "ls" },
    });
    const controlCall = makeToolItem({
      id: "ctrl-1",
      name: "request_terminal_control",
      detail: { type: "unknown", input: { terminalId: "t1", reason: "Auth" }, output: null },
    });

    expect(isGroupableToolCall(userShell)).toBe(false);
    expect(isGroupableToolCall(controlCall)).toBe(false);
    expect(isGroupableToolCall(agentShell)).toBe(true);
  });

  it("keeps user shell and terminal control cards visible across turn collapse", () => {
    const prompt: StreamItem = {
      kind: "user_message",
      id: "u1",
      turnId: "t1",
      timestamp: new Date("2026-11-23T00:00:00Z"),
      text: "Check logs",
    };
    const readTool = makeToolItem({
      id: "read-1",
      name: "read",
      turnId: "t1",
      detail: { type: "read", filePath: "/tmp/a.log" },
    });
    const controlCall = makeToolItem({
      id: "ctrl-1",
      name: "request_terminal_control",
      turnId: "t1",
      detail: { type: "unknown", input: { terminalId: "t1", reason: "Auth" }, output: null },
    });
    const userShell = makeToolItem({
      id: "user-shell-1",
      name: "shell",
      turnId: "t1",
      detail: { type: "shell", command: "git status", origin: "user", terminalId: "term-s" },
    });
    const reply: StreamItem = {
      kind: "assistant_message",
      id: "a1",
      turnId: "t1",
      timestamp: new Date("2026-11-23T00:00:05Z"),
      text: "All done.",
    };

    const result = collapseTurns({
      tail: [prompt, readTool, controlCall, userShell, reply],
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
    });

    expect(result.hostIdByHiddenRowId.has("read-1")).toBe(true);
    expect(result.hostIdByHiddenRowId.has("ctrl-1")).toBe(false);
    expect(result.hostIdByHiddenRowId.has("user-shell-1")).toBe(false);
    expect(result.tail.map((item) => item.id)).toContain("ctrl-1");
    expect(result.tail.map((item) => item.id)).toContain("user-shell-1");
  });
});
