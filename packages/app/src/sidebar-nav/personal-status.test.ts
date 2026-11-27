import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import { derivePersonalSpaceStatus } from "./personal-status";

function workspace(
  id: string,
  projectId: string,
  fields: Partial<WorkspaceDescriptor> = {},
): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId,
    projectDisplayName: "Paseo",
    projectCustomName: null,
    projectRootPath: "/home/me/Paseo",
    workspaceDirectory: "/home/me/Paseo",
    projectKind: "non_git",
    workspaceKind: "directory",
    name: "Paseo",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...fields,
  };
}

function session(
  workspaces: WorkspaceDescriptor[],
  activity: Array<[string, WorkspaceAgentActivity]> = [],
) {
  return {
    workspaces: new Map(workspaces.map((entry) => [entry.id, entry])),
    workspaceAgentActivity: new Map(activity),
  };
}

describe("derivePersonalSpaceStatus", () => {
  it("is running while the personal space has a running agent", () => {
    expect(
      derivePersonalSpaceStatus({
        serverId: "host",
        session: session(
          [workspace("ws-personal", "prj-p", { personal: true })],
          [["ws-personal", { agentId: "a1", status: "running", enteredAt: null }]],
        ),
      }),
    ).toBe("running");
  });

  it("counts a sibling workspace in the personal project, which the project list hides", () => {
    expect(
      derivePersonalSpaceStatus({
        serverId: "host",
        session: session([
          workspace("ws-personal", "prj-p", { personal: true }),
          workspace("ws-sibling", "prj-p", { status: "needs_input" }),
          workspace("ws-other", "prj-other", { status: "running" }),
        ]),
      }),
    ).toBe("needs_input");
  });

  it("is idle without a personal space or any activity", () => {
    expect(derivePersonalSpaceStatus({ serverId: "host", session: undefined })).toBe("done");
    expect(
      derivePersonalSpaceStatus({
        serverId: "host",
        session: session([workspace("ws-other", "prj-other", { status: "running" })]),
      }),
    ).toBe("done");
  });
});
