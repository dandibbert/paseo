import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { SecureTerminalPromptBroker } from "../../secure-input/secure-terminal-prompt-broker.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

function setup(callerAgentId?: string) {
  const request = vi.fn(async () => "submitted" as const);
  const catalog = createPaseoToolCatalog({
    agentManager: {
      getAgent: (agentId: string) => ({
        id: agentId,
        cwd: "/work/example",
        workspaceId: "workspace-1",
      }),
    } as unknown as AgentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    secureTerminalPromptBroker: { request } as unknown as SecureTerminalPromptBroker,
    callerAgentId,
    logger: createTestLogger(),
  });
  return { catalog, request };
}

describe("agent MCP secure terminal input", () => {
  it("exposes an agent-scoped tool that returns status without a credential", async () => {
    const { catalog, request } = setup("agent-1");
    const result = await catalog.executeTool("request_secure_terminal_input", {
      terminalId: "term-1",
      reason: "SSH is waiting for a password",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      terminalId: "term-1",
      reason: "SSH is waiting for a password",
      signal: undefined,
    });
    expect(result.structuredContent).toEqual({ status: "submitted" });
    expect(result.content).toEqual([]);
  });

  it("does not expose secure password requests to an unscoped control-plane catalog", () => {
    const { catalog } = setup();
    expect(catalog.getTool("request_secure_terminal_input")).toBeUndefined();
  });
});
