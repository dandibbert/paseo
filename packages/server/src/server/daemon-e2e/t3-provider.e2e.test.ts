import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FakeT3, run, turnItem } from "../../../../../plugins/t3-provider/test/fake-t3.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("an agent on Antigravity via T3 runs its prompt through the T3 server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-t3-e2e-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const t3 = await new FakeT3().start();
  const daemon = await createTestPaseoDaemon({
    agentClients: {},
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["t3-provider"]),
    providerOverrides: {
      "antigravity-t3": {
        // Any resolvable executable: the pairing URL means `t3 pair` never runs.
        command: [process.execPath],
        env: { T3_PAIRING_URL: t3.pairingUrl, PASEO_HOME: path.join(root, "paseo-home") },
      },
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.17.1",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.refreshProvidersSnapshot({ cwd: root, providers: ["antigravity-t3"] });
    const snapshot = await client.getProvidersSnapshot({ cwd: root });
    const entry = snapshot.entries.find((candidate) => candidate.provider === "antigravity-t3");
    expect(entry?.status).toBe("ready");

    const agent = await client.createAgent({ provider: "antigravity-t3", cwd, title: "T3 E2E" });
    expect(agent.model).toBe("antigravity::gemini-4-pro");
    await client.sendMessage(agent.id, "Say hi");

    const deadline = Date.now() + 10_000;
    while (!t3.requests.some((request) => request.tag === "orchestration.subscribeThread")) {
      if (Date.now() > deadline) throw new Error("Paseo never subscribed to the T3 thread");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const launch = t3.requests.find((request) => request.tag === "orchestration.launchThread");
    if (!launch) throw new Error("Paseo never launched a T3 thread");
    const messageId = (launch.payload.initialMessage as { messageId: string }).messageId;
    t3.emit("run.updated", run({ userMessageId: messageId, status: "running" }));
    t3.emit(
      "turn-item.updated",
      turnItem({
        id: "a1",
        type: "assistant_message",
        messageId: "m2",
        text: "T3_E2E_OK",
        streaming: false,
        ordinal: 2,
      }),
    );
    t3.emit("provider-turn.updated", {
      id: "pt-1",
      runAttemptId: "attempt-1",
      status: "completed",
      tokenUsage: { usedTokens: 52_000, maxTokens: 1_000_000, updatedAt: "2026-11-22T00:00:01Z" },
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 40_000,
        cachedInputTokens: 30_000,
        outputTokens: 1_200,
      },
    });
    t3.emit(
      "run.updated",
      run({ userMessageId: messageId, status: "completed", activeAttemptId: "attempt-1" }),
    );

    const result = await client.waitForFinish(agent.id, 15_000);
    expect(result.status).toBe("idle");
    // Better Paseo and Paseo's own usage read this when the turn ends.
    expect(result.final?.lastUsage).toEqual({
      inputTokens: 10_000,
      cachedInputTokens: 30_000,
      outputTokens: 1_200,
      contextWindowUsedTokens: 52_000,
      contextWindowMaxTokens: 1_000_000,
    });
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(
      timeline.entries.some(
        (row) => row.item.type === "assistant_message" && row.item.text.includes("T3_E2E_OK"),
      ),
    ).toBe(true);
    expect(t3.tokenRequests[0]?.get("client_label")).toBe("Paseo");
  } finally {
    await client.close();
    await daemon.close();
    await t3.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
