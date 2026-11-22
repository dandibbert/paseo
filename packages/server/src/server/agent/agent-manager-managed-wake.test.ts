import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  ManagedContinuationLedger,
  ManagedContinuationStore,
  type ContinuationCheckpointEvent,
  type RunIdentity,
} from "../managed-continuations/index.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const NON_STEERING_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class NonSteeringTestSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = NON_STEERING_CAPABILITIES;
  readonly id = randomUUID();
  readonly interruptSpy = vi.fn(async () => undefined);
  readonly startedPrompts: string[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnSeq = 0;
  private activeTurnId: string | null = null;

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: unknown): Promise<{ turnId: string }> {
    this.turnSeq += 1;
    const turnId = `turn-${this.turnSeq}`;
    this.activeTurnId = turnId;
    this.startedPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
    return { turnId };
  }

  completeActiveTurn(): void {
    if (!this.activeTurnId) return;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
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

  async interrupt(): Promise<void> {
    await this.interruptSpy();
  }

  async close(): Promise<void> {}
}

class NonSteeringTestClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = NON_STEERING_CAPABILITIES;
  readonly sessions: NonSteeringTestSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new NonSteeringTestSession();
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

async function drainIterator(iterator: AsyncGenerator<AgentStreamEvent>): Promise<void> {
  for await (const _ of iterator) {
    // Drain events while AgentManager subscribers observe them.
  }
}

describe("AgentManager PR A2 — Atomic Idle-Only Managed Wake Admission", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("atomically reserves an idle slot, blocks concurrent Human/replace calls without mutual cancellation, and commits a plain new turn on non-steering ACP", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-a2-am-"));
    tempDirs.push(cwd);
    const client = new NonSteeringTestClient();
    const manager = new AgentManager({
      daemonInstanceId: "daemon-a2-real",
      clients: { codex: client },
      logger: createTestLogger(),
    });

    const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {});
    const session = client.sessions[0]!;

    const reserved = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_1",
      batchMessageId: "msg_1",
      creatorFenceId: null,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    expect(manager.hasManagedWakeReservation(agent.id)).toBe(true);
    expect(manager.hasInFlightRun(agent.id)).toBe(true);

    expect(() => manager.streamAgent(agent.id, "human prompt")).toThrow(/reserved managed-wake/);
    await expect(manager.replaceAgentRun(agent.id, "human replace")).rejects.toThrow(
      /reserved managed-wake/,
    );
    expect(session.interruptSpy).not.toHaveBeenCalled();

    const committed = await manager.commitManagedWake({
      reservationId: reserved.reservationId,
      serializedPrompt: "Managed wake payload",
    });
    expect(committed.run.daemonInstanceId).toBe("daemon-a2-real");
    const draining = drainIterator(committed.iterator);
    await Promise.resolve();
    await Promise.resolve();

    const second = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_2",
      batchMessageId: "msg_2",
      creatorFenceId: null,
    });
    expect(second.status).toBe("busy");
    expect(session.interruptSpy).not.toHaveBeenCalled();

    session.completeActiveTurn();
    await draining;

    const third = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_3",
      batchMessageId: "msg_3",
      creatorFenceId: null,
    });
    expect(third.status).toBe("reserved");
    if (third.status === "reserved") {
      await manager.releaseManagedWake(third.reservationId, "test_cleanup");
    }
    expect(manager.hasManagedWakeReservation(agent.id)).toBe(false);
  });

  it("enforces OriginTurnFence, restart_recovery_pending, and emits continuation_checkpoint events to agent subscribers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-a2-fence-"));
    tempDirs.push(cwd);
    const store = new ManagedContinuationStore(cwd);
    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-a2-fence",
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-a2-fence", runToken: "origin-1" };
    const fence = await ledger.getOrCreateOriginFence(origin);

    let restartPending = true;
    const client = new NonSteeringTestClient();
    const manager = new AgentManager({
      daemonInstanceId: "daemon-a2-fence",
      clients: { codex: client },
      isRestartRecoveryPending: () => restartPending,
      resolveOriginFence: (fenceId) => store.readFence(fenceId),
      logger: createTestLogger(),
    });

    const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {});

    const blockedByRestart = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_r",
      batchMessageId: "msg_r",
      creatorFenceId: fence.fenceId,
    });
    expect(blockedByRestart.status).toBe("restart_recovery_pending");
    restartPending = false;

    const blockedByFence = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_f",
      batchMessageId: "msg_f",
      creatorFenceId: fence.fenceId,
    });
    expect(blockedByFence).toEqual({ status: "busy", detail: "origin_turn_fence_pending" });

    await ledger.settleOriginFence(origin);
    const allowed = await manager.tryReserveManagedWake({
      agentId: agent.id,
      batchId: "batch_f",
      batchMessageId: "msg_f",
      creatorFenceId: fence.fenceId,
    });
    expect(allowed.status).toBe("reserved");
    if (allowed.status === "reserved") {
      await manager.releaseManagedWake(allowed.reservationId, "done");
    }

    const received: AgentManagerEvent[] = [];
    const unsubscribe = manager.subscribe((ev) => received.push(ev), {
      agentId: agent.id,
      replayState: false,
    });
    const checkpoint: ContinuationCheckpointEvent = {
      type: "continuation_checkpoint",
      agentId: agent.id,
      revision: 1,
      summary: {
        pendingContinuationsCount: 0,
        continuationState: "none",
        continuationBlockedError: null,
        continuationRevision: 1,
      },
      reason: "one_shot_canceled",
      emittedAt: new Date().toISOString(),
    };
    manager.emitContinuationCheckpoint(checkpoint);
    unsubscribe();

    expect(received).toEqual([{ type: "continuation_checkpoint", agentId: agent.id, checkpoint }]);
  });
});
