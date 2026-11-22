import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AutonomousBudgetExceededError,
  CrossEpochOperationError,
  FallbackForbiddenError,
  ImmutableBatchError,
  InvalidManagedIdError,
  ManagedContinuationLedger,
  ManagedContinuationStore,
  OriginFencePendingError,
  SendLaterTimeError,
  accountingFilename,
  computeFenceId,
  eventFilename,
  resolveSendLaterSchedule,
  validateSendLaterAt,
  type ContinuationCheckpointEvent,
  type RunIdentity,
} from "./index.js";

describe("Managed Continuations PR A1 — Pure Ledger, Immutable Batch & Epoch Primitives", () => {
  let tmpDir: string;
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-a1-"));
    nowMs = Date.parse("2026-11-19T12:00:01.000Z");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("shares a single authoritative OriginTurnFence across 2 Tasks + 1 fallback in the same turn and blocks fast-exit preemption", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const checkpoints: ContinuationCheckpointEvent[] = [];
    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-epoch-1",
      clock,
      onCheckpoint: (ev) => checkpoints.push(ev),
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-epoch-1", runToken: "run-origin-1" };

    const lease1 = await ledger.registerTaskLease({
      leaseId: "lease_t1",
      taskId: "task_1",
      agentId: "agent-alpha",
      workspaceId: "ws-1",
      origin,
    });
    const lease2 = await ledger.registerTaskLease({
      leaseId: "lease_t2",
      taskId: "task_2",
      agentId: "agent-alpha",
      workspaceId: "ws-1",
      origin,
    });
    const fbResult = await ledger.scheduleOneShot({
      wakeId: "wake_fb1",
      leaseId: "lease_fb1",
      agentId: "agent-alpha",
      workspaceId: "ws-1",
      origin,
      prompt: "Check CI status if task_1 notification was missed",
      afterMinutes: 30,
      fallbackForTaskId: "task_1",
    });

    expect(fbResult.status).toBe("scheduled");
    expect(lease1).not.toBeNull();
    expect(lease2).not.toBeNull();

    const expectedFenceId = computeFenceId(origin);
    const fences = await store.listFences();
    expect(fences.corrupt).toHaveLength(0);
    expect(fences.records).toHaveLength(1);
    expect(fences.records[0]!.fenceId).toBe(expectedFenceId);
    expect(fences.records[0]!.state).toBe("pending");

    // All 3 leases point to the exact same creatorFenceId and do NOT mirror FenceState.
    const fbLease = await store.readLease("lease_fb1");
    expect(lease1!.creatorFenceId).toBe(expectedFenceId);
    expect(lease2!.creatorFenceId).toBe(expectedFenceId);
    expect(fbLease!.creatorFenceId).toBe(expectedFenceId);
    const rawLeaseJson = JSON.parse(await fs.readFile(store.leasePath("lease_t1"), "utf8"));
    expect("fenceState" in rawLeaseJson).toBe(false);
    expect("settledAt" in rawLeaseJson).toBe(false);

    // 0.1s fast exit before creator turn settles MUST be blocked by pending Fence.
    nowMs += 100;
    const ev1 = await ledger.recordTaskTerminalEvent({
      taskId: "task_1",
      agentId: "agent-alpha",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_1/result.json",
    });
    expect(ev1).not.toBeNull();
    // Fallback moved to suspended_by_primary (provisional cover, NOT covered yet).
    const fbAfterTerminal = await store.readWakeup("wake_fb1");
    expect(fbAfterTerminal!.coverageState).toBe("suspended_by_primary");

    await expect(
      ledger.freezeBatch({
        batchId: "batch_1",
        batchMessageId: "msg_1",
        agentId: "agent-alpha",
        eventIds: [ev1!.eventId],
        serializedPrompt: "Task 1 finished",
      }),
    ).rejects.toThrow(OriginFencePendingError);

    // Settle the single authoritative Fence in the same daemon epoch -> unblocks batch freeze.
    const settledFence = await ledger.settleOriginFence(origin);
    expect(settledFence.state).toBe("settled");

    const batch = await ledger.freezeBatch({
      batchId: "batch_1",
      batchMessageId: "msg_1",
      agentId: "agent-alpha",
      eventIds: [ev1!.eventId],
      serializedPrompt: "Task 1 finished",
    });
    expect(batch.state).toBe("frozen");
    expect(checkpoints.length).toBeGreaterThan(0);
  });

  it("enforces notifyOnExit:false creates no Lease and no automatic WakeEvent", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-1",
      clock,
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "run-1" };

    const lease = await ledger.registerTaskLease({
      leaseId: "lease_silent",
      taskId: "task_silent",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin,
      notifyOnExit: false,
    });
    expect(lease).toBeNull();
    expect((await store.listLeases()).records).toHaveLength(0);

    const ev = await ledger.recordTaskTerminalEvent({
      taskId: "task_silent",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_silent/result.json",
    });
    expect(ev).toBeNull();
    expect(await ledger.deriveTaskWakeState("agent-1", "task_silent", false)).toBe("not_required");

    // A fallback for a notifyOnExit:false task still schedules normally as armed.
    const fb = await ledger.scheduleOneShot({
      wakeId: "wake_silent_fb",
      leaseId: "lease_silent_fb",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin,
      prompt: "Check silent task manually",
      afterSeconds: 60,
      fallbackForTaskId: "task_silent",
    });
    expect(fb.status).toBe("scheduled");
    expect((await store.readWakeup("wake_silent_fb"))!.coverageState).toBe("armed");
  });

  it("marks cross-epoch pending Fences aborted_by_restart after barrier and reconciles resumed_running & 3 dispatch fault points", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const ledger1 = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-epoch-1",
      clock,
    });
    const origin1: RunIdentity = { daemonInstanceId: "daemon-epoch-1", runToken: "origin-1" };
    const origin2: RunIdentity = { daemonInstanceId: "daemon-epoch-1", runToken: "origin-2" };

    // 1) Pending fence across restart
    await ledger1.registerTaskLease({
      leaseId: "lease_pending_fence",
      taskId: "task_pf",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin: origin1,
    });

    // 2) Settled fence with 3 batches representing the 3 dispatch fault points + 1 resumed_running lease
    await ledger1.registerTaskLease({
      leaseId: "lease_retry",
      taskId: "task_retry",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin: origin2,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_accepted",
      taskId: "task_accepted",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin: origin2,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_uncertain",
      taskId: "task_uncertain",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin: origin2,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_running",
      taskId: "task_running",
      agentId: "agent-2",
      workspaceId: "ws-1",
      origin: origin2,
    });
    await ledger1.settleOriginFence(origin2);

    const evRetry = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_retry",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_retry/result.json",
    }))!;
    const evAccepted = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_accepted",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_accepted/result.json",
    }))!;
    const evUncertain = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_uncertain",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_uncertain/result.json",
    }))!;
    const evRunning = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_running",
      agentId: "agent-2",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_running/result.json",
    }))!;

    await ledger1.freezeBatch({
      batchId: "batch_retry",
      batchMessageId: "msg_retry",
      agentId: "agent-1",
      eventIds: [evRetry.eventId],
      serializedPrompt: "Retry prompt",
    });
    await ledger1.markBatchDispatching("batch_retry", "att_1");

    await ledger1.freezeBatch({
      batchId: "batch_accepted",
      batchMessageId: "msg_accepted",
      agentId: "agent-1",
      eventIds: [evAccepted.eventId],
      serializedPrompt: "Accepted prompt",
    });
    await ledger1.markBatchDispatching("batch_accepted", "att_2");

    await ledger1.freezeBatch({
      batchId: "batch_uncertain",
      batchMessageId: "msg_uncertain",
      agentId: "agent-1",
      eventIds: [evUncertain.eventId],
      serializedPrompt: "Uncertain prompt",
    });
    await ledger1.markBatchDispatching("batch_uncertain", "att_3");

    await ledger1.freezeBatch({
      batchId: "batch_running",
      batchMessageId: "msg_running",
      agentId: "agent-2",
      eventIds: [evRunning.eventId],
      serializedPrompt: "Running prompt",
    });
    await ledger1.markBatchDispatching("batch_running", "att_4");
    await ledger1.reconcileDispatchOutcome("batch_running", {
      status: "accepted",
      providerReceiptId: "rcpt_4",
    });
    await ledger1.attachWakeRunToBatch("batch_running", {
      daemonInstanceId: "daemon-epoch-1",
      runToken: "wake-run-old",
    });

    // Simulate Daemon SIGKILL -> new daemon epoch!
    nowMs += 5_000;
    const checkpoints: ContinuationCheckpointEvent[] = [];
    const ledger2 = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-epoch-2",
      clock,
      onCheckpoint: (ev) => checkpoints.push(ev),
    });

    // Cross-epoch settleOriginFence MUST be forbidden.
    await expect(ledger2.settleOriginFence(origin1)).rejects.toThrow(CrossEpochOperationError);

    let barrierAwaited = false;
    const report = await ledger2.reconcileStartup({
      restartRecoveryBarrier: async () => {
        barrierAwaited = true;
      },
      receiptProbe: (batch) => {
        if (batch.batchId === "batch_retry") return { status: "not_submitted" };
        if (batch.batchId === "batch_accepted") {
          return { status: "accepted", providerReceiptId: "rcpt_2" };
        }
        return { status: "uncertain", detail: "pending_receipt_no_confirmation" };
      },
    });

    expect(barrierAwaited).toBe(true);
    expect(report.corruptRecords).toHaveLength(0);
    expect(report.abortedFenceIds).toEqual([computeFenceId(origin1)]);
    expect((await store.readFence(computeFenceId(origin1)))!.state).toBe("aborted_by_restart");

    // Fault point 1 (beforeProviderSend): retryable with exact same batchMessageId & promptDigest.
    expect(report.retriedBatchIds).toEqual(["batch_retry"]);
    const bRetry = (await store.readBatch("batch_retry"))!;
    expect(bRetry.state).toBe("frozen");
    expect(bRetry.batchMessageId).toBe("msg_retry");
    expect((await store.readLease("lease_retry"))!.state).toBe("pending_delivery");

    // Fault point 2 (afterProviderSend): marked accepted; lease blocked because no wake completion evidence.
    expect(report.acceptedBatchIds).toEqual(["batch_accepted"]);
    expect((await store.readBatch("batch_accepted"))!.state).toBe("accepted");
    expect((await store.readLease("lease_accepted"))!.blockedReason).toBe(
      "wake_turn_aborted_by_daemon_restart",
    );

    // Fault point 3 (beforeReceiptCommit / unknown): uncertain + blocked(dispatch_uncertain), NEVER retried.
    expect(report.uncertainBatchIds).toEqual(["batch_uncertain"]);
    expect((await store.readBatch("batch_uncertain"))!.state).toBe("uncertain");
    expect((await store.readLease("lease_uncertain"))!.blockedReason).toBe("dispatch_uncertain");

    // Cross-epoch resumed_running lease -> blocked(wake_turn_aborted_by_daemon_restart) & wakeRun cleared.
    const lRunning = (await store.readLease("lease_running"))!;
    expect(lRunning.state).toBe("blocked");
    expect(lRunning.blockedReason).toBe("wake_turn_aborted_by_daemon_restart");
    expect(lRunning.wakeRun).toBeUndefined();

    const summary2 = await ledger2.getAgentSummary("agent-2");
    expect(summary2.pendingContinuationsCount).toBe(0);
    expect(summary2.continuationState).toBe("needs_attention");
    expect(summary2.continuationBlockedError).toBe("wake_turn_aborted_by_daemon_restart");
    expect(checkpoints.some((c) => c.agentId === "agent-2")).toBe(true);
  });

  it("keeps frozen Batch [A,B] immutable after restart and forces arriving event C into a new Batch", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const ledger1 = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-1",
      clock,
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "origin-ab" };

    await ledger1.registerTaskLease({
      leaseId: "lease_a",
      taskId: "task_a",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_b",
      taskId: "task_b",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_c",
      taskId: "task_c",
      agentId: "agent-1",
      workspaceId: "ws-1",
      origin,
    });
    await ledger1.settleOriginFence(origin);

    const evA = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_a",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_a/result.json",
    }))!;
    const evB = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_b",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_b/result.json",
    }))!;

    const batchAB = await ledger1.freezeBatch({
      batchId: "batch_ab",
      batchMessageId: "msg_ab",
      agentId: "agent-1",
      eventIds: [evA.eventId, evB.eventId],
      serializedPrompt: "Events A and B finished",
    });

    // Event C arrives AFTER [A, B] is frozen.
    const evC = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_c",
      agentId: "agent-1",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_c/result.json",
    }))!;

    // Attempting to mutate frozen batch_ab to include C MUST fail.
    await expect(
      ledger1.freezeBatch({
        batchId: "batch_ab",
        batchMessageId: "msg_ab",
        agentId: "agent-1",
        eventIds: [evA.eventId, evB.eventId, evC.eventId],
        serializedPrompt: "Events A, B, and C finished",
      }),
    ).rejects.toThrow(ImmutableBatchError);

    // Event C MUST go into a separate Batch.
    const batchC = await ledger1.freezeBatch({
      batchId: "batch_c",
      batchMessageId: "msg_c",
      agentId: "agent-1",
      eventIds: [evC.eventId],
      serializedPrompt: "Event C finished",
    });
    expect(batchC.eventIds).toEqual([evC.eventId]);

    // After restart, [A, B] preserves identical batchMessageId & promptDigest.
    const reloaded = (await store.readBatch("batch_ab"))!;
    expect(reloaded.eventIds).toEqual([evA.eventId, evB.eventId]);
    expect(reloaded.batchMessageId).toBe(batchAB.batchMessageId);
    expect(reloaded.promptDigest).toBe(batchAB.promptDigest);

    // Accepting & attaching a Wake Run settles BOTH A and B together.
    await ledger1.markBatchDispatching("batch_ab", "att_ab");
    await ledger1.reconcileDispatchOutcome("batch_ab", { status: "accepted" });
    const wakeRun: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "wake-ab" };
    const bound = await ledger1.attachWakeRunToBatch("batch_ab", wakeRun);
    expect(bound.map((l) => l.leaseId).sort()).toEqual(["lease_a", "lease_b"]);

    const settled = await ledger1.settleWakeTurn({
      agentId: "agent-1",
      wakeRun,
      outcome: { kind: "completed" },
    });
    expect(settled.settledLeaseIds.sort()).toEqual(["lease_a", "lease_b"]);
  });

  it("enforces Guardrail #1 (User Stop never reactivates fallback; provider_failure emits read-only recovery-diagnostic; takeover clears needs_attention while retaining audit)", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-1",
      clock,
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "origin-g1" };

    // Case A: User Stop must cancel fallback permanently (no zombie resurrection after dueAt).
    await ledger.registerTaskLease({
      leaseId: "lease_stop",
      taskId: "task_stop",
      agentId: "agent-stop",
      workspaceId: "ws-1",
      origin,
    });
    await ledger.scheduleOneShot({
      wakeId: "wake_stop_fb",
      leaseId: "lease_stop_fb",
      agentId: "agent-stop",
      workspaceId: "ws-1",
      origin,
      prompt: "Run deploy again if task_stop fails",
      afterMinutes: 5,
      fallbackForTaskId: "task_stop",
    });
    await ledger.settleOriginFence(origin);
    const evStop = (await ledger.recordTaskTerminalEvent({
      taskId: "task_stop",
      agentId: "agent-stop",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_stop/result.json",
    }))!;
    await ledger.freezeBatch({
      batchId: "batch_stop",
      batchMessageId: "msg_stop",
      agentId: "agent-stop",
      eventIds: [evStop.eventId],
      serializedPrompt: "task_stop completed",
    });
    await ledger.markBatchDispatching("batch_stop", "att_stop");
    await ledger.reconcileDispatchOutcome("batch_stop", { status: "accepted" });
    const wakeStop: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "wake-stop" };
    await ledger.attachWakeRunToBatch("batch_stop", wakeStop);

    const stopRes = await ledger.settleWakeTurn({
      agentId: "agent-stop",
      wakeRun: wakeStop,
      outcome: { kind: "user_stop" },
    });
    expect(stopRes.reactivatedWakeIds).toHaveLength(0);
    expect((await store.readWakeup("wake_stop_fb"))!.coverageState).toBe("canceled");

    // Advance past dueAt -> ZERO wake events emitted!
    nowMs += 10 * 60_000;
    const dueAfterStop = await ledger.processDueOneShots();
    expect(dueAfterStop).toHaveLength(0);

    // Scheduling a new fallback for the user-stopped task is also forbidden.
    await expect(
      ledger.scheduleOneShot({
        wakeId: "wake_stop_fb2",
        leaseId: "lease_stop_fb2",
        agentId: "agent-stop",
        workspaceId: "ws-1",
        origin,
        prompt: "Try again",
        afterMinutes: 1,
        fallbackForTaskId: "task_stop",
      }),
    ).rejects.toThrow(FallbackForbiddenError);

    // Explicit human takeover clears current needs_attention projection when settled, preserving audit history.
    expect((await ledger.getAgentSummary("agent-stop")).continuationState).toBe("needs_attention");
    const takeoverRun: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "human-takeover-1" };
    await ledger.explicitHumanTakeover({
      agentId: "agent-stop",
      leaseIds: ["lease_stop"],
      newRun: takeoverRun,
      resetCredential: "human-msg-1",
    });
    await ledger.settleWakeTurn({
      agentId: "agent-stop",
      wakeRun: takeoverRun,
      outcome: { kind: "completed" },
    });
    const postTakeoverSummary = await ledger.getAgentSummary("agent-stop");
    expect(postTakeoverSummary.continuationState).toBe("none");
    expect(postTakeoverSummary.continuationBlockedError).toBeNull();
    const accounting = (await store.readAccounting("agent-stop"))!;
    expect(accounting.auditHistory.some((a) => a.kind === "user_stop")).toBe(true);
    expect(accounting.auditHistory.some((a) => a.kind === "takeover_settled")).toBe(true);
    expect(accounting.auditHistory.some((a) => a.kind === "needs_attention_cleared")).toBe(true);

    // Case B: Unexpected provider_failure reactivates fallback ONLY as read-only recovery-diagnostic.
    const originFail: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "origin-fail" };
    await ledger.registerTaskLease({
      leaseId: "lease_fail",
      taskId: "task_fail",
      agentId: "agent-fail",
      workspaceId: "ws-1",
      origin: originFail,
    });
    await ledger.scheduleOneShot({
      wakeId: "wake_fail_fb",
      leaseId: "lease_fail_fb",
      agentId: "agent-fail",
      workspaceId: "ws-1",
      origin: originFail,
      prompt: "git push origin main",
      afterMinutes: 2,
      fallbackForTaskId: "task_fail",
    });
    await ledger.settleOriginFence(originFail);
    const evFail = (await ledger.recordTaskTerminalEvent({
      taskId: "task_fail",
      agentId: "agent-fail",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_fail/result.json",
    }))!;
    await ledger.freezeBatch({
      batchId: "batch_fail",
      batchMessageId: "msg_fail",
      agentId: "agent-fail",
      eventIds: [evFail.eventId],
      serializedPrompt: "task_fail completed",
    });
    await ledger.markBatchDispatching("batch_fail", "att_fail");
    await ledger.reconcileDispatchOutcome("batch_fail", { status: "accepted" });
    const wakeFail: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "wake-fail" };
    await ledger.attachWakeRunToBatch("batch_fail", wakeFail);
    const failRes = await ledger.settleWakeTurn({
      agentId: "agent-fail",
      wakeRun: wakeFail,
      outcome: { kind: "provider_failure", error: "503 overloaded" },
    });
    expect(failRes.reactivatedWakeIds).toEqual(["wake_fail_fb"]);

    nowMs += 3 * 60_000;
    const diagEvents = await ledger.processDueOneShots();
    expect(diagEvents).toHaveLength(1);
    expect(diagEvents[0]!.origin).toBe("recovery-diagnostic");
    expect(diagEvents[0]!.readOnlyDiagnostic).toBe(true);
  });

  it("enforces Guardrail #3 (exact CancelWakeupResult for suspended_by_primary vs already_covered vs already_settled)", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const checkpoints: ContinuationCheckpointEvent[] = [];
    const ledger = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-1",
      clock,
      onCheckpoint: (ev) => checkpoints.push(ev),
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "origin-cancel" };

    await ledger.registerTaskLease({
      leaseId: "lease_p1",
      taskId: "task_p1",
      agentId: "agent-c",
      workspaceId: "ws-1",
      origin,
    });
    await ledger.scheduleOneShot({
      wakeId: "wake_susp",
      leaseId: "lease_susp",
      agentId: "agent-c",
      workspaceId: "ws-1",
      origin,
      prompt: "fallback 1",
      afterMinutes: 10,
      fallbackForTaskId: "task_p1",
    });
    await ledger.scheduleOneShot({
      wakeId: "wake_cov",
      leaseId: "lease_cov",
      agentId: "agent-c",
      workspaceId: "ws-1",
      origin,
      prompt: "fallback 2",
      afterMinutes: 10,
      fallbackForTaskId: "task_p1",
    });
    await ledger.settleOriginFence(origin);

    const evP1 = (await ledger.recordTaskTerminalEvent({
      taskId: "task_p1",
      agentId: "agent-c",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_p1/result.json",
    }))!;
    expect((await store.readWakeup("wake_susp"))!.coverageState).toBe("suspended_by_primary");

    // 1) Canceling suspended_by_primary MUST succeed, release fallback lease, and NOT cancel primary task.
    const resSusp = await ledger.cancelOneShot("wake_susp");
    expect(resSusp).toEqual({ canceled: true, wakeId: "wake_susp" });
    expect((await store.readLease("lease_susp"))!.state).toBe("canceled");
    expect((await store.readLease("lease_p1"))!.state).toBe("pending_delivery");

    // 2) Canceling again returns already_settled.
    expect(await ledger.cancelOneShot("wake_susp")).toEqual({
      canceled: false,
      wakeId: "wake_susp",
      reason: "already_settled",
    });

    // 3) Settling primary wake turn eager-covers wake_cov -> cancelOneShot returns already_covered.
    await ledger.freezeBatch({
      batchId: "batch_p1",
      batchMessageId: "msg_p1",
      agentId: "agent-c",
      eventIds: [evP1.eventId],
      serializedPrompt: "p1 done",
    });
    await ledger.markBatchDispatching("batch_p1", "att_p1");
    await ledger.reconcileDispatchOutcome("batch_p1", { status: "accepted" });
    const wakeRun: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "wake-p1" };
    await ledger.attachWakeRunToBatch("batch_p1", wakeRun);
    const settled = await ledger.settleWakeTurn({
      agentId: "agent-c",
      wakeRun,
      outcome: { kind: "completed" },
    });
    expect(settled.coveredWakeIds).toEqual(["wake_cov"]);
    expect((await store.readLease("lease_cov"))!.state).toBe("covered");
    expect(await ledger.cancelOneShot("wake_cov")).toEqual({
      canceled: false,
      wakeId: "wake_cov",
      reason: "already_covered",
    });
    // Pending count dropped to 0 -> checkpoint emitted.
    const lastCp = checkpoints.at(-1)!;
    expect(lastCp.summary.pendingContinuationsCount).toBe(0);
  });

  it("enforces Guardrail #4 (send_later(at) bounds/clamping, safe hashed filenames, accounting verification & atomic write fault tolerance)", async () => {
    const now = Date.parse("2026-11-19T12:00:01.000Z");

    // Missing timezone rejected
    expect(() => validateSendLaterAt("2026-11-19T12:05:00", now)).toThrowError(SendLaterTimeError);
    try {
      validateSendLaterAt("2026-11-19T12:05:00", now);
    } catch (err) {
      expect((err as SendLaterTimeError).code).toBe("WAKE_TIME_MISSING_TIMEZONE");
    }

    // Invalid calendar date rejected
    expect(() => validateSendLaterAt("2026-02-30T12:05:00Z", now)).toThrowError(SendLaterTimeError);

    // Last year / < now - 60s rejected
    try {
      validateSendLaterAt("2025-11-19T12:05:00Z", now);
      expect.unreachable();
    } catch (err) {
      expect((err as SendLaterTimeError).code).toBe("WAKE_TIME_IN_PAST");
    }
    try {
      validateSendLaterAt("2026-11-19T11:59:00.000Z", now); // 61s in past
      expect.unreachable();
    } catch (err) {
      expect((err as SendLaterTimeError).code).toBe("WAKE_TIME_IN_PAST");
    }

    // > now + 30d rejected
    try {
      validateSendLaterAt("2026-12-20T12:00:02.000Z", now);
      expect.unreachable();
    } catch (err) {
      expect((err as SendLaterTimeError).code).toBe("WAKE_TIME_TOO_FAR");
    }

    // Near-now [now-60s .. now+10s] clamped to now+10s and echoed
    const clampedPast = validateSendLaterAt("2026-11-19T11:59:30.000Z", now);
    expect(clampedPast.clamped).toBe(true);
    expect(clampedPast.dueAt).toBe("2026-11-19T12:00:11.000Z");

    const clampedFuture = validateSendLaterAt("2026-11-19T12:00:08.000Z", now);
    expect(clampedFuture.clamped).toBe(true);
    expect(clampedFuture.dueAt).toBe("2026-11-19T12:00:11.000Z");

    // now + 11s preserved exactly (not clamped)
    const exactFuture = validateSendLaterAt("2026-11-19T12:00:12.000Z", now);
    expect(exactFuture.clamped).toBe(false);
    expect(exactFuture.dueAt).toBe("2026-11-19T12:00:12.000Z");

    // Relative afterMinutes=1 at 12:00:01Z -> exact 12:01:01Z (no cron minute ceiling)
    const rel = resolveSendLaterSchedule({ afterMinutes: 1 }, now);
    expect(rel.dueAt).toBe("2026-11-19T12:01:01.000Z");

    // Safe filename codecs: logical eventId with colons is hashed, malicious IDs rejected
    const evFile = eventFilename("task:abc:terminal");
    expect(evFile).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(evFile.includes(":")).toBe(false);

    const store = new ManagedContinuationStore(tmpDir);
    expect(() => store.leasePath("../escape")).toThrow(InvalidManagedIdError);
    expect(() => store.leasePath("task:colon")).toThrow(InvalidManagedIdError);
    expect(() => store.batchPath("bad/slash")).toThrow(InvalidManagedIdError);

    // accounting/<sha256(agentId)>.json verifies internal agentId
    const acctFile = accountingFilename("agent/with:unsafe..chars");
    expect(acctFile).toMatch(/^[a-f0-9]{64}\.json$/);
    await store.writeAccounting({
      agentId: "agent/with:unsafe..chars",
      consecutiveAutonomousTurns: 3,
      autonomousTurnBudget: 20,
      continuationRevision: 1,
      auditHistory: [],
      updatedAt: new Date(now).toISOString(),
    });
    const loadedAcct = await store.readAccounting("agent/with:unsafe..chars");
    expect(loadedAcct!.consecutiveAutonomousTurns).toBe(3);

    // Tamper internal agentId inside hashed accounting file -> rejected on read & reported as corrupt!
    const acctPath = store.accountingPath("agent/with:unsafe..chars");
    const tampered = JSON.parse(await fs.readFile(acctPath, "utf8"));
    tampered.agentId = "different-agent";
    await fs.writeFile(acctPath, JSON.stringify(tampered), "utf8");
    await expect(store.readAccounting("agent/with:unsafe..chars")).rejects.toThrow(
      /agentId mismatch/,
    );
    const listed = await store.listAccounting();
    expect(listed.corrupt).toHaveLength(1);

    // Fault injection during atomic rename leaves previous committed file intact!
    let failNextRename = false;
    const faultStore = new ManagedContinuationStore(tmpDir, {
      beforeAtomicRename: () => {
        if (failNextRename) throw new Error("SIMULATED_POWER_LOSS");
      },
    });
    const fenceId = computeFenceId({ daemonInstanceId: "d1", runToken: "r1" });
    await faultStore.writeFence({
      fenceId,
      origin: { daemonInstanceId: "d1", runToken: "r1" },
      state: "pending",
      createdAt: new Date(now).toISOString(),
    });
    failNextRename = true;
    await expect(
      faultStore.writeFence({
        fenceId,
        origin: { daemonInstanceId: "d1", runToken: "r1" },
        state: "settled",
        createdAt: new Date(now).toISOString(),
        settledAt: new Date(now + 1000).toISOString(),
      }),
    ).rejects.toThrow("SIMULATED_POWER_LOSS");
    failNextRename = false;
    expect((await faultStore.readFence(fenceId))!.state).toBe("pending");
  });

  it("persists autonomous turn budget across daemon restarts and enforces reference-closure GC with thin tombstones", async () => {
    const store = new ManagedContinuationStore(tmpDir);
    const ledger1 = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-1",
      clock,
      defaultAutonomousTurnBudget: 1,
    });
    const origin: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "origin-budget" };

    await ledger1.registerTaskLease({
      leaseId: "lease_b1",
      taskId: "task_b1",
      agentId: "agent-budget",
      workspaceId: "ws-1",
      origin,
    });
    await ledger1.registerTaskLease({
      leaseId: "lease_b2",
      taskId: "task_b2",
      agentId: "agent-budget",
      workspaceId: "ws-1",
      origin,
    });
    await ledger1.settleOriginFence(origin);

    const ev1 = (await ledger1.recordTaskTerminalEvent({
      taskId: "task_b1",
      agentId: "agent-budget",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_b1/result.json",
    }))!;
    await ledger1.freezeBatch({
      batchId: "batch_b1",
      batchMessageId: "msg_b1",
      agentId: "agent-budget",
      eventIds: [ev1.eventId],
      serializedPrompt: "b1",
    });
    await ledger1.markBatchDispatching("batch_b1", "att_b1");
    await ledger1.reconcileDispatchOutcome("batch_b1", { status: "accepted" });
    const wake1: RunIdentity = { daemonInstanceId: "daemon-1", runToken: "wake-b1" };
    await ledger1.attachWakeRunToBatch("batch_b1", wake1);
    await ledger1.settleWakeTurn({
      agentId: "agent-budget",
      wakeRun: wake1,
      outcome: { kind: "completed" },
    });

    // Restart daemon -> budget count (1/1) MUST persist!
    const ledger2 = new ManagedContinuationLedger({
      store,
      daemonInstanceId: "daemon-2",
      clock,
      defaultAutonomousTurnBudget: 1,
    });
    const ev2 = (await ledger2.recordTaskTerminalEvent({
      taskId: "task_b2",
      agentId: "agent-budget",
      workspaceId: "ws-1",
      payloadRef: "tasks/task_b2/result.json",
    }))!;
    await expect(
      ledger2.freezeBatch({
        batchId: "batch_b2",
        batchMessageId: "msg_b2",
        agentId: "agent-budget",
        eventIds: [ev2.eventId],
        serializedPrompt: "b2",
      }),
    ).rejects.toThrow(AutonomousBudgetExceededError);
    expect((await store.readLease("lease_b2"))!.blockedReason).toBe("autonomous_budget_exceeded");

    // Advance 8 days -> run GC:
    // - lease_b1 + ev1 + batch_b1 are all settled & expired -> DELETED!
    // - lease_b2 is unresolved blocked -> RETAINED + Tombstone written, and shared Fence is NOT deleted!
    nowMs += 8 * 24 * 60 * 60 * 1000;
    const gc = await ledger2.runGarbageCollection();
    expect(gc.deletedLeases).toEqual(["lease_b1"]);
    expect(gc.deletedEvents).toEqual([ev1.eventId]);
    expect(gc.deletedBatches).toEqual(["batch_b1"]);
    expect(gc.retainedUnresolvedIds).toContain("lease_b2");
    expect(gc.tombstonesWritten.length).toBeGreaterThanOrEqual(1);
    // Fence is still referenced by surviving lease_b2 -> must NOT be deleted!
    expect(gc.deletedFences).toHaveLength(0);
    expect(await store.readFence(computeFenceId(origin))).not.toBeNull();
  });
});
