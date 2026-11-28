import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createDaemonTestContext } from "../test-utils/index.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";

let root: string;
let previousDir: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-personal-e2e-"));
  previousDir = process.env.PASEO_PERSONAL_SPACE_DIR;
  process.env.PASEO_PERSONAL_SPACE_DIR = path.join(root, "Paseo");
});

afterEach(async () => {
  if (previousDir === undefined) delete process.env.PASEO_PERSONAL_SPACE_DIR;
  else process.env.PASEO_PERSONAL_SPACE_DIR = previousDir;
  await rm(root, { recursive: true, force: true });
});

test("the personal space is created once, cannot be archived, and briefs its agents", async () => {
  const configs: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        configs.push(config);
      },
    }),
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.17.4",
  });
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.personalSpace).toBe(true);

    const first = await client.ensurePersonalSpace();
    expect(first.error).toBeNull();
    expect(first.workspace?.personal).toBe(true);
    expect(first.workspace?.workspaceDirectory).toBe(path.join(root, "Paseo"));
    expect((await stat(path.join(root, "Paseo"))).isDirectory()).toBe(true);
    const second = await client.ensurePersonalSpace();
    expect(second.workspace?.id).toBe(first.workspace?.id);

    const workspaceId = String(first.workspace?.id);
    const archived = await client.archiveWorkspace(workspaceId);
    expect(archived.error).toContain("personal space");
    await expect(client.removeProject(String(first.workspace?.projectId))).rejects.toThrow(
      "personal space",
    );
    expect((await client.ensurePersonalSpace()).workspace?.id).toBe(workspaceId);

    // Agents in the personal space are told they are a general assistant; others are not.
    const personalAgent = await client.createAgent({
      provider: "claude",
      cwd: path.join(root, "Paseo"),
      title: "P",
    });
    // Started in the personal folder without naming a workspace, it still joins the personal
    // space, so its status shows there.
    expect(personalAgent.workspaceId).toBe(workspaceId);
    const projectDir = path.join(root, "project");
    await import("node:fs/promises").then((fs) => fs.mkdir(projectDir));
    await client.createAgent({ provider: "claude", cwd: projectDir, title: "Q" });
    expect(configs).toHaveLength(2);
    expect(configs[0]?.daemonAppendSystemPrompt).toContain("personal space");
    expect(configs[1]?.daemonAppendSystemPrompt ?? "").not.toContain("personal space");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}, 60_000);

test("a running agent in the personal space shows the personal space as running", async () => {
  const ctx = await createDaemonTestContext({
    agentClients: { mock: new MockLoadTestAgentClient() },
    mcpEnabled: false,
    isDev: true,
  });
  try {
    const pushed = new Map<string, string>();
    ctx.client.subscribe((event) => {
      if (event.type === "workspace_update" && event.payload.kind === "upsert") {
        pushed.set(event.payload.workspace.id, event.payload.workspace.status);
      }
    });
    await ctx.client.fetchAgents({ subscribe: {} });
    await ctx.client.fetchWorkspaces({ subscribe: {} });
    const personal = await ctx.client.ensurePersonalSpace();
    const workspaceId = String(personal.workspace?.id);
    const other = await ctx.client.createWorkspace({
      source: { kind: "directory", path: ctx.daemon.staticDir },
    });
    const otherId = String(other.workspace?.id);
    for (const [id, cwd] of [
      [workspaceId, path.join(root, "Paseo")],
      [otherId, ctx.daemon.staticDir],
    ] as const) {
      await ctx.client.createAgent({
        workspaceId: id,
        provider: "mock",
        cwd,
        initialPrompt: "Work on this task",
      });
    }
    const statusOf = async (id: string) =>
      (await ctx.client.fetchWorkspaces()).entries.find((entry) => entry.id === id)?.status;
    await expect.poll(() => statusOf(otherId)).toBe("running");
    expect(await statusOf(workspaceId)).toBe("running");
    // The app keeps status from pushed updates, not from fetches.
    await expect.poll(() => pushed.get(otherId)).toBe("running");
    await expect.poll(() => pushed.get(workspaceId)).toBe("running");
  } finally {
    await ctx.cleanup();
  }
}, 60_000);
