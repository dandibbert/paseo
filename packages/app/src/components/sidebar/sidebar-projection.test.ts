import {
  orderSidebarProjects,
  groupSidebarProjectsByHost,
  matchesSidebarActivity,
  projectLocationSummary,
} from "./sidebar-order";
import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

function timed(id: string, project: string, serverId: string, age: number) {
  const row = makeWorkspace(id, "done", [], project);
  const workspaceKey = `${serverId}:${id}`;
  row.placement = { ...row.placement, serverId, workspaceKey };
  row.entry = {
    ...row.entry,
    serverId,
    workspaceKey,
    activityAt: new Date(age),
    createdAt: new Date(1),
  };
  return row;
}
it("moves a whole project by its most recent visible workspace and orders its children", () => {
  const old = timed("old", "a", "srv", 10);
  const fresh = timed("fresh", "a", "srv", 100);
  const middle = timed("middle", "b", "srv", 50);
  const projects = [
    makeProject([middle.placement], "b"),
    makeProject([old.placement, fresh.placement], "a"),
  ];
  const entries = new Map([old, fresh, middle].map((row) => [row.entry.workspaceKey, row.entry]));
  const ordered = orderSidebarProjects(projects, entries, "activity");
  expect(ordered.map((project) => project.viewKey)).toEqual(["a", "b"]);
  expect(ordered[0].workspaces.map((row) => row.workspaceId)).toEqual(["fresh", "old"]);
  const filtered = projects.map((project) => ({
    ...project,
    workspaces: project.workspaces.filter((row) => row.workspaceId !== "fresh"),
  }));
  expect(
    orderSidebarProjects(filtered, entries, "activity").map((project) => project.viewKey),
  ).toEqual(["b", "a"]);
  expect(orderSidebarProjects(projects, entries, "manual")).toEqual(projects);
  expect(projects[1].workspaces.map((row) => row.workspaceId)).toEqual(["old", "fresh"]);
});
it("does not let a pinned row promote its ordinary project", () => {
  const pinned = timed("pinned", "a", "srv", 100);
  pinned.entry.pinnedAt = new Date(10).toISOString();
  const ordinary = timed("ordinary", "b", "srv", 50);
  const projects = [makeProject([pinned.placement], "a"), makeProject([ordinary.placement], "b")];
  const entries = new Map([pinned, ordinary].map((row) => [row.entry.workspaceKey, row.entry]));
  expect(
    orderSidebarProjects(projects, entries, "activity").map((project) => project.viewKey),
  ).toEqual(["b", "a"]);
});
it("splits a shared project by host without changing identity or duplicating shortcuts", () => {
  const older = timed("old", "shared", "host-a", 10);
  const recent = timed("new", "shared", "host-b", 100);
  const shared = makeProject([older.placement, recent.placement], "shared");
  shared.hosts = [
    { ...shared.hosts[0], serverId: "host-a" },
    { ...shared.hosts[0], serverId: "host-b" },
  ];
  const entries = new Map([older, recent].map((row) => [row.entry.workspaceKey, row.entry]));
  const groups = groupSidebarProjectsByHost([shared], entries, "activity");
  expect(groups.map((group) => group.serverId)).toEqual(["host-b", "host-a"]);
  expect(groups.flatMap((group) => group.projects.map((project) => project.viewKey))).toEqual([
    "shared",
    "shared",
  ]);
  const projection = buildSidebarProjection({
    ...projectionInput(),
    projects: [shared],
    workspaceEntriesByKey: entries,
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    groupMode: "host",
    workspaceSort: "activity",
  });
  expect(projection.shortcutModel.shortcutTargets).toEqual([
    { serverId: "host-b", workspaceId: "new" },
    { serverId: "host-a", workspaceId: "old" },
  ]);
  expect(
    buildSidebarProjection({
      ...projectionInput(),
      projects: [shared],
      workspaceEntriesByKey: entries,
      groupMode: "host",
      collapsedProjectKeys: new Set(["shared"]),
    }).shortcutModel.shortcutTargets,
  ).toEqual([]);
});
it("filters status without replacing project identity and distinguishes matching names", () => {
  expect(matchesSidebarActivity(makeWorkspace("r", "running").entry, "running")).toBe(true);
  expect(matchesSidebarActivity(makeWorkspace("f", "failed").entry, "attention")).toBe(true);
  expect(matchesSidebarActivity(makeWorkspace("d", "done").entry, "running")).toBe(false);
  const a = makeProject([], "a");
  const b = makeProject([], "b");
  expect(projectLocationSummary(a, [a])).toBeNull();
  expect(projectLocationSummary(a, [a, b])).toBe("/repo/a");
});
