import { randomUUID } from "node:crypto";
import { formatAgentMessage } from "../agent/agent-messages/envelope.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { ManagedContinuationLedger } from "./ledger.js";
import type { ManagedTaskStore } from "./tasks/task-store.js";
import type { DispatchBatch, RunIdentity, WakeEvent } from "./types.js";

/** Max safe delay for Node.js `setTimeout` (2^31 - 1 ms, ~24.8 days). */
const MAX_JS_TIMER_MS = 2_147_483_647;
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

export interface OneShotWakeServiceOptions {
  ledger: ManagedContinuationLedger;
  clock?: () => number;
  reconcileIntervalMs?: number;
  onWakeEventsEnqueued?: (events: WakeEvent[]) => void | Promise<void>;
}

/**
 * Independent exact-`dueAt` OneShot timer service (Spec v0.4.1 §6.2):
 * - Uses segmented timers for delays > 24.8 days (no Cron minute ceiling).
 * - Timer NEVER calls Provider directly; it only persists durable `WakeEvent`s into the Ledger.
 */
export class OneShotWakeService {
  private readonly ledger: ManagedContinuationLedger;
  private readonly clock: () => number;
  private readonly reconcileIntervalMs: number;
  private readonly onWakeEventsEnqueued?: (events: WakeEvent[]) => void | Promise<void>;
  private nextTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: OneShotWakeServiceOptions) {
    this.ledger = options.ledger;
    this.clock = options.clock ?? (() => Date.now());
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.onWakeEventsEnqueued = options.onWakeEventsEnqueued;
  }

  async start(): Promise<WakeEvent[]> {
    this.stopped = false;
    const emitted = await this.tick();
    if (!this.stopped && this.reconcileIntervalMs > 0) {
      this.periodicTimer = setInterval(() => {
        void this.tick();
      }, this.reconcileIntervalMs);
      this.periodicTimer.unref?.();
    }
    return emitted;
  }

  stop(): void {
    this.stopped = true;
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  async tick(): Promise<WakeEvent[]> {
    if (this.stopped) return [];
    const emitted = await this.ledger.processDueOneShots();
    if (emitted.length > 0) {
      await this.onWakeEventsEnqueued?.(emitted);
    }
    await this.armNextTimer();
    return emitted;
  }

  async armNextTimer(): Promise<void> {
    if (this.stopped) return;
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    const wakeups = (await this.ledger.store.listWakeups()).records;
    let earliestMs: number | null = null;
    for (const w of wakeups) {
      if (w.state !== "scheduled") continue;
      const dueMs = Date.parse(w.dueAt);
      if (earliestMs === null || dueMs < earliestMs) {
        earliestMs = dueMs;
      }
    }
    if (earliestMs === null) return;
    const delayMs = Math.max(0, Math.min(earliestMs - this.clock(), MAX_JS_TIMER_MS));
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      void this.tick();
    }, delayMs);
    this.nextTimer.unref?.();
  }
}

export interface ManagedContinuationOutboxOptions {
  ledger: ManagedContinuationLedger;
  taskStore: ManagedTaskStore;
  agentManager: Pick<
    AgentManager,
    "tryReserveManagedWake" | "commitManagedWake" | "releaseManagedWake"
  >;
  serverId?: string;
}

async function renderEventSummarySection(
  event: WakeEvent,
  taskStore: ManagedTaskStore,
  ledger: ManagedContinuationLedger,
): Promise<string> {
  if (event.origin === "managed-command" && event.sourceTaskId) {
    const result = await taskStore.readResult(event.sourceTaskId);
    if (!result) {
      return `[managed-command ${event.sourceTaskId}] status=unknown (result missing)`;
    }
    const lines = [
      `[managed-command ${result.taskId}] status=${result.status} exitCode=${result.exitCode ?? "null"} signal=${result.signal ?? "none"}`,
    ];
    if (result.stdoutTail) lines.push(`stdout_tail:\n${result.stdoutTail}`);
    if (result.stderrTail) lines.push(`stderr_tail:\n${result.stderrTail}`);
    lines.push("Use read_background_command_output for full paginated logs.");
    return lines.join("\n");
  }
  if (event.sourceWakeId) {
    const wakeup = await ledger.store.readWakeup(event.sourceWakeId);
    const prefix =
      event.origin === "recovery-diagnostic"
        ? "[recovery-diagnostic — READ-ONLY CHECK ONLY; do NOT replay side-effecting commands before verifying state]"
        : "[one-shot wakeup]";
    return `${prefix}\n${wakeup?.prompt ?? "(prompt unavailable)"}`;
  }
  return `[${event.origin}] eventId=${event.eventId}`;
}

async function drainWakeTurnAndSettle(
  ledger: ManagedContinuationLedger,
  agentId: string,
  wakeRun: RunIdentity,
  iterator: AsyncGenerator<AgentStreamEvent>,
): Promise<void> {
  let sawCompleted = false;
  let sawCanceled = false;
  try {
    for await (const ev of iterator) {
      if (ev.type === "turn_completed") sawCompleted = true;
      if (ev.type === "turn_canceled") sawCanceled = true;
    }
    if (sawCompleted) {
      await ledger.settleWakeTurn({ agentId, wakeRun, outcome: { kind: "completed" } });
    } else if (sawCanceled) {
      await ledger.settleWakeTurn({ agentId, wakeRun, outcome: { kind: "user_stop" } });
    } else {
      await ledger.settleWakeTurn({
        agentId,
        wakeRun,
        outcome: { kind: "provider_failure", error: "wake_turn_ended_without_terminal_event" },
      });
    }
  } catch (error) {
    await ledger.settleWakeTurn({
      agentId,
      wakeRun,
      outcome: {
        kind: "provider_failure",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Bridges durable pending `WakeEvent`s -> immutable `DispatchBatch` -> `AgentManager`
 * idle-only atomic admission -> a turn marked `kind="managed-continuation"` (agent-messages/envelope.ts).
 */
export class ManagedContinuationOutboxService {
  private readonly ledger: ManagedContinuationLedger;
  private readonly taskStore: ManagedTaskStore;
  private readonly agentManager: ManagedContinuationOutboxOptions["agentManager"];
  private readonly serverId?: string;

  constructor(options: ManagedContinuationOutboxOptions) {
    this.ledger = options.ledger;
    this.taskStore = options.taskStore;
    this.agentManager = options.agentManager;
    this.serverId = options.serverId;
  }

  async dispatchPendingForAgent(agentId: string): Promise<{
    dispatched: boolean;
    batch?: DispatchBatch;
    done?: Promise<void>;
    reason?: string;
  }> {
    const events = (await this.ledger.store.listEvents()).records.filter(
      (e) => e.agentId === agentId && e.state === "pending",
    );
    if (events.length === 0) {
      return { dispatched: false, reason: "no_pending_events" };
    }

    const leases = (await this.ledger.store.listLeases()).records;
    const primaryEvent = events[0]!;
    const linkedLease = leases.find(
      (l) => l.agentId === agentId && l.eventId === primaryEvent.eventId,
    );
    const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const batchMessageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const sections: string[] = [];
    for (const ev of events) {
      sections.push(await renderEventSummarySection(ev, this.taskStore, this.ledger));
    }
    const envelope = formatAgentMessage({
      id: batchMessageId,
      source: {
        kind: "managed-continuation",
        agentId,
        serverId: this.serverId,
        eventIds: events.map((e) => e.eventId),
        origin: primaryEvent.origin,
      },
      text: sections.join("\n\n"),
    });

    const admission = await this.agentManager.tryReserveManagedWake({
      agentId,
      batchId,
      batchMessageId,
      creatorFenceId: linkedLease?.creatorFenceId ?? null,
    });
    if (admission.status !== "reserved") {
      return { dispatched: false, reason: admission.status };
    }

    let batch: DispatchBatch;
    try {
      batch = await this.ledger.freezeBatch({
        batchId,
        batchMessageId,
        agentId,
        eventIds: events.map((e) => e.eventId),
        serializedPrompt: envelope,
      });
    } catch (error) {
      await this.agentManager.releaseManagedWake(admission.reservationId, "freeze_failed");
      throw error;
    }

    await this.ledger.markBatchDispatching(batch.batchId, `att_${randomUUID().slice(0, 8)}`);
    try {
      const { run, iterator } = await this.agentManager.commitManagedWake({
        reservationId: admission.reservationId,
        serializedPrompt: envelope,
      });
      await this.ledger.reconcileDispatchOutcome(batch.batchId, {
        status: "accepted",
        providerReceiptId: run.runToken,
      });
      await this.ledger.attachWakeRunToBatch(batch.batchId, run);
      const done = drainWakeTurnAndSettle(this.ledger, agentId, run, iterator);
      return { dispatched: true, batch, done };
    } catch (error) {
      await this.agentManager.releaseManagedWake(admission.reservationId, "commit_failed");
      await this.ledger.reconcileDispatchOutcome(batch.batchId, {
        status: "uncertain",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
