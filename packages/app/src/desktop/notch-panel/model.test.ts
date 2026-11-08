import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import {
  buildNotchPanelState,
  permissionResponse,
  type NotchPanelAgent,
  type NotchPanelLabels,
  type NotchPanelText,
} from "./model";

const labels: NotchPanelLabels = {
  needsYou: "Needs you",
  running: "Running",
  finished: "Finished",
  recent: "Recent",
  columnEmpty: "—",
  empty: "Nothing running",
  offline: "Offline",
  open: "Open",
  states: {
    permission: "Approval",
    question: "Question",
    error: "Error",
    running: "Running",
    finished: "Finished",
    recent: "Recent",
  },
};
const text: NotchPanelText = {
  untitled: "Untitled",
  allow: "Allow",
  deny: "Deny",
  answer: "Answer",
  translateAction: (label) => (label === "Reject" ? "拒绝" : label),
};

function agent(id: string, overrides: Partial<NotchPanelAgent> = {}): NotchPanelAgent {
  return {
    id,
    status: "idle",
    title: id,
    cwd: "/Users/me/repo/",
    pendingPermissions: [],
    lastActivityAt: new Date(1000),
    updatedAt: new Date(1000),
    ...overrides,
  };
}

const bash: AgentPermissionRequest = {
  id: "req-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  input: { command: "rm -rf build\necho done" },
};

describe("buildNotchPanelState", () => {
  it("puts approvals, questions and errors from every host ahead of running work", () => {
    const state = buildNotchPanelState({
      enabled: true,
      labels,
      text,
      hosts: [
        {
          serverId: "mac",
          label: "Mac",
          online: true,
          agents: [
            agent("a", { status: "running", pendingPermissions: [bash] }),
            agent("b", { status: "running", lastActivityAt: new Date(5000) }),
            agent("c", { requiresAttention: true, attentionReason: "finished" }),
            agent("d", { archivedAt: new Date(), status: "running" }),
          ],
        },
        {
          serverId: "linux",
          label: "Linux",
          online: false,
          agents: [agent("e", { status: "error", lastError: "provider exited" })],
        },
      ],
    });
    expect(state.needsYou.map((item) => [item.agentId, item.state, item.detail])).toEqual([
      ["a", "permission", "rm -rf build"],
      ["e", "error", "provider exited"],
    ]);
    expect(state.needsYou[0]?.subtitle).toBe("Mac · repo");
    expect(state.needsYou[0]?.buttons.map((button) => button.key)).toEqual(["allow", "deny"]);
    expect(state.running.map((item) => item.agentId)).toEqual(["b"]);
    expect(state.finished.map((item) => item.agentId)).toEqual(["c"]);
    expect(state.offlineHosts).toEqual(["Linux"]);
  });

  it("sends questions to the chat instead of answering them in the panel", () => {
    const question: AgentPermissionRequest = { ...bash, kind: "question" };
    const state = buildNotchPanelState({
      enabled: true,
      labels,
      text,
      hosts: [
        {
          serverId: "mac",
          label: "Mac",
          online: true,
          agents: [agent("q", { pendingPermissions: [question] })],
        },
      ],
    });
    expect(state.needsYou[0]?.state).toBe("question");
    expect(state.needsYou[0]?.buttons).toEqual([
      { key: "open", label: "Answer", tone: "primary", kind: "open" },
    ]);
    expect(permissionResponse(question, "open")).toBeNull();
  });
});

describe("permissionResponse", () => {
  it("answers with the provider's own action when the request offers actions", () => {
    const plan: AgentPermissionRequest = {
      ...bash,
      kind: "plan",
      actions: [
        { id: "implement", label: "Implement", behavior: "allow" },
        { id: "reject", label: "Reject", behavior: "deny" },
      ],
    };
    expect(permissionResponse(plan, "implement")).toEqual({
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(permissionResponse(plan, "reject")).toEqual({
      behavior: "deny",
      selectedActionId: "reject",
      message: "Denied by user",
    });
    expect(permissionResponse(plan, "allow")).toBeNull();
  });
});

describe("the idle board", () => {
  it("lists idle chats from the last day and counts each host's work", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const state = buildNotchPanelState({
      enabled: true,
      labels,
      text,
      now,
      hosts: [
        {
          serverId: "mac",
          label: "Mac",
          online: true,
          agents: [
            agent("fresh", { updatedAt: new Date(now - 60_000) }),
            agent("stale", { updatedAt: new Date(now - 3 * 24 * 60 * 60 * 1000) }),
            agent("busy", { status: "running" }),
          ],
        },
      ],
    });
    expect(state.recent.map((item) => item.agentId)).toEqual(["fresh"]);
    expect(state.hosts).toEqual([
      { serverId: "mac", label: "Mac", online: true, running: 1, needsYou: 0 },
    ]);
  });
});
