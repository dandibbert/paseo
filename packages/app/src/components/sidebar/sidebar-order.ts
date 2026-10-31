import type { WorkspaceSort } from "@/projects/workspace-structure";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

export type SidebarActivityFilter = "all" | "running" | "attention";

export function matchesSidebarActivity(
  workspace: SidebarWorkspaceEntry,
  filter: SidebarActivityFilter,
): boolean {
  if (filter === "running") return workspace.statusBucket === "running";
  if (filter === "attention")
    return (
      workspace.statusBucket === "needs_input" ||
      workspace.statusBucket === "failed" ||
      workspace.statusBucket === "attention"
    );
  return true;
}

export function sidebarWorkspaceTime(
  workspace: SidebarWorkspaceEntry | undefined,
  sort: WorkspaceSort,
): number {
  if (!workspace) return 0;
  if (sort === "activity")
    return workspace.activityAt?.getTime() ?? workspace.createdAt?.getTime() ?? 0;
  if (sort === "lastPrompt")
    return workspace.lastUserMessageAt?.getTime() ?? workspace.createdAt?.getTime() ?? 0;
  return workspace.createdAt?.getTime() ?? 0;
}

function projectTime(
  project: SidebarProjectEntry,
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  sort: WorkspaceSort,
): number {
  let time = 0;
  for (const workspace of project.workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    if (!entry?.pinnedAt) time = Math.max(time, sidebarWorkspaceTime(entry, sort));
  }
  return time;
}

export function orderSidebarProjects(
  projects: readonly SidebarProjectEntry[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  sort: WorkspaceSort,
): SidebarProjectEntry[] {
  if (sort === "manual") return [...projects];
  const ordered = projects.map((project) => ({
    ...project,
    workspaces: [...project.workspaces].sort(
      (a, b) =>
        sidebarWorkspaceTime(entries.get(b.workspaceKey), sort) -
          sidebarWorkspaceTime(entries.get(a.workspaceKey), sort) ||
        a.workspaceKey.localeCompare(b.workspaceKey),
    ),
  }));
  return ordered.sort(
    (a, b) =>
      projectTime(b, entries, sort) - projectTime(a, entries, sort) ||
      a.viewKey.localeCompare(b.viewKey),
  );
}

export interface SidebarHostProjectGroup {
  serverId: string;
  projects: SidebarProjectEntry[];
}

export function groupSidebarProjectsByHost(
  projects: readonly SidebarProjectEntry[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  sort: WorkspaceSort,
): SidebarHostProjectGroup[] {
  const byHost = new Map<string, SidebarProjectEntry[]>();
  for (const project of projects) {
    for (const host of project.hosts) {
      const group = byHost.get(host.serverId) ?? [];
      group.push({
        ...project,
        hosts: [host],
        workspaces: project.workspaces.filter((workspace) => workspace.serverId === host.serverId),
      });
      byHost.set(host.serverId, group);
    }
  }
  const groups = Array.from(byHost, ([serverId, items]) => ({
    serverId,
    projects: orderSidebarProjects(items, entries, sort),
  }));
  if (sort === "manual") return groups;
  const newest = (group: SidebarHostProjectGroup) =>
    Math.max(0, ...group.projects.map((project) => projectTime(project, entries, sort)));
  return groups.sort((a, b) => newest(b) - newest(a) || a.serverId.localeCompare(b.serverId));
}

export function projectLocationSummary(
  project: SidebarProjectEntry,
  projects: readonly SidebarProjectEntry[],
): string | null {
  if (project.hosts.length > 1) return project.hosts.map((host) => host.iconWorkingDir).join(" · ");
  const duplicate = projects.some(
    (other) => other.viewKey !== project.viewKey && other.projectName === project.projectName,
  );
  return duplicate ? (project.hosts[0]?.iconWorkingDir ?? project.iconWorkingDir) : null;
}
