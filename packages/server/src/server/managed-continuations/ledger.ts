import { randomUUID } from "node:crypto";
import { ManagedContinuationStore } from "./atomic-store.js";
import {
  assertSafeServerId,
  assertUtf8ByteLimit,
  assertValidAgentId,
  assertValidLogicalEventId,
  computeFenceId,
  computePromptDigest,
  MAX_PROMPT_BYTES,
  resolveSendLaterSchedule,
  validatePayloadRef,
} from "./codec.js";
import {
  NON_REACTIVATABLE_BLOCK_REASONS,
  type AgentAccounting,
  type AgentContinuationSummary,
  type AuditEntry,
  type CancelWakeupResult,
  type ContinuationCheckpointEvent,
  type ContinuationLease,
  type ContinuationProjectionState,
  type DerivedTaskWakeState,
  type DispatchBatch,
  type DispatchReceiptOutcome,
  type GcReport,
  type LeaseBlockedReason,
  type OneShotWakeup,
  type OriginTurnFence,
  type RunIdentity,
  type SendLaterResult,
  type StartupReconcileReport,
  type WakeEvent,
  type WakeOrigin,
} from "./types.js";

export const DEFAULT_AUTONOMOUS_TURN_BUDGET = 20;
export const DEFAULT_GC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class OriginFencePendingError extends Error {
  readonly code = "ORIGIN_FENCE_PENDING";
}

export class ImmutableBatchError extends Error {
  readonly code = "IMMUTABLE_BATCH_VIOLATION";
}

export class CrossEpochOperationError extends Error {
  readonly code = "CROSS_EPOCH_OPERATION_FORBIDDEN";
}

export class FallbackForbiddenError extends Error {
  readonly code = "FALLBACK_FORBIDDEN_BY_POLICY_OR_STOP";
}

export class AutonomousBudgetExceededError extends Error {
  readonly code = "AUTONOMOUS_BUDGET_EXCEEDED";
}

export interface ManagedContinuationLedgerOptions {
  store: ManagedContinuationStore;
  daemonInstanceId: string;
  clock?: () => number;
  defaultAutonomousTurnBudget?: number;
  onCheckpoint?: (event: ContinuationCheckpointEvent) => void;
}

export type ReceiptProbe = (
  batch: DispatchBatch,
) => DispatchReceiptOutcome | Promise<DispatchReceiptOutcome>;

export type WakeTurnOutcome =
  | { kind: "completed" }
  | { kind: "user_stop" }
  | { kind: "provider_failure"; error?: string }
  | { kind: "human_unrelated_prompt" }
  | { kind: "authorization_revoked" }
  | { kind: "archived" };

const PENDING_LEASE_STATES = new Set<ContinuationLease["state"]>([
  "waiting_trigger",
  "pending_delivery",
  "dispatch_reserved",
  "resumed_running",
]);

const SETTLED_LEASE_STATES = new Set<ContinuationLease["state"]>([
  "settled",
  "covered",
  "canceled",
]);

export class ManagedContinuationLedger {
  readonly store: ManagedContinuationStore;
  readonly daemonInstanceId: string;
  private readonly clock: () => number;
  private readonly defaultBudget: number;
  private readonly onCheckpoint?: (event: ContinuationCheckpointEvent) => void;
  private readonly agentLanes = new Map<string, Promise<void>>();
  private readonly lastSummaryByAgent = new Map<string, AgentContinuationSummary>();

  constructor(options: ManagedContinuationLedgerOptions) {
    if (!options.daemonInstanceId) {
      throw new Error("daemonInstanceId is required");
    }
    this.store = options.store;
    this.daemonInstanceId = options.daemonInstanceId;
    this.clock = options.clock ?? (() => Date.now());
    this.defaultBudget = options.defaultAutonomousTurnBudget ?? DEFAULT_AUTONOMOUS_TURN_BUDGET;
    this.onCheckpoint = options.onCheckpoint;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private withAgentLane<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    assertValidAgentId(agentId);
    const previous = this.agentLanes.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.agentLanes.set(agentId, tail);
    void tail.finally(() => {
      if (this.agentLanes.get(agentId) === tail) {
        this.agentLanes.delete(agentId);
      }
    });
    return run;
  }

  // =========================================================================
  // OriginTurnFence — Single Authoritative Store (fences/<fenceId>.json)
  // =========================================================================

  async getOrCreateOriginFence(origin: RunIdentity): Promise<OriginTurnFence> {
    const fenceId = computeFenceId(origin);
    const existing = await this.store.readFence(fenceId);
    if (existing) {
      return existing;
    }
    const fence: OriginTurnFence = {
      fenceId,
      origin,
      state: "pending",
      createdAt: this.nowIso(),
    };
    await this.store.writeFence(fence);
    return fence;
  }

  async settleOriginFence(origin: RunIdentity): Promise<OriginTurnFence> {
    if (origin.daemonInstanceId !== this.daemonInstanceId) {
      throw new CrossEpochOperationError(
        `Cannot mark cross-epoch fence as settled (fence daemon=${origin.daemonInstanceId}, current=${this.daemonInstanceId})`,
      );
    }
    const fenceId = computeFenceId(origin);
    const existing = await this.store.readFence(fenceId);
    if (!existing) {
      throw new Error(`OriginTurnFence not found: ${fenceId}`);
    }
    if (existing.state === "settled") return existing;
    if (existing.state === "aborted_by_restart") {
      throw new CrossEpochOperationError(`Fence ${fenceId} was already aborted_by_restart`);
    }
    const updated: OriginTurnFence = {
      ...existing,
      state: "settled",
      settledAt: this.nowIso(),
    };
    await this.store.writeFence(updated);
    return updated;
  }

  async resolveFenceForLease(lease: ContinuationLease): Promise<OriginTurnFence | null> {
    return this.store.readFence(lease.creatorFenceId);
  }

  // =========================================================================
  // Task ContinuationLease Registration (notifyOnExit: false => NO Lease)
  // =========================================================================

  async registerTaskLease(input: {
    leaseId: string;
    taskId: string;
    agentId: string;
    workspaceId: string;
    origin: RunIdentity;
    notifyOnExit?: boolean;
  }): Promise<ContinuationLease | null> {
    assertSafeServerId(input.taskId, "taskId");
    assertValidAgentId(input.agentId);

    // Invariant #5: notifyOnExit: false MUST NOT create a ContinuationLease.
    if (input.notifyOnExit === false) {
      return null;
    }
    assertSafeServerId(input.leaseId, "leaseId");

    return this.withAgentLane(input.agentId, async () => {
      const fence = await this.getOrCreateOriginFence(input.origin);
      const existing = await this.store.readLease(input.leaseId);
      if (existing) {
        return existing;
      }
      const now = this.nowIso();
      const lease: ContinuationLease = {
        leaseId: input.leaseId,
        continuationId: input.taskId,
        kind: "managed-command",
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        creatorFenceId: fence.fenceId,
        state: "waiting_trigger",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeLease(lease);
      await this.evaluateAndEmitCheckpoint(input.agentId, "lease_created");
      return lease;
    });
  }

  /**
   * Records a durable WakeEvent for a task terminal state (idempotent by logical `eventId`).
   * Transitions the task's Lease to `pending_delivery` and puts any armed fallback into
   * `suspended_by_primary` (provisional cover — NOT `covered`!).
   */
  async recordTaskTerminalEvent(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    payloadRef: string;
  }): Promise<WakeEvent | null> {
    assertSafeServerId(input.taskId, "taskId");
    assertValidAgentId(input.agentId);
    const safePayloadRef = validatePayloadRef(this.store.baseDir, input.payloadRef);

    return this.withAgentLane(input.agentId, async () => {
      const leases = (await this.store.listLeases()).records;
      const taskLease = leases.find(
        (l) =>
          l.agentId === input.agentId &&
          l.kind === "managed-command" &&
          l.continuationId === input.taskId,
      );
      // notifyOnExit: false tasks have no Lease and produce no automatic WakeEvent.
      if (!taskLease) {
        return null;
      }
      if (taskLease.state === "canceled") {
        return null;
      }

      const eventId = `task:${input.taskId}:terminal`;
      assertValidLogicalEventId(eventId);
      const existing = await this.store.readEvent(eventId);
      if (existing) {
        return existing;
      }

      const now = this.nowIso();
      const event: WakeEvent = {
        eventId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        origin: "managed-command",
        payloadRef: safePayloadRef,
        createdAt: now,
        updatedAt: now,
        state: "pending",
        attempts: 0,
        sourceTaskId: input.taskId,
      };
      await this.store.writeEvent(event);

      if (taskLease.state === "waiting_trigger") {
        await this.store.writeLease({
          ...taskLease,
          state: "pending_delivery",
          eventId,
          updatedAt: now,
        });
      }

      // Provisionally suspend any armed fallback for this task (never eager-cover yet!).
      const wakeups = (await this.store.listWakeups()).records;
      for (const w of wakeups) {
        if (
          w.agentId === input.agentId &&
          w.fallbackForTaskId === input.taskId &&
          w.state === "scheduled" &&
          w.coverageState === "armed"
        ) {
          await this.store.writeWakeup({
            ...w,
            primaryEventId: eventId,
            coverageState: "suspended_by_primary",
            updatedAt: now,
          });
        }
      }

      await this.evaluateAndEmitCheckpoint(input.agentId, "task_terminal_event_enqueued");
      return event;
    });
  }

  // =========================================================================
  // One-Shot `send_later` & Two-Phase Fallback Coverage & Exact Cancel
  // =========================================================================

  private async resolveFallbackCoverageLocked(
    agentId: string,
    fallbackForTaskId: string,
  ): Promise<
    | { kind: "skip"; coveredByEventId: string }
    | {
        kind: "schedule";
        coverageState: OneShotWakeup["coverageState"];
        primaryEventId?: string;
      }
  > {
    const leases = (await this.store.listLeases()).records;
    const primaryLease = leases.find(
      (l) =>
        l.agentId === agentId &&
        l.kind === "managed-command" &&
        l.continuationId === fallbackForTaskId,
    );
    if (!primaryLease) {
      return { kind: "schedule", coverageState: "armed" };
    }
    const isNonReactivatable =
      primaryLease.state === "canceled" ||
      (primaryLease.state === "blocked" &&
        Boolean(primaryLease.blockedReason) &&
        NON_REACTIVATABLE_BLOCK_REASONS.has(primaryLease.blockedReason!));
    if (isNonReactivatable) {
      throw new FallbackForbiddenError(
        `Cannot schedule fallback for task ${fallbackForTaskId}: primary state=${primaryLease.state} (${primaryLease.blockedReason ?? "canceled"})`,
      );
    }
    if (primaryLease.state === "settled" && primaryLease.eventId) {
      return { kind: "skip", coveredByEventId: primaryLease.eventId };
    }
    if (!primaryLease.eventId) {
      return { kind: "schedule", coverageState: "armed" };
    }
    const primaryEvent = await this.store.readEvent(primaryLease.eventId);
    if (!primaryEvent) {
      return { kind: "schedule", coverageState: "armed" };
    }
    if (isHealthyInFlightEventState(primaryEvent.state)) {
      return {
        kind: "schedule",
        coverageState: "suspended_by_primary",
        primaryEventId: primaryEvent.eventId,
      };
    }
    if (primaryEvent.state === "uncertain" || primaryEvent.state === "blocked") {
      return {
        kind: "schedule",
        coverageState: "reactivated",
        primaryEventId: primaryEvent.eventId,
      };
    }
    return { kind: "schedule", coverageState: "armed" };
  }

  async scheduleOneShot(input: {
    wakeId: string;
    leaseId: string;
    agentId: string;
    workspaceId: string;
    origin: RunIdentity;
    prompt: string;
    name?: string;
    afterSeconds?: number;
    afterMinutes?: number;
    at?: string;
    fallbackForTaskId?: string;
  }): Promise<SendLaterResult> {
    assertSafeServerId(input.wakeId, "wakeId");
    assertSafeServerId(input.leaseId, "leaseId");
    assertValidAgentId(input.agentId);
    assertUtf8ByteLimit(input.prompt, MAX_PROMPT_BYTES, "send_later.prompt");
    if (input.fallbackForTaskId !== undefined) {
      assertSafeServerId(input.fallbackForTaskId, "fallbackForTaskId");
    }

    const nowMs = this.clock();
    const schedule = resolveSendLaterSchedule(
      {
        afterSeconds: input.afterSeconds,
        afterMinutes: input.afterMinutes,
        at: input.at,
      },
      nowMs,
    );

    return this.withAgentLane(input.agentId, async () => {
      const now = new Date(nowMs).toISOString();
      let coverageState: OneShotWakeup["coverageState"];
      let primaryEventId: string | undefined;

      if (input.fallbackForTaskId) {
        const decision = await this.resolveFallbackCoverageLocked(
          input.agentId,
          input.fallbackForTaskId,
        );
        if (decision.kind === "skip") {
          return {
            status: "skipped_covered_by_task_event",
            coveredByEventId: decision.coveredByEventId,
          };
        }
        coverageState = decision.coverageState;
        primaryEventId = decision.primaryEventId;
      }

      const fence = await this.getOrCreateOriginFence(input.origin);
      const lease: ContinuationLease = {
        leaseId: input.leaseId,
        continuationId: input.wakeId,
        kind: "one-shot",
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        creatorFenceId: fence.fenceId,
        state: "waiting_trigger",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeLease(lease);

      const wakeup: OneShotWakeup = {
        wakeId: input.wakeId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        name: input.name,
        prompt: input.prompt,
        scheduledAt: now,
        dueAt: schedule.dueAt,
        state: "scheduled",
        fallbackForTaskId: input.fallbackForTaskId,
        primaryEventId,
        coverageState,
        leaseId: lease.leaseId,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeWakeup(wakeup);
      await this.evaluateAndEmitCheckpoint(input.agentId, "one_shot_scheduled");

      return {
        status: "scheduled",
        wakeId: wakeup.wakeId,
        scheduledAt: wakeup.scheduledAt,
        dueAt: wakeup.dueAt,
        ...(schedule.clamped ? { clamped: true } : {}),
      };
    });
  }

  private async cancelWakeupEventIfPresentLocked(
    wakeId: string,
    eventId: string | undefined,
  ): Promise<CancelWakeupResult | null> {
    if (!eventId) return null;
    const event = await this.store.readEvent(eventId);
    if (!event) return null;
    if (event.state === "accepted") {
      return { canceled: false, wakeId, reason: "already_accepted" };
    }
    if (event.state === "uncertain" || event.state === "dispatching") {
      return { canceled: false, wakeId, reason: "dispatch_uncertain" };
    }
    if (event.state === "canceled" || event.state === "blocked") {
      return { canceled: false, wakeId, reason: "already_settled" };
    }
    await this.store.writeEvent({
      ...event,
      state: "canceled",
      updatedAt: this.nowIso(),
    });
    return null;
  }

  /**
   * Exact one-shot cancellation semantics (Spec v0.4.1 §6.2 & Guardrail #3):
   * - `suspended_by_primary` IS cancelable (releases fallback Lease, emits checkpoint, never cancels primary Task).
   * - `covered` returns `{ canceled: false, wakeId, reason: "already_covered" }`.
   * - `accepted` / `uncertain` return `"already_accepted"` / `"dispatch_uncertain"`.
   * - Other settled states return `"already_settled"`.
   */
  async cancelOneShot(wakeId: string): Promise<CancelWakeupResult> {
    assertSafeServerId(wakeId, "wakeId");
    const existing = await this.store.readWakeup(wakeId);
    if (!existing) {
      return { canceled: false, wakeId, reason: "not_found" };
    }

    return this.withAgentLane(existing.agentId, async () => {
      const wakeup = await this.store.readWakeup(wakeId);
      if (!wakeup) {
        return { canceled: false, wakeId, reason: "not_found" };
      }
      if (wakeup.state === "covered" || wakeup.coverageState === "covered") {
        return { canceled: false, wakeId, reason: "already_covered" };
      }
      if (wakeup.state === "canceled" || wakeup.state === "blocked") {
        return { canceled: false, wakeId, reason: "already_settled" };
      }

      const eventRejection = await this.cancelWakeupEventIfPresentLocked(wakeId, wakeup.eventId);
      if (eventRejection) return eventRejection;

      const now = this.nowIso();
      await this.store.writeWakeup({
        ...wakeup,
        state: "canceled",
        coverageState: wakeup.fallbackForTaskId ? "canceled" : wakeup.coverageState,
        terminalReason: "canceled_by_caller",
        updatedAt: now,
      });

      if (wakeup.leaseId) {
        const lease = await this.store.readLease(wakeup.leaseId);
        if (lease && !SETTLED_LEASE_STATES.has(lease.state)) {
          await this.store.writeLease({
            ...lease,
            state: "canceled",
            updatedAt: now,
          });
        }
      }

      await this.evaluateAndEmitCheckpoint(wakeup.agentId, "one_shot_canceled");
      return { canceled: true, wakeId };
    });
  }

  private async evaluateSuspendedFallbackLocked(
    wakeup: OneShotWakeup,
    now: string,
  ): Promise<WakeEvent | null> {
    const leases = (await this.store.listLeases()).records;
    const primaryLease = leases.find(
      (l) =>
        l.agentId === wakeup.agentId &&
        l.kind === "managed-command" &&
        l.continuationId === wakeup.fallbackForTaskId,
    );
    if (!primaryLease) return null;
    if (primaryLease.state === "settled") {
      await this.coverFallbackLocked(wakeup, now);
      return null;
    }
    const forbidReactivation =
      primaryLease.state === "canceled" ||
      (primaryLease.state === "blocked" &&
        Boolean(primaryLease.blockedReason) &&
        NON_REACTIVATABLE_BLOCK_REASONS.has(primaryLease.blockedReason!));
    if (forbidReactivation) {
      const targetState = primaryLease.state === "canceled" ? "canceled" : "blocked";
      const reason = primaryLease.blockedReason ?? "primary_canceled";
      await this.terminateFallbackLocked(wakeup, targetState, reason, now);
      return null;
    }
    if (primaryLease.state === "blocked") {
      return this.emitOneShotWakeEventLocked(
        { ...wakeup, coverageState: "reactivated" },
        "recovery-diagnostic",
        true,
        now,
      );
    }
    return null;
  }

  private async evaluateDueWakeupLocked(wakeId: string): Promise<WakeEvent | null> {
    const wakeup = await this.store.readWakeup(wakeId);
    if (!wakeup || wakeup.state !== "scheduled") return null;
    if (Date.parse(wakeup.dueAt) > this.clock()) return null;

    const now = this.nowIso();
    if (!wakeup.fallbackForTaskId) {
      return this.emitOneShotWakeEventLocked(wakeup, "one-shot", false, now);
    }
    const terminalCoverage =
      wakeup.coverageState === "covered" ||
      wakeup.coverageState === "canceled" ||
      wakeup.coverageState === "blocked";
    if (terminalCoverage) return null;
    if (wakeup.coverageState === "suspended_by_primary") {
      return this.evaluateSuspendedFallbackLocked(wakeup, now);
    }
    if (wakeup.coverageState === "reactivated") {
      return this.emitOneShotWakeEventLocked(wakeup, "recovery-diagnostic", true, now);
    }
    return this.emitOneShotWakeEventLocked(wakeup, "one-shot", false, now);
  }

  /**
   * Evaluates due one-shots at the current clock timestamp and writes durable WakeEvents.
   * Enforces Guardrail #1 (no reactivation after user stop / policy block) and read-only
   * `recovery-diagnostic` origin for reactivated fallbacks.
   */
  async processDueOneShots(): Promise<WakeEvent[]> {
    const nowMs = this.clock();
    const wakeups = (await this.store.listWakeups()).records;
    const emitted: WakeEvent[] = [];

    for (const candidate of wakeups) {
      if (candidate.state !== "scheduled") continue;
      if (Date.parse(candidate.dueAt) > nowMs) continue;

      const event = await this.withAgentLane(candidate.agentId, () =>
        this.evaluateDueWakeupLocked(candidate.wakeId),
      );
      if (event) {
        emitted.push(event);
      }
    }

    return emitted;
  }

  private async emitOneShotWakeEventLocked(
    wakeup: OneShotWakeup,
    origin: WakeOrigin,
    readOnlyDiagnostic: boolean,
    now: string,
  ): Promise<WakeEvent> {
    const eventId =
      origin === "recovery-diagnostic"
        ? `wakeup:${wakeup.wakeId}:diagnostic`
        : `wakeup:${wakeup.wakeId}:due`;
    const existing = await this.store.readEvent(eventId);
    if (existing) {
      return existing;
    }

    const event: WakeEvent = {
      eventId,
      agentId: wakeup.agentId,
      workspaceId: wakeup.workspaceId,
      origin,
      payloadRef: `wakeups/${wakeup.wakeId}.json`,
      createdAt: now,
      updatedAt: now,
      state: "pending",
      attempts: 0,
      readOnlyDiagnostic,
      sourceWakeId: wakeup.wakeId,
      sourceTaskId: wakeup.fallbackForTaskId,
    };
    await this.store.writeEvent(event);
    await this.store.writeWakeup({
      ...wakeup,
      state: "outbox",
      eventId,
      updatedAt: now,
    });

    if (wakeup.leaseId) {
      const lease = await this.store.readLease(wakeup.leaseId);
      if (lease && lease.state === "waiting_trigger") {
        await this.store.writeLease({
          ...lease,
          state: "pending_delivery",
          eventId,
          updatedAt: now,
        });
      }
    }

    await this.evaluateAndEmitCheckpoint(wakeup.agentId, "one_shot_due_enqueued");
    return event;
  }

  // =========================================================================
  // Immutable DispatchBatch & Fence Gate & Reconciliation
  // =========================================================================

  private verifyFrozenBatchUnchanged(
    existing: DispatchBatch,
    uniqueEventIds: readonly string[],
    batchMessageId: string,
    promptDigest: string,
  ): DispatchBatch {
    const sameEvents =
      existing.eventIds.length === uniqueEventIds.length &&
      existing.eventIds.every((id, idx) => id === uniqueEventIds[idx]);
    if (
      !sameEvents ||
      existing.batchMessageId !== batchMessageId ||
      existing.promptDigest !== promptDigest
    ) {
      throw new ImmutableBatchError(
        `Frozen batch ${existing.batchId} is immutable; cannot alter eventIds, batchMessageId, or promptDigest`,
      );
    }
    return existing;
  }

  private async collectBatchEventsAndLeasesLocked(
    agentId: string,
    batchId: string,
    uniqueEventIds: readonly string[],
  ): Promise<{ events: WakeEvent[]; linkedLeases: ContinuationLease[] }> {
    const events: WakeEvent[] = [];
    const allLeases = (await this.store.listLeases()).records;
    const linkedLeases: ContinuationLease[] = [];

    for (const eventId of uniqueEventIds) {
      const event = await this.store.readEvent(eventId);
      if (!event) throw new Error(`WakeEvent not found for batch freeze: ${eventId}`);
      if (event.agentId !== agentId) {
        throw new Error(`WakeEvent ${eventId} does not belong to agent ${agentId}`);
      }
      if (event.state !== "pending") {
        throw new ImmutableBatchError(
          `WakeEvent ${eventId} is in state ${event.state} and cannot be added to batch ${batchId}`,
        );
      }
      events.push(event);

      const lease = allLeases.find((l) => l.agentId === agentId && l.eventId === event.eventId);
      if (!lease) continue;
      const fence = await this.store.readFence(lease.creatorFenceId);
      if (!fence || fence.state === "pending") {
        throw new OriginFencePendingError(
          `OriginTurnFence ${lease.creatorFenceId} is still pending; cannot freeze/dispatch batch before creator turn settles`,
        );
      }
      linkedLeases.push(lease);
    }
    return { events, linkedLeases };
  }

  async freezeBatch(input: {
    batchId: string;
    batchMessageId: string;
    agentId: string;
    eventIds: readonly string[];
    serializedPrompt: string;
  }): Promise<DispatchBatch> {
    assertSafeServerId(input.batchId, "batchId");
    assertSafeServerId(input.batchMessageId, "batchMessageId");
    assertValidAgentId(input.agentId);
    if (input.eventIds.length === 0) {
      throw new Error("DispatchBatch requires at least one eventId");
    }

    const uniqueEventIds = Array.from(new Set(input.eventIds));
    const promptDigest = computePromptDigest(input.serializedPrompt);

    return this.withAgentLane(input.agentId, async () => {
      const existing = await this.store.readBatch(input.batchId);
      if (existing) {
        return this.verifyFrozenBatchUnchanged(
          existing,
          uniqueEventIds,
          input.batchMessageId,
          promptDigest,
        );
      }

      // Validate autonomous turn budget before freezing.
      const accounting = await this.getOrCreateAccountingLocked(input.agentId);
      if (accounting.consecutiveAutonomousTurns >= accounting.autonomousTurnBudget) {
        await this.blockAgentForBudgetLocked(input.agentId, uniqueEventIds);
        throw new AutonomousBudgetExceededError(
          `Agent ${input.agentId} reached autonomous turn budget (${accounting.consecutiveAutonomousTurns}/${accounting.autonomousTurnBudget})`,
        );
      }

      const { events, linkedLeases } = await this.collectBatchEventsAndLeasesLocked(
        input.agentId,
        input.batchId,
        uniqueEventIds,
      );

      const now = this.nowIso();
      const batch: DispatchBatch = {
        batchId: input.batchId,
        batchMessageId: input.batchMessageId,
        agentId: input.agentId,
        eventIds: uniqueEventIds,
        promptDigest,
        state: "frozen",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeBatch(batch);

      for (const event of events) {
        await this.store.writeEvent({
          ...event,
          state: "batched",
          batchId: batch.batchId,
          updatedAt: now,
        });
      }
      for (const lease of linkedLeases) {
        await this.store.writeLease({
          ...lease,
          state: "dispatch_reserved",
          dispatchBatchId: batch.batchId,
          updatedAt: now,
        });
      }

      await this.evaluateAndEmitCheckpoint(input.agentId, "batch_frozen");
      return batch;
    });
  }

  async markBatchDispatching(batchId: string, dispatchAttemptId: string): Promise<DispatchBatch> {
    assertSafeServerId(batchId, "batchId");
    assertSafeServerId(dispatchAttemptId, "dispatchAttemptId");
    const existing = await this.store.readBatch(batchId);
    if (!existing) throw new Error(`DispatchBatch not found: ${batchId}`);

    return this.withAgentLane(existing.agentId, async () => {
      const batch = await this.store.readBatch(batchId);
      if (!batch) throw new Error(`DispatchBatch not found: ${batchId}`);
      if (batch.state !== "frozen") {
        throw new Error(`Cannot start dispatching batch ${batchId} from state ${batch.state}`);
      }
      const now = this.nowIso();
      const updated: DispatchBatch = {
        ...batch,
        state: "dispatching",
        dispatchDaemonInstanceId: this.daemonInstanceId,
        dispatchAttemptId,
        updatedAt: now,
      };
      await this.store.writeBatch(updated);
      for (const eventId of batch.eventIds) {
        const ev = await this.store.readEvent(eventId);
        if (ev) {
          await this.store.writeEvent({
            ...ev,
            state: "dispatching",
            attempts: ev.attempts + 1,
            updatedAt: now,
          });
        }
      }
      return updated;
    });
  }

  async reconcileDispatchOutcome(
    batchId: string,
    outcome: DispatchReceiptOutcome,
  ): Promise<DispatchBatch> {
    assertSafeServerId(batchId, "batchId");
    const existing = await this.store.readBatch(batchId);
    if (!existing) throw new Error(`DispatchBatch not found: ${batchId}`);

    return this.withAgentLane(existing.agentId, async () => {
      const batch = await this.store.readBatch(batchId);
      if (!batch) throw new Error(`DispatchBatch not found: ${batchId}`);
      return this.applyDispatchOutcomeLocked(batch, outcome);
    });
  }

  private async applyDispatchOutcomeLocked(
    batch: DispatchBatch,
    outcome: DispatchReceiptOutcome,
  ): Promise<DispatchBatch> {
    const now = this.nowIso();
    const leases = (await this.store.listLeases()).records.filter(
      (l) => l.agentId === batch.agentId && l.dispatchBatchId === batch.batchId,
    );

    if (outcome.status === "not_submitted") {
      // Confirmed NOT submitted to provider -> safe to retry the EXACT same immutable batch.
      const updated: DispatchBatch = {
        ...batch,
        state: "frozen",
        dispatchDaemonInstanceId: undefined,
        dispatchAttemptId: undefined,
        updatedAt: now,
      };
      await this.store.writeBatch(updated);
      for (const eventId of batch.eventIds) {
        const ev = await this.store.readEvent(eventId);
        if (ev) {
          await this.store.writeEvent({ ...ev, state: "batched", updatedAt: now });
        }
      }
      for (const lease of leases) {
        if (lease.state === "dispatch_reserved") {
          await this.store.writeLease({ ...lease, state: "pending_delivery", updatedAt: now });
        }
      }
      await this.evaluateAndEmitCheckpoint(batch.agentId, "batch_retryable");
      return updated;
    }

    if (outcome.status === "accepted") {
      // Provider accepted the message — does NOT settle Leases!
      const updated: DispatchBatch = {
        ...batch,
        state: "accepted",
        providerReceiptId: outcome.providerReceiptId ?? batch.providerReceiptId,
        updatedAt: now,
      };
      await this.store.writeBatch(updated);
      for (const eventId of batch.eventIds) {
        const ev = await this.store.readEvent(eventId);
        if (ev) {
          await this.store.writeEvent({ ...ev, state: "accepted", updatedAt: now });
        }
      }
      await this.evaluateAndEmitCheckpoint(batch.agentId, "batch_accepted");
      return updated;
    }

    // Uncertain: NEVER auto-replay! Block leases with dispatch_uncertain.
    const updated: DispatchBatch = {
      ...batch,
      state: "uncertain",
      updatedAt: now,
    };
    await this.store.writeBatch(updated);
    for (const eventId of batch.eventIds) {
      const ev = await this.store.readEvent(eventId);
      if (ev) {
        await this.store.writeEvent({
          ...ev,
          state: "uncertain",
          lastError: outcome.detail ?? "dispatch_uncertain",
          updatedAt: now,
        });
      }
    }
    for (const lease of leases) {
      await this.store.writeLease({
        ...lease,
        state: "blocked",
        blockedReason: "dispatch_uncertain",
        updatedAt: now,
      });
    }
    await this.appendAuditEntryLocked(batch.agentId, {
      kind: "blocked",
      reason: "dispatch_uncertain",
      batchId: batch.batchId,
    });
    await this.evaluateAndEmitCheckpoint(batch.agentId, "batch_uncertain");
    return updated;
  }

  /**
   * Binds all Leases belonging to an accepted batch to a single Wake Turn `RunIdentity`
   * and increments the persistent `consecutiveAutonomousTurns` budget counter.
   */
  async attachWakeRunToBatch(batchId: string, wakeRun: RunIdentity): Promise<ContinuationLease[]> {
    assertSafeServerId(batchId, "batchId");
    if (wakeRun.daemonInstanceId !== this.daemonInstanceId) {
      throw new CrossEpochOperationError("Cannot attach a cross-epoch wakeRun");
    }
    const existing = await this.store.readBatch(batchId);
    if (!existing) throw new Error(`DispatchBatch not found: ${batchId}`);

    return this.withAgentLane(existing.agentId, async () => {
      const batch = await this.store.readBatch(batchId);
      if (!batch) throw new Error(`DispatchBatch not found: ${batchId}`);
      if (batch.state !== "accepted") {
        throw new Error(
          `Batch ${batchId} must be accepted before attaching wakeRun (is ${batch.state})`,
        );
      }

      const accounting = await this.getOrCreateAccountingLocked(batch.agentId);
      if (accounting.consecutiveAutonomousTurns >= accounting.autonomousTurnBudget) {
        await this.blockAgentForBudgetLocked(batch.agentId, batch.eventIds);
        throw new AutonomousBudgetExceededError(
          `Agent ${batch.agentId} exceeded autonomous turn budget`,
        );
      }
      await this.store.writeAccounting({
        ...accounting,
        consecutiveAutonomousTurns: accounting.consecutiveAutonomousTurns + 1,
        updatedAt: this.nowIso(),
      });

      const now = this.nowIso();
      const leases = (await this.store.listLeases()).records.filter(
        (l) => l.agentId === batch.agentId && l.dispatchBatchId === batch.batchId,
      );
      const updated: ContinuationLease[] = [];
      for (const lease of leases) {
        const next: ContinuationLease = {
          ...lease,
          state: "resumed_running",
          wakeRun,
          updatedAt: now,
        };
        await this.store.writeLease(next);
        updated.push(next);
      }
      await this.evaluateAndEmitCheckpoint(batch.agentId, "wake_run_started");
      return updated;
    });
  }

  // =========================================================================
  // Wake Turn Settlement, User Stop Guardrail & Explicit Human Takeover
  // =========================================================================

  private async eagerCoverFallbacksForTaskLocked(
    agentId: string,
    taskId: string,
    allWakeups: readonly OneShotWakeup[],
    now: string,
  ): Promise<string[]> {
    const covered: string[] = [];
    for (const w of allWakeups) {
      const eligible =
        w.agentId === agentId &&
        w.fallbackForTaskId === taskId &&
        w.state === "scheduled" &&
        (w.coverageState === "armed" || w.coverageState === "suspended_by_primary");
      if (!eligible) continue;
      await this.coverFallbackLocked(w, now);
      covered.push(w.wakeId);
    }
    return covered;
  }

  private async settleCompletedWakeTurnLocked(
    agentId: string,
    boundLeases: readonly ContinuationLease[],
    allWakeups: readonly OneShotWakeup[],
    now: string,
  ): Promise<{
    settledLeaseIds: string[];
    coveredWakeIds: string[];
    reactivatedWakeIds: string[];
  }> {
    const settledLeaseIds: string[] = [];
    const coveredWakeIds: string[] = [];
    let hadHumanTakeover = false;

    for (const lease of boundLeases) {
      if (lease.takeoverByHuman) hadHumanTakeover = true;
      await this.store.writeLease({
        ...lease,
        state: "settled",
        blockedReason: undefined,
        updatedAt: now,
      });
      settledLeaseIds.push(lease.leaseId);
      if (lease.kind === "managed-command") {
        const covered = await this.eagerCoverFallbacksForTaskLocked(
          agentId,
          lease.continuationId,
          allWakeups,
          now,
        );
        coveredWakeIds.push(...covered);
      }
    }

    if (hadHumanTakeover) {
      await this.appendAuditEntryLocked(agentId, {
        kind: "takeover_settled",
        reason: "explicit_human_takeover_completed",
      });
    }

    const summary = await this.evaluateAndEmitCheckpoint(agentId, "wake_turn_completed");
    if (hadHumanTakeover && summary.continuationState !== "needs_attention") {
      await this.appendAuditEntryLocked(agentId, {
        kind: "needs_attention_cleared",
        reason: "no_remaining_blockers_after_takeover",
      });
    }
    return { settledLeaseIds, coveredWakeIds, reactivatedWakeIds: [] };
  }

  private async updateFallbacksOnNonCompletedTurnLocked(
    agentId: string,
    taskId: string,
    allWakeups: readonly OneShotWakeup[],
    outcomeKind: Exclude<WakeTurnOutcome["kind"], "completed">,
    blockReason: LeaseBlockedReason,
    now: string,
  ): Promise<string[]> {
    const isArchived = outcomeKind === "archived";
    const forbidReactivation = isArchived || NON_REACTIVATABLE_BLOCK_REASONS.has(blockReason);
    const reactivated: string[] = [];

    for (const w of allWakeups) {
      const eligible =
        w.agentId === agentId &&
        w.fallbackForTaskId === taskId &&
        w.state === "scheduled" &&
        (w.coverageState === "armed" || w.coverageState === "suspended_by_primary");
      if (!eligible) continue;

      if (forbidReactivation) {
        const targetState = outcomeKind === "user_stop" || isArchived ? "canceled" : "blocked";
        const reason = isArchived ? "archived" : blockReason;
        await this.terminateFallbackLocked(w, targetState, reason, now);
        continue;
      }
      if (outcomeKind === "provider_failure") {
        await this.store.writeWakeup({
          ...w,
          coverageState: "reactivated",
          updatedAt: now,
        });
        reactivated.push(w.wakeId);
      }
    }
    return reactivated;
  }

  async settleWakeTurn(input: {
    agentId: string;
    wakeRun: RunIdentity;
    outcome: WakeTurnOutcome;
  }): Promise<{
    settledLeaseIds: string[];
    coveredWakeIds: string[];
    reactivatedWakeIds: string[];
  }> {
    assertValidAgentId(input.agentId);

    return this.withAgentLane(input.agentId, async () => {
      if (
        input.outcome.kind === "completed" &&
        input.wakeRun.daemonInstanceId !== this.daemonInstanceId
      ) {
        throw new CrossEpochOperationError(
          "Cannot settle a Wake Turn from a previous daemonInstanceId as completed",
        );
      }

      const now = this.nowIso();
      const allLeases = (await this.store.listLeases()).records;
      const boundLeases = allLeases.filter(
        (l) =>
          l.agentId === input.agentId &&
          l.state === "resumed_running" &&
          l.wakeRun?.daemonInstanceId === input.wakeRun.daemonInstanceId &&
          l.wakeRun?.runToken === input.wakeRun.runToken,
      );

      const allWakeups = (await this.store.listWakeups()).records;
      if (input.outcome.kind === "completed") {
        return this.settleCompletedWakeTurnLocked(input.agentId, boundLeases, allWakeups, now);
      }

      const blockReason = resolveBlockReasonForOutcome(input.outcome.kind);
      const auditKind = resolveAuditKindForOutcome(input.outcome.kind);
      const isArchived = input.outcome.kind === "archived";
      const reactivatedWakeIds: string[] = [];

      for (const lease of boundLeases) {
        await this.store.writeLease({
          ...lease,
          state: isArchived ? "canceled" : "blocked",
          blockedReason: isArchived ? undefined : blockReason,
          wakeRun: undefined,
          updatedAt: now,
        });
        await this.appendAuditEntryLocked(input.agentId, {
          kind: auditKind,
          reason: isArchived ? "archived" : blockReason,
          leaseId: lease.leaseId,
        });
        if (lease.kind === "managed-command") {
          const reactivated = await this.updateFallbacksOnNonCompletedTurnLocked(
            input.agentId,
            lease.continuationId,
            allWakeups,
            input.outcome.kind,
            blockReason,
            now,
          );
          reactivatedWakeIds.push(...reactivated);
        }
      }

      await this.evaluateAndEmitCheckpoint(input.agentId, `wake_turn_${input.outcome.kind}`);
      return { settledLeaseIds: [], coveredWakeIds: [], reactivatedWakeIds };
    });
  }

  async explicitHumanTakeover(input: {
    agentId: string;
    leaseIds: readonly string[];
    newRun: RunIdentity;
    resetCredential: string;
  }): Promise<ContinuationLease[]> {
    assertValidAgentId(input.agentId);
    if (input.newRun.daemonInstanceId !== this.daemonInstanceId) {
      throw new CrossEpochOperationError("Takeover run must belong to current daemonInstanceId");
    }

    return this.withAgentLane(input.agentId, async () => {
      await this.recordHumanBudgetResetLocked(input.agentId, input.resetCredential);
      const now = this.nowIso();
      const rebound: ContinuationLease[] = [];
      for (const leaseId of input.leaseIds) {
        const lease = await this.store.readLease(leaseId);
        if (!lease || lease.agentId !== input.agentId) {
          throw new Error(`Lease not found for takeover: ${leaseId}`);
        }
        if (lease.state !== "blocked") {
          throw new Error(`Lease ${leaseId} is not blocked (state=${lease.state})`);
        }
        const next: ContinuationLease = {
          ...lease,
          state: "resumed_running",
          wakeRun: input.newRun,
          blockedReason: undefined,
          takeoverByHuman: true,
          updatedAt: now,
        };
        await this.store.writeLease(next);
        await this.appendAuditEntryLocked(input.agentId, {
          kind: "takeover_started",
          leaseId,
        });
        rebound.push(next);
      }
      await this.evaluateAndEmitCheckpoint(input.agentId, "human_takeover_started");
      return rebound;
    });
  }

  async recordHumanBudgetReset(agentId: string, credential: string): Promise<AgentAccounting> {
    assertValidAgentId(agentId);
    return this.withAgentLane(agentId, () =>
      this.recordHumanBudgetResetLocked(agentId, credential),
    );
  }

  private async recordHumanBudgetResetLocked(
    agentId: string,
    credential: string,
  ): Promise<AgentAccounting> {
    const accounting = await this.getOrCreateAccountingLocked(agentId);
    const now = this.nowIso();
    const updated: AgentAccounting = {
      ...accounting,
      consecutiveAutonomousTurns: 0,
      lastHumanResetAt: now,
      lastResetCredential: credential,
      updatedAt: now,
    };
    await this.store.writeAccounting(updated);
    return updated;
  }

  // =========================================================================
  // Startup Reconcile (Spec §4.6 & Appendix B)
  // =========================================================================

  private async reconcileSingleBatchOnStartup(
    batch: DispatchBatch,
    receiptProbe: ReceiptProbe,
    now: string,
  ): Promise<{
    category: "retried" | "accepted" | "uncertain";
    blockedLeaseIds: string[];
  }> {
    const outcome = await receiptProbe(batch);
    const blockedLeaseIds: string[] = [];

    await this.withAgentLane(batch.agentId, async () => {
      const current = await this.store.readBatch(batch.batchId);
      if (!current) return;
      await this.applyDispatchOutcomeLocked(current, outcome);

      if (outcome.status !== "accepted") return;
      const leases = (await this.store.listLeases()).records.filter(
        (l) =>
          l.agentId === batch.agentId &&
          l.dispatchBatchId === batch.batchId &&
          l.state === "dispatch_reserved",
      );
      for (const l of leases) {
        await this.store.writeLease({
          ...l,
          state: "blocked",
          blockedReason: "wake_turn_aborted_by_daemon_restart",
          updatedAt: now,
        });
        blockedLeaseIds.push(l.leaseId);
      }
    });

    if (outcome.status === "not_submitted") return { category: "retried", blockedLeaseIds };
    if (outcome.status === "accepted") return { category: "accepted", blockedLeaseIds };
    return { category: "uncertain", blockedLeaseIds };
  }

  async reconcileStartup(input: {
    restartRecoveryBarrier: () => Promise<void>;
    receiptProbe: ReceiptProbe;
  }): Promise<StartupReconcileReport> {
    await this.store.ensureLayout();
    // Step 2 (§4.6): Always wait for restart-recovery barrier before touching cross-epoch fences!
    await input.restartRecoveryBarrier();

    const now = this.nowIso();
    const abortedFenceIds: string[] = [];
    const blockedLeaseIds: string[] = [];
    const retriedBatchIds: string[] = [];
    const acceptedBatchIds: string[] = [];
    const uncertainBatchIds: string[] = [];
    const affectedAgents = new Set<string>();

    const [fencesRes, leasesRes, eventsRes, batchesRes, wakeupsRes, accountingRes] =
      await Promise.all([
        this.store.listFences(),
        this.store.listLeases(),
        this.store.listEvents(),
        this.store.listBatches(),
        this.store.listWakeups(),
        this.store.listAccounting(),
      ]);

    const corruptRecords = [
      ...fencesRes.corrupt,
      ...leasesRes.corrupt,
      ...eventsRes.corrupt,
      ...batchesRes.corrupt,
      ...wakeupsRes.corrupt,
      ...accountingRes.corrupt,
    ];

    // 1. Mark cross-epoch pending fences as `aborted_by_restart` (NEVER fake `settled`).
    for (const fence of fencesRes.records) {
      if (fence.state !== "pending" || fence.origin.daemonInstanceId === this.daemonInstanceId) {
        continue;
      }
      await this.store.writeFence({
        ...fence,
        state: "aborted_by_restart",
        abortedAt: now,
      });
      abortedFenceIds.push(fence.fenceId);
    }

    // 2. Reconcile cross-epoch `resumed_running` leases (no verified turn completion => blocked).
    for (const lease of leasesRes.records) {
      if (
        lease.state === "resumed_running" &&
        lease.wakeRun &&
        lease.wakeRun.daemonInstanceId !== this.daemonInstanceId
      ) {
        await this.store.writeLease({
          ...lease,
          state: "blocked",
          blockedReason: "wake_turn_aborted_by_daemon_restart",
          wakeRun: undefined,
          updatedAt: now,
        });
        await this.appendAuditEntryLocked(lease.agentId, {
          kind: "restart_aborted",
          reason: "wake_turn_aborted_by_daemon_restart",
          leaseId: lease.leaseId,
        });
        blockedLeaseIds.push(lease.leaseId);
        affectedAgents.add(lease.agentId);
      }
    }

    // 3. Reconcile in-flight batches (`frozen` / `dispatching`) from previous epoch using receiptProbe.
    for (const batch of batchesRes.records) {
      if (batch.state !== "frozen" && batch.state !== "dispatching") continue;
      if (
        batch.dispatchDaemonInstanceId &&
        batch.dispatchDaemonInstanceId === this.daemonInstanceId
      ) {
        continue;
      }

      const res = await this.reconcileSingleBatchOnStartup(batch, input.receiptProbe, now);
      blockedLeaseIds.push(...res.blockedLeaseIds);
      if (res.category === "retried") retriedBatchIds.push(batch.batchId);
      else if (res.category === "accepted") acceptedBatchIds.push(batch.batchId);
      else uncertainBatchIds.push(batch.batchId);
      affectedAgents.add(batch.agentId);
    }

    const checkpointAgents: string[] = [];
    for (const agentId of affectedAgents) {
      await this.evaluateAndEmitCheckpoint(agentId, "startup_reconcile");
      checkpointAgents.push(agentId);
    }

    return {
      daemonInstanceId: this.daemonInstanceId,
      abortedFenceIds,
      blockedLeaseIds,
      retriedBatchIds,
      acceptedBatchIds,
      uncertainBatchIds,
      checkpointAgents,
      corruptRecords,
    };
  }

  // =========================================================================
  // Reference-Closure Garbage Collection (Spec §5.3 & §11.1.5)
  // =========================================================================

  private async deleteGcComponent(
    members: readonly string[],
    report: Pick<GcReport, "deletedLeases" | "deletedEvents" | "deletedBatches" | "deletedWakeups">,
  ): Promise<void> {
    for (const key of members) {
      const [kind, id] = splitComponentKey(key);
      if (kind === "lease") {
        await this.store.deleteLease(id);
        report.deletedLeases.push(id);
      } else if (kind === "event") {
        await this.store.deleteEvent(id);
        report.deletedEvents.push(id);
      } else if (kind === "batch") {
        await this.store.deleteBatch(id);
        report.deletedBatches.push(id);
      } else if (kind === "wakeup") {
        await this.store.deleteWakeup(id);
        report.deletedWakeups.push(id);
      }
    }
  }

  private async retainGcComponent(
    members: readonly string[],
    index: GcRecordIndex,
    cutoffMs: number,
    now: string,
    survivingLeaseFenceIds: Set<string>,
    retainedUnresolvedIds: string[],
    tombstonesWritten: string[],
  ): Promise<void> {
    for (const key of members) {
      const [kind, id] = splitComponentKey(key);
      if (kind === "lease") {
        const lease = index.leasesById.get(id)!;
        survivingLeaseFenceIds.add(lease.creatorFenceId);
        if (lease.state !== "blocked" || Date.parse(lease.updatedAt) > cutoffMs) continue;
        retainedUnresolvedIds.push(id);
        const tPath = await this.store.writeTombstone({
          kind: "lease",
          recordId: lease.leaseId,
          agentId: lease.agentId,
          state: lease.state,
          blockedReason: lease.blockedReason,
          retainedReason: "unresolved_blocked",
          originalUpdatedAt: lease.updatedAt,
          recordedAt: now,
        });
        tombstonesWritten.push(tPath);
      } else if (kind === "batch") {
        const batch = index.batchesById.get(id)!;
        const unresolved = batch.state === "uncertain" || batch.state === "blocked";
        if (!unresolved || Date.parse(batch.updatedAt) > cutoffMs) continue;
        retainedUnresolvedIds.push(id);
        const tPath = await this.store.writeTombstone({
          kind: "batch",
          recordId: batch.batchId,
          agentId: batch.agentId,
          state: batch.state,
          retainedReason:
            batch.state === "uncertain" ? "unresolved_uncertain" : "unresolved_blocked",
          originalUpdatedAt: batch.updatedAt,
          recordedAt: now,
        });
        tombstonesWritten.push(tPath);
      }
    }
  }

  async runGarbageCollection(options?: { retentionMs?: number }): Promise<GcReport> {
    const retentionMs = options?.retentionMs ?? DEFAULT_GC_RETENTION_MS;
    const cutoffMs = this.clock() - retentionMs;
    const now = this.nowIso();

    const [fencesRes, leasesRes, eventsRes, batchesRes, wakeupsRes] = await Promise.all([
      this.store.listFences(),
      this.store.listLeases(),
      this.store.listEvents(),
      this.store.listBatches(),
      this.store.listWakeups(),
    ]);

    const corruptRecords = [
      ...fencesRes.corrupt,
      ...leasesRes.corrupt,
      ...eventsRes.corrupt,
      ...batchesRes.corrupt,
      ...wakeupsRes.corrupt,
    ];

    const index: GcRecordIndex = {
      leasesById: new Map(leasesRes.records.map((l) => [l.leaseId, l])),
      eventsById: new Map(eventsRes.records.map((e) => [e.eventId, e])),
      batchesById: new Map(batchesRes.records.map((b) => [b.batchId, b])),
      wakeupsById: new Map(wakeupsRes.records.map((w) => [w.wakeId, w])),
    };
    const components = buildGcComponents(index);

    const deletedLeases: string[] = [];
    const deletedEvents: string[] = [];
    const deletedBatches: string[] = [];
    const deletedWakeups: string[] = [];
    const deletedFences: string[] = [];
    const retainedUnresolvedIds: string[] = [];
    const tombstonesWritten: string[] = [];

    const survivingLeaseFenceIds = new Set<string>();

    for (const members of components.values()) {
      if (isComponentEligibleForGc(members, index, cutoffMs)) {
        await this.deleteGcComponent(members, {
          deletedLeases,
          deletedEvents,
          deletedBatches,
          deletedWakeups,
        });
      } else {
        await this.retainGcComponent(
          members,
          index,
          cutoffMs,
          now,
          survivingLeaseFenceIds,
          retainedUnresolvedIds,
          tombstonesWritten,
        );
      }
    }

    // Never delete a Fence still referenced by any surviving Lease!
    for (const fence of fencesRes.records) {
      if (survivingLeaseFenceIds.has(fence.fenceId)) continue;
      if (fence.state === "pending") continue;
      const refTime = fence.settledAt ?? fence.abortedAt ?? fence.createdAt;
      if (Date.parse(refTime) <= cutoffMs) {
        await this.store.deleteFence(fence.fenceId);
        deletedFences.push(fence.fenceId);
      }
    }

    return {
      deletedFences,
      deletedLeases,
      deletedEvents,
      deletedBatches,
      deletedWakeups,
      retainedUnresolvedIds,
      tombstonesWritten,
      corruptRecords,
    };
  }

  // =========================================================================
  // Summary Projection & Derived Task Wake State
  // =========================================================================

  async getAgentSummary(agentId: string): Promise<AgentContinuationSummary> {
    assertValidAgentId(agentId);
    const accounting = await this.store.readAccounting(agentId);
    const leases = (await this.store.listLeases()).records.filter((l) => l.agentId === agentId);

    const pendingLeases = leases.filter((l) => PENDING_LEASE_STATES.has(l.state));
    const blockedLeases = leases.filter((l) => l.state === "blocked");

    let continuationState: ContinuationProjectionState = "none";
    let continuationBlockedError: string | null = null;

    if (blockedLeases.length > 0) {
      continuationState = "needs_attention";
      continuationBlockedError = blockedLeases[0]!.blockedReason ?? "internal_error";
    } else if (
      pendingLeases.some((l) => l.state === "dispatch_reserved" || l.state === "resumed_running")
    ) {
      continuationState = "processing";
    } else if (pendingLeases.length > 0) {
      continuationState = "waiting";
    }

    return {
      pendingContinuationsCount: pendingLeases.length,
      continuationState,
      continuationBlockedError,
      continuationRevision: accounting?.continuationRevision ?? 0,
      blockedContinuationsCount: blockedLeases.length,
    };
  }

  /**
   * Derives `Task.wakeState` purely by joining Task -> Event -> Batch (never persisted separately).
   */
  async deriveTaskWakeState(
    agentId: string,
    taskId: string,
    notifyOnExit: boolean,
  ): Promise<DerivedTaskWakeState> {
    if (!notifyOnExit) return "not_required";
    const event = await this.store.readEvent(`task:${taskId}:terminal`);
    if (!event) {
      const leases = (await this.store.listLeases()).records;
      const lease = leases.find(
        (l) => l.agentId === agentId && l.kind === "managed-command" && l.continuationId === taskId,
      );
      if (!lease) return "not_required";
      if (lease.state === "canceled") return "canceled";
      if (lease.state === "blocked") return "blocked";
      return "waiting";
    }
    if (event.batchId) {
      const batch = await this.store.readBatch(event.batchId);
      if (batch) {
        if (batch.state === "frozen") return "batched";
        return batch.state;
      }
    }
    return event.state;
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private async coverFallbackLocked(wakeup: OneShotWakeup, now: string): Promise<void> {
    await this.store.writeWakeup({
      ...wakeup,
      state: "covered",
      coverageState: "covered",
      terminalReason: "covered_by_primary_wake_turn",
      updatedAt: now,
    });
    if (wakeup.leaseId) {
      const lease = await this.store.readLease(wakeup.leaseId);
      if (lease && !SETTLED_LEASE_STATES.has(lease.state)) {
        await this.store.writeLease({
          ...lease,
          state: "covered",
          updatedAt: now,
        });
      }
    }
  }

  private async terminateFallbackLocked(
    wakeup: OneShotWakeup,
    targetState: "canceled" | "blocked",
    reason: string,
    now: string,
  ): Promise<void> {
    await this.store.writeWakeup({
      ...wakeup,
      state: targetState,
      coverageState: targetState,
      terminalReason: reason,
      updatedAt: now,
    });
    if (wakeup.leaseId) {
      const lease = await this.store.readLease(wakeup.leaseId);
      if (lease && !SETTLED_LEASE_STATES.has(lease.state)) {
        await this.store.writeLease({
          ...lease,
          state: targetState,
          blockedReason: targetState === "blocked" ? (reason as LeaseBlockedReason) : undefined,
          updatedAt: now,
        });
      }
    }
  }

  private async blockFallbacksForTaskLocked(
    agentId: string,
    taskId: string,
    allWakeups: readonly OneShotWakeup[],
    now: string,
  ): Promise<void> {
    for (const w of allWakeups) {
      if (w.agentId !== agentId || w.fallbackForTaskId !== taskId || w.state !== "scheduled") {
        continue;
      }
      await this.terminateFallbackLocked(w, "blocked", "autonomous_budget_exceeded", now);
    }
  }

  private async blockAgentForBudgetLocked(
    agentId: string,
    eventIds: readonly string[],
  ): Promise<void> {
    const now = this.nowIso();
    const allLeases = (await this.store.listLeases()).records;
    const allWakeups = (await this.store.listWakeups()).records;

    for (const eventId of eventIds) {
      const ev = await this.store.readEvent(eventId);
      if (ev) {
        await this.store.writeEvent({
          ...ev,
          state: "blocked",
          lastError: "autonomous_budget_exceeded",
          updatedAt: now,
        });
      }
      const lease = allLeases.find((l) => l.agentId === agentId && l.eventId === eventId);
      if (!lease) continue;
      await this.store.writeLease({
        ...lease,
        state: "blocked",
        blockedReason: "autonomous_budget_exceeded",
        updatedAt: now,
      });
      if (lease.kind === "managed-command") {
        await this.blockFallbacksForTaskLocked(agentId, lease.continuationId, allWakeups, now);
      }
    }

    await this.appendAuditEntryLocked(agentId, {
      kind: "budget_exceeded",
      reason: "autonomous_budget_exceeded",
    });
    await this.evaluateAndEmitCheckpoint(agentId, "autonomous_budget_exceeded");
  }

  private async getOrCreateAccountingLocked(agentId: string): Promise<AgentAccounting> {
    const existing = await this.store.readAccounting(agentId);
    if (existing) return existing;
    const created: AgentAccounting = {
      agentId,
      consecutiveAutonomousTurns: 0,
      autonomousTurnBudget: this.defaultBudget,
      continuationRevision: 0,
      auditHistory: [],
      updatedAt: this.nowIso(),
    };
    await this.store.writeAccounting(created);
    return created;
  }

  private async appendAuditEntryLocked(
    agentId: string,
    entry: Omit<AuditEntry, "id" | "timestamp">,
  ): Promise<void> {
    const accounting = await this.getOrCreateAccountingLocked(agentId);
    const now = this.nowIso();
    const nextEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: now,
      ...entry,
    };
    await this.store.writeAccounting({
      ...accounting,
      auditHistory: [...accounting.auditHistory, nextEntry],
      updatedAt: now,
    });
  }

  private async evaluateAndEmitCheckpoint(
    agentId: string,
    reason: string,
  ): Promise<AgentContinuationSummary> {
    const prev = this.lastSummaryByAgent.get(agentId);
    const raw = await this.getAgentSummary(agentId);
    const changed =
      !prev ||
      prev.pendingContinuationsCount !== raw.pendingContinuationsCount ||
      prev.continuationState !== raw.continuationState ||
      prev.continuationBlockedError !== raw.continuationBlockedError ||
      prev.blockedContinuationsCount !== raw.blockedContinuationsCount;

    if (!changed) {
      return raw;
    }

    const accounting = await this.getOrCreateAccountingLocked(agentId);
    const nextRevision = accounting.continuationRevision + 1;
    const now = this.nowIso();
    await this.store.writeAccounting({
      ...accounting,
      continuationRevision: nextRevision,
      updatedAt: now,
    });

    const summary: AgentContinuationSummary = {
      ...raw,
      continuationRevision: nextRevision,
    };
    this.lastSummaryByAgent.set(agentId, summary);

    this.onCheckpoint?.({
      type: "continuation_checkpoint",
      agentId,
      revision: nextRevision,
      summary,
      reason,
      emittedAt: now,
    });
    return summary;
  }
}

interface GcRecordIndex {
  leasesById: Map<string, ContinuationLease>;
  eventsById: Map<string, WakeEvent>;
  batchesById: Map<string, DispatchBatch>;
  wakeupsById: Map<string, OneShotWakeup>;
}

function splitComponentKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function isHealthyInFlightEventState(state: WakeEvent["state"]): boolean {
  return (
    state === "pending" || state === "batched" || state === "dispatching" || state === "accepted"
  );
}

function resolveBlockReasonForOutcome(
  kind: Exclude<WakeTurnOutcome["kind"], "completed">,
): LeaseBlockedReason {
  switch (kind) {
    case "user_stop":
      return "interrupted_by_user_stop";
    case "human_unrelated_prompt":
      return "human_takeover_required";
    case "authorization_revoked":
      return "authorization_revoked";
    case "provider_failure":
    case "archived":
      return "provider_unrecoverable";
  }
}

function resolveAuditKindForOutcome(
  kind: Exclude<WakeTurnOutcome["kind"], "completed">,
): AuditEntry["kind"] {
  if (kind === "user_stop") return "user_stop";
  if (kind === "authorization_revoked") return "authorization_revoked";
  return "blocked";
}

function linkLeaseAndEventEdges(
  index: GcRecordIndex,
  ensure: (k: string) => void,
  union: (a: string, b: string) => void,
): void {
  for (const l of index.leasesById.values()) {
    const lk = `lease:${l.leaseId}`;
    ensure(lk);
    if (l.eventId && index.eventsById.has(l.eventId)) union(lk, `event:${l.eventId}`);
    if (l.dispatchBatchId && index.batchesById.has(l.dispatchBatchId)) {
      union(lk, `batch:${l.dispatchBatchId}`);
    }
  }
  for (const e of index.eventsById.values()) {
    const ek = `event:${e.eventId}`;
    ensure(ek);
    if (e.batchId && index.batchesById.has(e.batchId)) union(ek, `batch:${e.batchId}`);
    if (e.sourceWakeId && index.wakeupsById.has(e.sourceWakeId)) {
      union(ek, `wakeup:${e.sourceWakeId}`);
    }
  }
}

function linkBatchAndWakeupEdges(
  index: GcRecordIndex,
  ensure: (k: string) => void,
  union: (a: string, b: string) => void,
): void {
  for (const b of index.batchesById.values()) {
    const bk = `batch:${b.batchId}`;
    ensure(bk);
    for (const eid of b.eventIds) {
      if (index.eventsById.has(eid)) union(bk, `event:${eid}`);
    }
  }
  for (const w of index.wakeupsById.values()) {
    const wk = `wakeup:${w.wakeId}`;
    ensure(wk);
    if (w.leaseId && index.leasesById.has(w.leaseId)) union(wk, `lease:${w.leaseId}`);
    if (w.eventId && index.eventsById.has(w.eventId)) union(wk, `event:${w.eventId}`);
    if (w.primaryEventId && index.eventsById.has(w.primaryEventId)) {
      union(wk, `event:${w.primaryEventId}`);
    }
  }
}

function buildGcComponents(index: GcRecordIndex): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const ensure = (k: string) => {
    find(k);
  };
  linkLeaseAndEventEdges(index, ensure, union);
  linkBatchAndWakeupEdges(index, ensure, union);

  const components = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const list = components.get(root) ?? [];
    list.push(key);
    components.set(root, list);
  }
  return components;
}

function isRecordEligibleForGc(key: string, index: GcRecordIndex, cutoffMs: number): boolean {
  const [kind, id] = splitComponentKey(key);
  if (kind === "lease") {
    const l = index.leasesById.get(id)!;
    return SETTLED_LEASE_STATES.has(l.state) && Date.parse(l.updatedAt) <= cutoffMs;
  }
  if (kind === "event") {
    const e = index.eventsById.get(id)!;
    return (
      (e.state === "accepted" || e.state === "canceled") && Date.parse(e.updatedAt) <= cutoffMs
    );
  }
  if (kind === "batch") {
    const b = index.batchesById.get(id)!;
    return b.state === "accepted" && Date.parse(b.updatedAt) <= cutoffMs;
  }
  const w = index.wakeupsById.get(id)!;
  return (w.state === "covered" || w.state === "canceled") && Date.parse(w.updatedAt) <= cutoffMs;
}

function isComponentEligibleForGc(
  members: readonly string[],
  index: GcRecordIndex,
  cutoffMs: number,
): boolean {
  return members.every((key) => isRecordEligibleForGc(key, index, cutoffMs));
}
