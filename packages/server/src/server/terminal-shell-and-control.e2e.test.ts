import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { expect, test } from "vitest";

interface RecordedControlAttention {
  terminalId: string;
  reason: string;
  kind?: "output" | "control";
  controlPrompt?: {
    id: string;
    agentId: string;
    terminalId: string;
    reason: string;
    state: string;
  };
}

interface RecordedShellTimelineEvent {
  agentId: string;
  callId: string;
  status: string;
  exitCode?: number | null;
  output?: string;
  terminalId?: string;
  origin?: string;
}

function extractShellEvent(msg: unknown): RecordedShellTimelineEvent | null {
  if (!msg || typeof msg !== "object") return null;
  const record = msg as Record<string, unknown>;
  if (record.type !== "agent_stream") return null;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "timeline") return null;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "tool_call") return null;
  const detail = item.detail as Record<string, unknown> | undefined;
  if (!detail || detail.type !== "shell" || detail.origin !== "user") return null;
  return {
    agentId: String(payload.agentId ?? ""),
    callId: String(item.callId ?? ""),
    status: String(item.status ?? ""),
    exitCode: detail.exitCode as number | null | undefined,
    output: typeof detail.output === "string" ? detail.output : undefined,
    terminalId: typeof detail.terminalId === "string" ? detail.terminalId : undefined,
    origin: typeof detail.origin === "string" ? detail.origin : undefined,
  };
}

async function waitForShellStatus(
  events: readonly RecordedShellTimelineEvent[],
  callId: string,
  status: string,
): Promise<RecordedShellTimelineEvent> {
  let matched: RecordedShellTimelineEvent | null = null;
  await expect
    .poll(
      () => {
        matched = events.find((e) => e.callId === callId && e.status === status) ?? null;
        return matched;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  return matched!;
}

async function verifyShellIsolation(
  client: DaemonClient,
  mcp: Client,
  repoCwd: string,
  shellTerminalId: string,
): Promise<void> {
  const visibleTerminals = await client.listTerminals(repoCwd);
  const userShellTerminal = visibleTerminals.terminals.find((t) => t.id === shellTerminalId);
  expect(userShellTerminal?.name).toBe("Warp Shell E2E · shell");

  const mcpList = await mcp.callTool({ name: "list_terminals", arguments: { cwd: repoCwd } });
  expect(JSON.stringify(mcpList)).not.toContain(shellTerminalId);

  const mcpCapture = await mcp.callTool({
    name: "capture_terminal",
    arguments: { terminalId: shellTerminalId },
  });
  expect(mcpCapture.isError).toBe(true);
}

function readInjectedShellText(prompt: AgentPromptInput): string {
  expect(Array.isArray(prompt)).toBe(true);
  if (!Array.isArray(prompt)) return "";
  const block = prompt.find(
    (entry) => entry.type === "text" && entry.contextKind === "user_shell_commands",
  );
  expect(block).toBeDefined();
  return block && block.type === "text" ? block.text : "";
}

test("E2E: ! shell command mode lifecycle, isolation, context attachment, and restart persistence", async () => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-shell-e2e-"));
  const paseoHomeRoot = path.join(workRoot, "paseo-home-root");
  const repoCwd = path.join(workRoot, "repo");
  const subCwd = path.join(repoCwd, "sub");
  await mkdir(paseoHomeRoot, { recursive: true });
  await mkdir(subCwd, { recursive: true });

  const capturedPrompts: AgentPromptInput[] = [];
  const agentClients = createTestAgentClients({
    onStartTurn: (prompt) => {
      capturedPrompts.push(prompt);
    },
  });

  const daemon1 = await createTestPaseoDaemon({
    paseoHomeRoot,
    mcpEnabled: true,
    cleanup: false,
    agentClients,
  });
  const client1 = new DaemonClient({
    url: `ws://127.0.0.1:${daemon1.port}/ws`,
    appVersion: "0.17.4",
  });
  const mcp1 = new Client({ name: "e2e-shell-mcp", version: "1.0.0" });

  let daemon2: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null = null;
  let client2: DaemonClient | null = null;

  try {
    await client1.connect();
    const serverInfo = client1.getLastServerInfoMessage();
    expect(serverInfo?.features?.agentShellCommands).toBe(true);
    expect(serverInfo?.features?.terminalControl).toBe(true);
    await client1.fetchAgents({ subscribe: {} });

    const events: RecordedShellTimelineEvent[] = [];
    const agent = await client1.createAgent({
      provider: "claude",
      cwd: repoCwd,
      title: "Warp Shell E2E",
    });

    const timelineSub = client1.observeTimeline([agent.id]);
    const unsubscribe = timelineSub.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        const parsed = extractShellEvent(message);
        if (parsed) events.push(parsed);
      },
    });
    await timelineSub.ready;

    await mcp1.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon1.port}/mcp/agents?callerAgentId=${agent.id}`),
      ),
    );

    // 1. Run first shell command (simulate OSC 633;D;0 exit marker in bash)
    const firstRun = await client1.runAgentShellCommand({
      agentId: agent.id,
      command: "printf 'PASEO_FIRST_RUN\\n'; printf '\\033]633;D;0\\007'",
    });
    expect(firstRun.accepted).toBe(true);
    const shellTerminalId = String(firstRun.terminalId);
    const completedFirst = await waitForShellStatus(events, String(firstRun.callId), "completed");
    expect(completedFirst).toMatchObject({
      exitCode: 0,
      origin: "user",
      terminalId: shellTerminalId,
    });
    expect(completedFirst.output).toContain("PASEO_FIRST_RUN");

    // 2. Verify dedicated shell terminal is visible to the user but isolated from agent MCP terminal tools
    await verifyShellIsolation(client1, mcp1, repoCwd, shellTerminalId);

    // 3. Verify cd + export persist across shell commands + nonzero exit code captured
    const cdRun = await client1.runAgentShellCommand({
      agentId: agent.id,
      command: "cd sub && export PASEO_KEEP=yes123 && printf '\\033]633;D;0\\007'",
    });
    expect(cdRun.accepted).toBe(true);
    await waitForShellStatus(events, String(cdRun.callId), "completed");

    const envRun = await client1.runAgentShellCommand({
      agentId: agent.id,
      command: "pwd && echo VAR=$PASEO_KEEP && printf '\\033]633;D;7\\007'",
    });
    expect(envRun.accepted).toBe(true);
    const failedEnv = await waitForShellStatus(events, String(envRun.callId), "failed");
    expect(failedEnv.exitCode).toBe(7);
    expect(failedEnv.output).toContain(subCwd);
    expect(failedEnv.output).toContain("VAR=yes123");

    // 4. Verify non-OSC manual completion fallback ("Mark complete")
    const manualRun = await client1.runAgentShellCommand({
      agentId: agent.id,
      command: "echo MANUAL_FINISH_TEST",
    });
    expect(manualRun.accepted).toBe(true);
    await waitForShellStatus(events, String(manualRun.callId), "running");
    await new Promise((r) => setTimeout(r, 200));
    const finishRes = await client1.finishAgentShellCommand({
      agentId: agent.id,
      callId: String(manualRun.callId),
    });
    expect(finishRes.success).toBe(true);
    await waitForShellStatus(events, String(manualRun.callId), "completed");

    // 5. Verify pendingShellContext entries, partial deletion, and prompt attachment injection
    const pendingBefore = (await client1.fetchAgent(agent.id))?.agent.pendingShellContext ?? [];
    expect(pendingBefore).toHaveLength(4);
    // Snapshots carry summaries; the output stays on the daemon until it is attached.
    expect(pendingBefore.every((entry) => !("output" in entry))).toBe(true);

    const removeFirst = await client1.updateAgentShellContext({
      agentId: agent.id,
      remove: [pendingBefore[0].id],
    });
    expect(removeFirst.error).toBeNull();
    expect(removeFirst.pendingShellContext).toHaveLength(3);

    await client1.sendMessage(agent.id, "Use my terminal context");
    await expect.poll(() => capturedPrompts.length, { timeout: 10_000 }).toBe(1);

    const shellText = readInjectedShellText(capturedPrompts[0]);
    expect(shellText).toContain("VAR=yes123");
    expect(shellText).toContain("MANUAL_FINISH_TEST");
    expect(shellText).not.toContain("PASEO_FIRST_RUN");

    await expect
      .poll(async () => (await client1.fetchAgent(agent.id))?.agent.pendingShellContext ?? [], {
        timeout: 5_000,
      })
      .toHaveLength(0);

    // 6. Run another command and restart daemon to verify disk persistence
    const persistedRun = await client1.runAgentShellCommand({
      agentId: agent.id,
      command: "echo SURVIVED_RESTART && printf '\\033]633;D;0\\007'",
    });
    expect(persistedRun.accepted).toBe(true);
    await waitForShellStatus(events, String(persistedRun.callId), "completed");

    await timelineSub.release();
    unsubscribe();
    await mcp1.close();
    await client1.close();
    await daemon1.close();

    daemon2 = await createTestPaseoDaemon({
      paseoHomeRoot,
      mcpEnabled: true,
      cleanup: false,
      agentClients: createTestAgentClients(),
    });
    client2 = new DaemonClient({
      url: `ws://127.0.0.1:${daemon2.port}/ws`,
      appVersion: "0.17.4",
    });
    await client2.connect();
    await client2.fetchAgents({ subscribe: {} });

    const restoredAgent = await client2.fetchAgent(agent.id);
    expect(restoredAgent?.agent.shellTerminalId).toBe(shellTerminalId);
    expect(restoredAgent?.agent.pendingShellContext).toHaveLength(1);
    expect(restoredAgent?.agent.pendingShellContext?.[0]?.command).toContain("SURVIVED_RESTART");

    const restoredTimeline = await client2.fetchAgentTimeline(agent.id, {
      projection: "canonical",
    });
    const userShellEntries = restoredTimeline.entries.filter(
      (entry) =>
        entry.item.type === "tool_call" &&
        entry.item.detail.type === "shell" &&
        entry.item.detail.origin === "user",
    );
    expect(userShellEntries.length).toBeGreaterThanOrEqual(5);
  } finally {
    await mcp1.close().catch(() => undefined);
    await client1.close().catch(() => undefined);
    await daemon1.close().catch(() => undefined);
    await client2?.close().catch(() => undefined);
    await daemon2?.close().catch(() => undefined);
    await rm(workRoot, { recursive: true, force: true });
  }
}, 60_000);

test("E2E: agent request_terminal_control -> attention event + key lock + user PTY input -> hand back & decline", async () => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-ctrl-e2e-"));
  const daemon = await createTestPaseoDaemon({ mcpEnabled: true });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.17.4",
  });
  const mcp = new Client({ name: "e2e-ctrl-mcp", version: "1.0.0" });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    const attentionEvents: RecordedControlAttention[] = [];
    const feeds = client.observeEvents(["terminal_attention_required"], { notifications: true });
    feeds.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "terminal_attention_required") {
          attentionEvents.push(message.payload as RecordedControlAttention);
        }
      },
    });
    await feeds.ready;

    const agent = await client.createAgent({
      provider: "claude",
      cwd: workRoot,
      title: "Take Control E2E",
    });

    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agent.id}`),
      ),
    );

    // 1. Agent creates a regular interactive terminal
    const createdTerm = await mcp.callTool({
      name: "create_terminal",
      arguments: { cwd: workRoot, name: "deploy-shell" },
    });
    expect(createdTerm.isError).not.toBe(true);
    const terminalId = (createdTerm.structuredContent as { id: string }).id;

    // 2. Agent requests human terminal control
    const controlPromise = mcp.callTool({
      name: "request_terminal_control",
      arguments: { terminalId, reason: "Confirm production deploy OTP" },
    });

    await expect
      .poll(
        () =>
          attentionEvents.find(
            (ev) => ev.kind === "control" && ev.controlPrompt?.terminalId === terminalId,
          ) ?? null,
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const listed = await client.listTerminalControlPrompts();
    expect(listed.prompts).toHaveLength(1);
    const controlId = listed.prompts[0].id;
    expect(listed.prompts[0].reason).toBe("Confirm production deploy OTP");

    // 3. While pending, agent send_terminal_keys and request_secure_terminal_input are blocked
    const blockedKeys = await mcp.callTool({
      name: "send_terminal_keys",
      arguments: { terminalId, keys: "echo blocked\n" },
    });
    expect(blockedKeys.isError).toBe(true);

    const blockedSecure = await mcp.callTool({
      name: "request_secure_terminal_input",
      arguments: { terminalId, reason: "cannot coexist" },
    });
    expect(blockedSecure.isError).toBe(true);

    // 4. User interacts with the real PTY terminal and returns control with screen snapshot + note
    client.sendTerminalInput(terminalId, { type: "input", data: "echo USER_TYPED_OTP_OK\r" });
    await new Promise((r) => setTimeout(r, 400));

    const returnRes = await client.respondToTerminalControlPrompt({
      controlId,
      action: "return",
      shareScreen: true,
      note: "OTP submitted cleanly",
    });
    expect(returnRes.success).toBe(true);

    const controlResult = await controlPromise;
    expect(controlResult.isError).not.toBe(true);
    const structured = controlResult.structuredContent as {
      status: string;
      note?: string;
      screen?: string;
    };
    expect(structured.status).toBe("returned");
    expect(structured.note).toBe("OTP submitted cleanly");
    expect(structured.screen).toContain("USER_TYPED_OTP_OK");

    // 5. After hand-back, list is empty and agent can send keys again
    expect((await client.listTerminalControlPrompts()).prompts).toHaveLength(0);
    const unblockedKeys = await mcp.callTool({
      name: "send_terminal_keys",
      arguments: { terminalId, keys: "echo RESUMED_OK\n" },
    });
    expect(unblockedKeys.isError).not.toBe(true);

    // 6. Test decline path
    const declinePromise = mcp.callTool({
      name: "request_terminal_control",
      arguments: { terminalId, reason: "Second control check" },
    });
    await expect
      .poll(async () => (await client.listTerminalControlPrompts()).prompts.length, {
        timeout: 10_000,
      })
      .toBe(1);
    const secondId = (await client.listTerminalControlPrompts()).prompts[0].id;
    const declineRes = await client.respondToTerminalControlPrompt({
      controlId: secondId,
      action: "decline",
    });
    expect(declineRes.success).toBe(true);
    const declineToolRes = await declinePromise;
    expect(declineToolRes.structuredContent).toMatchObject({ status: "declined" });
  } finally {
    await mcp.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    await rm(workRoot, { recursive: true, force: true });
  }
}, 60_000);
