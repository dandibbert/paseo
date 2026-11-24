import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { SecureTerminalPromptBroker } from "../../secure-input/secure-terminal-prompt-broker.js";
import type { TerminalControlBroker } from "../../terminal-control/terminal-control-broker.js";
import type { AgentShellService } from "../agent-shell-service.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

function setup(options?: {
  callerAgentId?: string;
  dedicatedTerminalIds?: string[];
  controlPendingTerminalIds?: string[];
  securePendingTerminalIds?: string[];
}) {
  const dedicated = new Set(options?.dedicatedTerminalIds ?? ["dedicated-term"]);
  const controlPending = new Set(options?.controlPendingTerminalIds ?? []);
  const securePending = new Set(options?.securePendingTerminalIds ?? []);

  const requestControl = vi.fn(async () => ({
    status: "returned" as const,
    requestId: "req-1",
    screen: "Authenticated",
    note: "done",
  }));

  const send = vi.fn();
  const kill = vi.fn();
  const terminalsById = new Map([
    [
      "agent-term",
      {
        id: "agent-term",
        name: "Agent Terminal",
        cwd: "/work/example",
        workspaceId: "workspace-1",
        send,
        kill,
        getReplayPreamble: () => "",
      },
    ],
    [
      "dedicated-term",
      {
        id: "dedicated-term",
        name: "Agent · shell",
        cwd: "/work/example",
        workspaceId: "workspace-1",
        send,
        kill,
        getReplayPreamble: () => "",
      },
    ],
  ]);

  const terminalManager = {
    listDirectories: () => ["/work/example"],
    getTerminals: async () => [...terminalsById.values()],
    getTerminal: (id: string) => terminalsById.get(id),
    captureTerminal: async () => ({ lines: ["ok"], totalLines: 1 }),
  } as unknown as TerminalManager;

  const catalog = createPaseoToolCatalog({
    agentManager: {
      getPluginTools: () => [],
      getAgent: (agentId: string) => ({
        id: agentId,
        cwd: "/work/example",
        workspaceId: "workspace-1",
      }),
    } as unknown as AgentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    terminalManager,
    terminalControlBroker: {
      request: requestControl,
      hasPendingForTerminal: (id: string) => controlPending.has(id),
    } as unknown as TerminalControlBroker,
    secureTerminalPromptBroker: {
      request: vi.fn(async () => "submitted" as const),
      hasPendingForTerminal: (id: string) => securePending.has(id),
    } as unknown as SecureTerminalPromptBroker,
    agentShellService: {
      isDedicatedShellTerminal: (id: string) => dedicated.has(id),
    } as unknown as AgentShellService,
    callerAgentId: options?.callerAgentId,
    logger: createTestLogger(),
  });

  return { catalog, requestControl, send, kill };
}

describe("agent MCP terminal control and shell isolation", () => {
  it("exposes request_terminal_control to agent-scoped catalogs and forwards arguments", async () => {
    const { catalog, requestControl } = setup({ callerAgentId: "agent-1" });
    const result = await catalog.executeTool("request_terminal_control", {
      terminalId: "agent-term",
      reason: "Complete SSO login in browser",
      requestId: "req-prev",
    });

    expect(requestControl).toHaveBeenCalledExactlyOnceWith({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      terminalId: "agent-term",
      reason: "Complete SSO login in browser",
      requestId: "req-prev",
      signal: undefined,
    });
    expect(result.structuredContent).toEqual({
      status: "returned",
      requestId: "req-1",
      screen: "Authenticated",
      note: "done",
    });
  });

  it("does not expose request_terminal_control to an unscoped control-plane catalog", () => {
    const { catalog } = setup();
    expect(catalog.getTool("request_terminal_control")).toBeUndefined();
  });

  it("excludes dedicated user shell terminals from agent terminal tools", async () => {
    const { catalog, kill, send } = setup({ callerAgentId: "agent-1" });

    const listed = await catalog.executeTool("list_terminals", { cwd: "/work/example" });
    expect(listed.structuredContent).toEqual({
      terminals: [{ id: "agent-term", name: "Agent Terminal", cwd: "/work/example" }],
    });

    await expect(
      catalog.executeTool("capture_terminal", { terminalId: "dedicated-term" }),
    ).rejects.toThrow("user-dedicated shell terminal");
    await expect(
      catalog.executeTool("send_terminal_keys", { terminalId: "dedicated-term", keys: "ls" }),
    ).rejects.toThrow("user-dedicated shell terminal");
    await expect(
      catalog.executeTool("kill_terminal", { terminalId: "dedicated-term" }),
    ).rejects.toThrow("user-dedicated shell terminal");
    await expect(
      catalog.executeTool("request_terminal_control", {
        terminalId: "dedicated-term",
        reason: "Need control",
      }),
    ).rejects.toThrow("user-dedicated shell terminal");
    await expect(
      catalog.executeTool("request_secure_terminal_input", {
        terminalId: "dedicated-term",
        reason: "Password",
      }),
    ).rejects.toThrow("user-dedicated shell terminal");

    expect(kill).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks send_terminal_keys while terminal control or secure input is pending", async () => {
    const controlSetup = setup({
      callerAgentId: "agent-1",
      controlPendingTerminalIds: ["agent-term"],
    });
    await expect(
      controlSetup.catalog.executeTool("send_terminal_keys", {
        terminalId: "agent-term",
        keys: "Enter",
      }),
    ).rejects.toThrow("under human control");
    expect(controlSetup.send).not.toHaveBeenCalled();

    const secureSetup = setup({
      callerAgentId: "agent-1",
      securePendingTerminalIds: ["agent-term"],
    });
    await expect(
      secureSetup.catalog.executeTool("send_terminal_keys", {
        terminalId: "agent-term",
        keys: "Enter",
      }),
    ).rejects.toThrow("under human control");
    expect(secureSetup.send).not.toHaveBeenCalled();
  });
});
