import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { parseAgentMessage } from "../agent/agent-messages/envelope.js";
import { AgentManager } from "../agent/agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import {
  buildManagedToolCallerContext,
  ManagedContinuationsRuntime,
  resolveBootstrapManagedContinuationPolicy,
} from "./index.js";

const AUTO_WAKE_CAPS = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class AutoWakeSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = AUTO_WAKE_CAPS;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  private readonly subscribers = new Set<(ev: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: unknown): Promise<{ turnId: string }> {
    const turnId = `auto-turn-${this.prompts.length + 1}`;
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    queueMicrotask(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
    });
    return { turnId };
  }

  emit(ev: AgentStreamEvent): void {
    for (const cb of this.subscribers) cb(ev);
  }

  subscribe(cb: (ev: AgentStreamEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

class AutoWakeClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = AUTO_WAKE_CAPS;
  readonly sessions: AutoWakeSession[] = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(): Promise<AgentSession> {
    const session = new AutoWakeSession();
    this.sessions.push(session);
    return session;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  async resumeSession(): Promise<AgentSession> {
    return this.createSession();
  }
}

describe("Managed Continuations PR E — Bootstrap Wiring & Default-Deny Policy Resolver", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("defaults to fail-closed Host Shell deny and coldSessionResume=false when no env opt-in is set", () => {
    const bundle = resolveBootstrapManagedContinuationPolicy("codex", {});
    expect(bundle.shellPolicy.hostEnabled).toBe(false);
    expect(bundle.shellPolicy.workspaceEnabled).toBe(false);
    expect(bundle.shellPolicy.profileMode).toBe("read-only");
    expect(bundle.providerCapabilities.coldSessionResume).toBe(false);
  });

  it("enables Host Shell and verified coldSessionResume only for explicitly opted-in providers", () => {
    const env = {
      PASEO_EXPERIMENTAL_MANAGED_CONTINUATIONS_ALLOW_SHELL: "1",
      PASEO_EXPERIMENTAL_COLD_RESUME_PROVIDERS: "codex, claude",
    };
    const codex = resolveBootstrapManagedContinuationPolicy("codex", env);
    expect(codex.shellPolicy.hostEnabled).toBe(true);
    expect(codex.shellPolicy.workspaceEnabled).toBe(true);
    expect(codex.providerCapabilities.coldSessionResume).toBe(true);

    const unknown = resolveBootstrapManagedContinuationPolicy("other-provider", env);
    expect(unknown.providerCapabilities.coldSessionResume).toBe(false);
  });

  it("rejects missing callerAgentId when building tool caller context", () => {
    expect(() =>
      buildManagedToolCallerContext({
        callerAgentId: undefined,
        callerAgent: null,
        agentManager: { getDaemonInstanceId: () => "daemon-1" },
      }),
    ).toThrow(/authenticated callerAgentId/);
  });

  it("automatically settles OriginTurnFence on turn_completed and wakes idle Agent without manual dispatch calls", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-e-home-"));
    const wsDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-e-ws-"));
    tempDirs.push(tmpHome, wsDir);

    const client = new AutoWakeClient();
    let runtime: ManagedContinuationsRuntime | null = null;
    const agentManager = new AgentManager({
      daemonInstanceId: "daemon-e-auto",
      clients: { codex: client },
      resolveOriginFence: (fenceId) =>
        runtime ? runtime.ledgerStore.readFence(fenceId) : Promise.resolve(null),
      logger: createTestLogger(),
    });
    runtime = new ManagedContinuationsRuntime({
      paseoHome: tmpHome,
      agentManager,
      daemonInstanceId: agentManager.getDaemonInstanceId(),
      bootId: "boot-e-auto",
      reconcileIntervalMs: 0,
    });
    await runtime.start({
      restartRecoveryBarrier: async () => undefined,
      receiptProbe: () => ({ status: "not_submitted" }),
    });

    const agent = await agentManager.createAgent({ provider: "codex", cwd: wsDir }, undefined, {});
    const session = client.sessions[0]!;

    await runtime.tools.runBackgroundCommand(
      {
        agentId: agent.id,
        workspaceId: "ws-auto",
        defaultCwd: wsDir,
        allowedWorkspaceRoots: [wsDir],
        originRun: { daemonInstanceId: "daemon-e-auto", runToken: "origin-live-1" },
        shellPolicy: { hostEnabled: true, workspaceEnabled: true, profileMode: "full" },
        providerCapabilities: { coldSessionResume: true },
      },
      { command: "echo AUTO_WAKE_OK; exit 2", timeoutSeconds: 30, notifyOnExit: true },
    );

    session.emit({ type: "turn_completed", provider: "codex", turnId: "origin-live-1" });

    const deadline = Date.now() + 5000;
    while (session.prompts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(session.prompts).toHaveLength(1);
    const parsed = parseAgentMessage(session.prompts[0]!);
    expect(parsed?.source?.kind).toBe("managed-continuation");
    expect(parsed?.text).toContain("AUTO_WAKE_OK");
    expect(parsed?.text).toContain("exitCode=2");
    await runtime.stop({ killTasks: true });
  });
});
