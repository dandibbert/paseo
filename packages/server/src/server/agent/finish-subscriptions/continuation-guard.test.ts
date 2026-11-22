import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  ManagedContinuationLedger,
  ManagedContinuationStore,
  type RunIdentity,
} from "../../managed-continuations/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createObservationBuffer } from "./internal/observation-buffer.js";
import { observeFinishState } from "./internal/observation-stream.js";

function makeChildSnapshot(overrides: Partial<AgentSnapshotPayload> = {}): AgentSnapshotPayload {
  return {
    ...buildStoredAgentPayload(
      {
        id: "child-1",
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-11-19T12:00:00.000Z",
        updatedAt: "2026-11-19T12:00:00.000Z",
        lastUserMessageAt: null,
        lastStatus: "idle",
        persistence: null,
        labels: {},
      },
      ["codex"],
      (_provider, own) => own ?? {},
    ),
    ...overrides,
  };
}

describe("Finish Subscriptions PR A2 — ContinuationLease Guard & Checkpoint Edge", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("suppresses premature finished while ContinuationLease is active, allows permission prompts immediately, and fires finished on idle continuation_checkpoint zero-count edge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-a2-finish-"));
    tempDirs.push(dir);
    const store = new ManagedContinuationStore(dir);
    const controller = new AbortController();
    const buffer = createObservationBuffer(controller.signal);
    const tracker = { lastRevision: -1 };

    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-a2-fin",
      onCheckpoint: (cp) => {
        observeFinishState(
          buffer,
          makeChildSnapshot({
            status: "idle",
            pendingContinuationsCount: cp.summary.pendingContinuationsCount,
            continuationState: cp.summary.continuationState,
            continuationBlockedError: cp.summary.continuationBlockedError,
            continuationRevision: cp.summary.continuationRevision,
          }),
          undefined,
          "done",
          tracker,
        );
      },
    });

    const origin: RunIdentity = { daemonInstanceId: "daemon-a2-fin", runToken: "child-run-1" };
    await ledger.scheduleOneShot({
      wakeId: "wake_1",
      leaseId: "lease_1",
      agentId: "child-1",
      workspaceId: "ws-1",
      origin,
      prompt: "Follow up later",
      afterMinutes: 5,
    });

    const activeSummary = await ledger.getAgentSummary("child-1");
    expect(activeSummary.pendingContinuationsCount).toBe(1);

    observeFinishState(
      buffer,
      makeChildSnapshot({
        status: "idle",
        pendingContinuationsCount: activeSummary.pendingContinuationsCount,
        continuationState: activeSummary.continuationState,
        continuationBlockedError: activeSummary.continuationBlockedError,
        continuationRevision: activeSummary.continuationRevision,
      }),
      { type: "turn_completed", provider: "codex", turnId: "t1" },
      "scheduled follow-up",
      tracker,
    );

    observeFinishState(
      buffer,
      makeChildSnapshot({
        status: "idle",
        pendingContinuationsCount: 1,
        continuationState: "waiting",
        continuationRevision: activeSummary.continuationRevision,
      }),
      {
        type: "permission_requested",
        provider: "codex",
        request: {
          id: "perm-1",
          provider: "codex",
          name: "shell",
          kind: "tool",
          title: "Allow tool",
        },
      },
      null,
      tracker,
    );
    const permEvent = await buffer.next();
    expect(permEvent.status).toBe("permission");

    const cancelRes = await ledger.cancelOneShot("wake_1");
    expect(cancelRes).toEqual({ canceled: true, wakeId: "wake_1" });

    const finalEvent = await buffer.next();
    expect(finalEvent.status).toBe("idle");
    expect(finalEvent.final?.pendingContinuationsCount).toBe(0);
    buffer.dispose();
  });

  it("reports needs_attention as error (never finished) on both initial snapshot and continuation_checkpoint", async () => {
    const controller = new AbortController();
    const buffer = createObservationBuffer(controller.signal);

    buffer.pushInitial({
      status: "idle",
      final: makeChildSnapshot({
        status: "idle",
        pendingContinuationsCount: 1,
        continuationState: "waiting",
        continuationRevision: 1,
      }),
      lastMessage: "waiting",
      error: null,
    });

    const tracker = { lastRevision: 1 };
    observeFinishState(
      buffer,
      makeChildSnapshot({
        status: "idle",
        pendingContinuationsCount: 0,
        continuationState: "needs_attention",
        continuationBlockedError: "wake_turn_aborted_by_daemon_restart",
        continuationRevision: 2,
      }),
      undefined,
      null,
      tracker,
    );

    const errEvent = await buffer.next();
    expect(errEvent.status).toBe("error");
    expect(errEvent.error).toBe("wake_turn_aborted_by_daemon_restart");
    buffer.dispose();
  });
});
