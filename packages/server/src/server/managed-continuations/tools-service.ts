import { randomUUID } from "node:crypto";
import type { ManagedContinuationLedger } from "./ledger.js";
import type { OneShotWakeService } from "./one-shot-service.js";
import {
  assertColdResumeSupported,
  assertHostShellAuthorized,
  type ManagedShellAuthorizationPolicy,
  type ProviderContinuationCapabilities,
} from "./policy.js";
import { readManagedTaskOutput, TaskAccessDeniedError } from "./tasks/output-reader.js";
import type { ManagedTaskStore } from "./tasks/task-store.js";
import type { ReadTaskOutputResult, TaskResultRecord } from "./tasks/types.js";
import { submitTaskIntent, type ManagedTaskWorker } from "./tasks/worker.js";
import type {
  CancelWakeupResult,
  DerivedTaskWakeState,
  ManagedTaskStatus,
  OneShotWakeup,
  RunIdentity,
  SendLaterResult,
} from "./types.js";

export const MANAGED_CONTINUATION_TOOL_DESCRIPTIONS = {
  run_background_command:
    "Start a non-interactive background shell command managed by Paseo. Prefer this over short-interval heartbeats. Always specify a realistic timeoutSeconds and ensure the command returns meaningful exit codes. Receiving status='accepted' means the task was durably queued, NOT that the user goal succeeded.",
  get_background_command:
    "Inspect the status, exit code, tails, and derived notification state of a background command owned by the current agent.",
  list_background_commands:
    "List background commands owned by the current agent with their current status and derived notification state.",
  read_background_command_output:
    "Read UTF-8-aligned paginated stdout or stderr logs from a background command owned by the current agent using either cursor or tailBytes.",
  cancel_background_command:
    "Request cancellation of a running background command owned by the current agent.",
  send_later:
    "Schedule a one-shot delayed wake-up prompt for this agent (afterSeconds, afterMinutes, or timezone-aware ISO at). Does not execute shell commands. Use fallbackForTaskId only as a safety fallback when automatic exit notification might be unavailable.",
  list_scheduled_wakeups: "List one-shot scheduled wakeups owned by the current agent.",
  cancel_scheduled_wakeup:
    "Cancel a scheduled one-shot wakeup owned by the current agent without canceling any primary background command.",
} as const;

export interface ManagedToolCallerContext {
  agentId: string;
  workspaceId: string;
  defaultCwd: string;
  allowedWorkspaceRoots: readonly string[];
  originRun: RunIdentity;
  invocationId?: string;
  shellPolicy: ManagedShellAuthorizationPolicy;
  providerCapabilities: ProviderContinuationCapabilities;
}

export interface RunBackgroundCommandInput {
  command: string;
  name?: string;
  cwd?: string;
  timeoutSeconds?: number;
  notifyOnExit?: boolean;
  completionContext?: string;
}

export interface RunBackgroundCommandOutput {
  taskId: string;
  status: "accepted";
  acceptedAt: string;
  deadlineAt: string;
  notification: "armed" | "disabled";
}

export interface ManagedTaskView {
  taskId: string;
  agentId: string;
  workspaceId: string;
  name?: string;
  status: ManagedTaskStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  streamDrainTruncated: boolean;
  wakeState: DerivedTaskWakeState;
  error?: string;
}

export interface SendLaterToolInput {
  prompt: string;
  afterSeconds?: number;
  afterMinutes?: number;
  at?: string;
  name?: string;
  fallbackForTaskId?: string;
}

export interface ManagedContinuationToolsServiceOptions {
  ledger: ManagedContinuationLedger;
  taskStore: ManagedTaskStore;
  worker: ManagedTaskWorker;
  oneShotService: OneShotWakeService;
  clock?: () => number;
}

function generateServerId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function resolveNonTerminalTaskStatus(
  taskStore: ManagedTaskStore,
  taskId: string,
): Promise<ManagedTaskStatus> {
  const cancel = await taskStore.readCancelRequest(taskId);
  if (cancel) return "cancel_requested";
  const runner = await taskStore.readRunner(taskId);
  if (!runner) return "accepted";
  return runner.state === "claiming" ? "starting" : "running";
}

function buildManagedTaskOutputView(result: TaskResultRecord | null) {
  return {
    stdoutTail: result?.stdoutTail ?? "",
    stderrTail: result?.stderrTail ?? "",
    stdoutTruncated: result?.stdoutTruncated ?? false,
    stderrTruncated: result?.stderrTruncated ?? false,
    streamDrainTruncated: result?.streamDrainTruncated ?? false,
  };
}

function buildManagedTaskView(
  taskId: string,
  agentId: string,
  workspaceId: string,
  name: string | undefined,
  status: ManagedTaskStatus,
  wakeState: DerivedTaskWakeState,
  result: TaskResultRecord | null,
): ManagedTaskView {
  return {
    taskId,
    agentId,
    workspaceId,
    name,
    status,
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    startedAt: result?.startedAt ?? null,
    endedAt: result?.endedAt ?? null,
    durationMs: result?.durationMs ?? null,
    ...buildManagedTaskOutputView(result),
    wakeState,
    error: result?.error,
  };
}

/**
 * Service backing all 8 Paseo Managed Continuations Agent Tools (Spec v0.4.1 §6.1 & §6.2).
 * Always enforces server-side caller identity, triple Shell authorization, and coldSessionResume gate.
 */
export class ManagedContinuationToolsService {
  private readonly ledger: ManagedContinuationLedger;
  private readonly taskStore: ManagedTaskStore;
  private readonly worker: ManagedTaskWorker;
  private readonly oneShotService: OneShotWakeService;
  private readonly clock: () => number;

  constructor(options: ManagedContinuationToolsServiceOptions) {
    this.ledger = options.ledger;
    this.taskStore = options.taskStore;
    this.worker = options.worker;
    this.oneShotService = options.oneShotService;
    this.clock = options.clock ?? (() => Date.now());
  }

  async runBackgroundCommand(
    caller: ManagedToolCallerContext,
    input: RunBackgroundCommandInput,
  ): Promise<RunBackgroundCommandOutput> {
    assertHostShellAuthorized(caller.shellPolicy);
    const notifyOnExit = input.notifyOnExit ?? true;
    if (notifyOnExit) {
      assertColdResumeSupported(
        caller.providerCapabilities,
        "run_background_command(notifyOnExit=true)",
      );
    }

    const taskId = generateServerId("task");
    const intent = await submitTaskIntent(this.taskStore, {
      taskId,
      agentId: caller.agentId,
      workspaceId: caller.workspaceId,
      invocationId: caller.invocationId ?? generateServerId("inv"),
      command: input.command,
      name: input.name,
      cwd: input.cwd ?? caller.defaultCwd,
      allowedWorkspaceRoots: caller.allowedWorkspaceRoots,
      timeoutSeconds: input.timeoutSeconds,
      notifyOnExit,
      completionContext: input.completionContext,
      nowMs: this.clock(),
    });

    // Invariant #4: Persist Lease & OriginTurnFence BEFORE starting the OS command.
    if (intent.notifyOnExit) {
      await this.ledger.registerTaskLease({
        leaseId: generateServerId("lease"),
        taskId: intent.taskId,
        agentId: caller.agentId,
        workspaceId: caller.workspaceId,
        origin: caller.originRun,
        notifyOnExit: true,
      });
    }

    await this.worker.startTask(intent.taskId);

    return {
      taskId: intent.taskId,
      status: "accepted",
      acceptedAt: intent.acceptedAt,
      deadlineAt: intent.deadlineAt,
      notification: intent.notifyOnExit ? "armed" : "disabled",
    };
  }

  async getBackgroundCommand(
    caller: ManagedToolCallerContext,
    taskId: string,
  ): Promise<ManagedTaskView> {
    const intent = await this.taskStore.readIntent(taskId);
    if (!intent || intent.agentId !== caller.agentId || intent.workspaceId !== caller.workspaceId) {
      throw new TaskAccessDeniedError(`Task not found or not owned by caller: ${taskId}`);
    }
    const result = await this.taskStore.readResult(taskId);
    const status = result
      ? result.status
      : await resolveNonTerminalTaskStatus(this.taskStore, taskId);
    const wakeState = await this.ledger.deriveTaskWakeState(
      caller.agentId,
      taskId,
      intent.notifyOnExit,
    );
    return buildManagedTaskView(
      intent.taskId,
      intent.agentId,
      intent.workspaceId,
      intent.name,
      status,
      wakeState,
      result,
    );
  }

  async listBackgroundCommands(caller: ManagedToolCallerContext): Promise<ManagedTaskView[]> {
    const ids = await this.taskStore.listTaskIds();
    const views: ManagedTaskView[] = [];
    for (const id of ids) {
      const intent = await this.taskStore.readIntent(id);
      if (!intent || intent.agentId !== caller.agentId) continue;
      views.push(await this.getBackgroundCommand(caller, id));
    }
    return views;
  }

  async readBackgroundCommandOutput(
    caller: ManagedToolCallerContext,
    input: {
      taskId: string;
      stream: "stdout" | "stderr";
      cursor?: string;
      tailBytes?: number;
      maxBytes?: number;
    },
  ): Promise<ReadTaskOutputResult> {
    return readManagedTaskOutput(this.taskStore, {
      taskId: input.taskId,
      callerAgentId: caller.agentId,
      callerWorkspaceId: caller.workspaceId,
      stream: input.stream,
      cursor: input.cursor,
      tailBytes: input.tailBytes,
      maxBytes: input.maxBytes,
    });
  }

  async cancelBackgroundCommand(
    caller: ManagedToolCallerContext,
    taskId: string,
    reason = "canceled_by_agent",
  ): Promise<{ canceledRequested: boolean; taskId: string }> {
    const intent = await this.taskStore.readIntent(taskId);
    if (!intent || intent.agentId !== caller.agentId || intent.workspaceId !== caller.workspaceId) {
      throw new TaskAccessDeniedError(`Task not found or not owned by caller: ${taskId}`);
    }
    const requested = await this.worker.cancelTask(taskId, {
      taskId,
      requestedAt: new Date(this.clock()).toISOString(),
      reason,
      requestedBy: "agent",
    });
    return { canceledRequested: requested, taskId };
  }

  async sendLater(
    caller: ManagedToolCallerContext,
    input: SendLaterToolInput,
  ): Promise<SendLaterResult> {
    assertColdResumeSupported(caller.providerCapabilities, "send_later");
    const res = await this.ledger.scheduleOneShot({
      wakeId: generateServerId("wake"),
      leaseId: generateServerId("lease"),
      agentId: caller.agentId,
      workspaceId: caller.workspaceId,
      origin: caller.originRun,
      prompt: input.prompt,
      name: input.name,
      afterSeconds: input.afterSeconds,
      afterMinutes: input.afterMinutes,
      at: input.at,
      fallbackForTaskId: input.fallbackForTaskId,
    });
    if (res.status === "scheduled") {
      await this.oneShotService.armNextTimer();
    }
    return res;
  }

  async listScheduledWakeups(caller: ManagedToolCallerContext): Promise<OneShotWakeup[]> {
    const all = (await this.ledger.store.listWakeups()).records;
    return all.filter((w) => w.agentId === caller.agentId);
  }

  async cancelScheduledWakeup(
    caller: ManagedToolCallerContext,
    wakeId: string,
  ): Promise<CancelWakeupResult> {
    const existing = await this.ledger.store.readWakeup(wakeId);
    if (!existing) {
      return { canceled: false, wakeId, reason: "not_found" };
    }
    if (existing.agentId !== caller.agentId) {
      throw new TaskAccessDeniedError(`Wakeup not owned by caller: ${wakeId}`);
    }
    return this.ledger.cancelOneShot(wakeId);
  }
}
