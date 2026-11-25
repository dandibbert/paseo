import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

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
    await client.createAgent({ provider: "claude", cwd: path.join(root, "Paseo"), title: "P" });
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
