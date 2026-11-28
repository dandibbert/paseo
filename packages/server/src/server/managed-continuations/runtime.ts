import { randomUUID } from "node:crypto";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import { ManagedContinuationStore } from "./atomic-store.js";
import { computeFenceId } from "./codec.js";
import { ManagedContinuationLedger, type ReceiptProbe } from "./ledger.js";
import { ManagedContinuationOutboxService, OneShotWakeService } from "./one-shot-service.js";
import { ManagedTaskStore } from "./tasks/task-store.js";
import {
  ManagedTaskWorker,
  readHostBootId,
  reconcileOrphanTasks,
  reconcileTaskResultsToLedger,
} from "./tasks/worker.js";
import { ManagedContinuationToolsService } from "./tools-service.js";
import type { StartupReconcileReport } from "./types.js";
import { parseAgentMessages } from "../agent/agent-messages/envelope.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

/** A prompt a person typed: wakes, agent messages and schedule fires arrive as marked messages. */
function isHumanPrompt(item: AgentTimelineItem): boolean {
  if (item.type !== "user_message") return false;
  const messages = parseAgentMessages(item.text);
  // Unmarked text is typed; a marked message counts only when it says the user wrote it.
  return messages === null || messages.every((message) => message.source === null);
}

export interface ManagedContinuationsRuntimeOptions {
  paseoHome: string;
  agentManager: Pick<
    AgentManager,
    | "tryReserveManagedWake"
    | "commitManagedWake"
    | "releaseManagedWake"
    | "emitContinuationCheckpoint"
  > & { subscribe?: AgentManager["subscribe"] };
  daemonInstanceId?: string;
  serverId?: string;
  bootId?: string;
  clock?: () => number;
  reconcileIntervalMs?: number;
  platform?: NodeJS.Platform;
}

export interface ManagedContinuationsStartOptions {
  restartRecoveryBarrier: () => Promise<void>;
  receiptProbe: ReceiptProbe;
}

export interface ManagedContinuationsStopOptions {
  /** Default false: keep running background tasks alive across normal daemon stop (Spec §8.1). */
  killTasks?: boolean;
}

/**
 * Unified daemon-side runtime orchestrating Ledger, TaskWorker, OneShotWakeService,
 * Outbox dispatcher, and the 8 Agent Tool handlers in Spec §4.6 / §8.1 order.
 */
export class ManagedContinuationsRuntime {
  readonly daemonInstanceId: string;
  readonly ledgerStore: ManagedContinuationStore;
  readonly taskStore: ManagedTaskStore;
  readonly ledger: ManagedContinuationLedger;
  readonly worker: ManagedTaskWorker;
  readonly oneShotService: OneShotWakeService;
  readonly outbox: ManagedContinuationOutboxService;
  readonly tools: ManagedContinuationToolsService;
  private readonly agentManager: ManagedContinuationsRuntimeOptions["agentManager"];
  private readonly bootIdOverride?: string;
  private readonly clock: () => number;
  private readonly platform: NodeJS.Platform;
  private unsubscribeAgentManager: (() => void) | null = null;

  constructor(options: ManagedContinuationsRuntimeOptions) {
    this.daemonInstanceId = options.daemonInstanceId ?? randomUUID();
    this.bootIdOverride = options.bootId;
    this.clock = options.clock ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.agentManager = options.agentManager;

    this.ledgerStore = new ManagedContinuationStore(options.paseoHome);
    this.taskStore = new ManagedTaskStore(options.paseoHome);
    this.ledger = new ManagedContinuationLedger({
      store: this.ledgerStore,
      daemonInstanceId: this.daemonInstanceId,
      clock: this.clock,
      onCheckpoint: (cp) => {
        options.agentManager.emitContinuationCheckpoint(cp);
      },
    });
    this.worker = new ManagedTaskWorker({
      store: this.taskStore,
      bootId: options.bootId,
      platform: this.platform,
      onTaskTerminal: async (result) => {
        const intent = await this.taskStore.readIntent(result.taskId);
        if (!intent || !intent.notifyOnExit) return;
        await this.ledger.recordTaskTerminalEvent({
          taskId: result.taskId,
          agentId: result.agentId,
          workspaceId: result.workspaceId,
          payloadRef: `tasks/${result.taskId}/result.json`,
        });
        await this.tryDispatchAgent(result.agentId);
      },
    });
    this.oneShotService = new OneShotWakeService({
      ledger: this.ledger,
      clock: this.clock,
      reconcileIntervalMs: options.reconcileIntervalMs,
      onWakeEventsEnqueued: async (events) => {
        const agentIds = new Set(events.map((e) => e.agentId));
        for (const agentId of agentIds) {
          await this.tryDispatchAgent(agentId);
        }
      },
    });
    this.outbox = new ManagedContinuationOutboxService({
      ledger: this.ledger,
      taskStore: this.taskStore,
      agentManager: options.agentManager,
      serverId: options.serverId,
    });
    this.tools = new ManagedContinuationToolsService({
      ledger: this.ledger,
      taskStore: this.taskStore,
      worker: this.worker,
      oneShotService: this.oneShotService,
      clock: this.clock,
    });
  }

  /**
   * Ordered Daemon startup reconcile (Spec §4.6):
   * 1. Reconcile orphaned tasks (dead PID / boot mismatch -> `unknown`, never double-spawn).
   * 2. Start non-PTY worker (POSIX only; skipped cleanly on Windows where tasks are capability-gated).
   * 3. Await `restartRecoveryBarrier` & reconcile cross-epoch Fences/Leases/Batches.
   * 4. Compensate durable `result.json` -> `WakeEvent` and start `OneShotWakeService`.
   */
  async start(options: ManagedContinuationsStartOptions): Promise<{
    reconcileReport: StartupReconcileReport;
    orphanTaskIds: string[];
    compensatedEventIds: string[];
  }> {
    const currentBootId = this.bootIdOverride ?? (await readHostBootId());
    const orphanTaskIds = await reconcileOrphanTasks(this.taskStore, currentBootId);
    if (this.platform !== "win32") {
      await this.worker.start();
    }
    const reconcileReport = await this.ledger.reconcileStartup({
      restartRecoveryBarrier: options.restartRecoveryBarrier,
      receiptProbe: options.receiptProbe,
    });
    const compensatedEventIds = await reconcileTaskResultsToLedger(this.taskStore, this.ledger);
    await this.oneShotService.start();
    if (!this.unsubscribeAgentManager && this.agentManager.subscribe) {
      this.unsubscribeAgentManager = this.agentManager.subscribe(
        (event) => {
          void this.handleAgentManagerEvent(event);
        },
        { replayState: false },
      );
    }
    return { reconcileReport, orphanTaskIds, compensatedEventIds };
  }

  async stop(options?: ManagedContinuationsStopOptions): Promise<{ canceledTaskIds: string[] }> {
    this.oneShotService.stop();
    this.unsubscribeAgentManager?.();
    this.unsubscribeAgentManager = null;
    const canceledTaskIds: string[] = [];
    if (options?.killTasks) {
      const ids = await this.taskStore.listTaskIds();
      const now = new Date(this.clock()).toISOString();
      for (const taskId of ids) {
        const existingResult = await this.taskStore.readResult(taskId);
        if (existingResult) continue;
        const canceled = await this.worker.cancelTask(taskId, {
          taskId,
          requestedAt: now,
          reason: "daemon_stop_kill_tasks",
          requestedBy: "daemon_stop",
        });
        if (canceled) canceledTaskIds.push(taskId);
      }
    }
    if (this.platform !== "win32") {
      await this.worker.beginDraining();
    }
    return { canceledTaskIds };
  }

  private async settleFenceIfPresent(runToken: string): Promise<void> {
    const origin = { daemonInstanceId: this.daemonInstanceId, runToken };
    const fence = await this.ledgerStore.readFence(computeFenceId(origin));
    if (fence && fence.state === "pending") {
      await this.ledger.settleOriginFence(origin);
    }
  }

  private async handleAgentManagerEvent(event: AgentManagerEvent): Promise<void> {
    if (event.type === "agent_stream") {
      const streamEv = event.event;
      if (streamEv.type === "timeline" && isHumanPrompt(streamEv.item)) {
        // A person stepped in, so the agent's run of autonomous wake turns starts over.
        await this.ledger
          .recordHumanBudgetReset(event.agentId, "user_message")
          .catch(() => undefined);
        return;
      }
      if (streamEv.type !== "turn_completed" && streamEv.type !== "turn_canceled") return;
      const turnId =
        "turnId" in streamEv && typeof streamEv.turnId === "string" ? streamEv.turnId : null;
      if (turnId) {
        await this.settleFenceIfPresent(turnId);
      }
      await this.settleFenceIfPresent(`turn-less-${event.agentId}`);
      await this.tryDispatchAgent(event.agentId);
      return;
    }
    if (event.type === "agent_state" && event.agent.lifecycle === "idle") {
      await this.tryDispatchAgent(event.agent.id);
    }
  }

  private async tryDispatchAgent(agentId: string): Promise<void> {
    try {
      const res = await this.outbox.dispatchPendingForAgent(agentId);
      if (res.dispatched && res.done) {
        await res.done;
      }
    } catch {
      // Expected transient rejections (e.g. pending OriginTurnFence or busy agent);
      // the next turn_completed / idle event will retry automatically.
    }
  }
}
