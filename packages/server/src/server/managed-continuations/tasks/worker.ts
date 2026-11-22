import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import { assertSafeServerId, assertUtf8ByteLimit, assertValidAgentId } from "../codec.js";
import type { ManagedContinuationLedger } from "../ledger.js";
import { readUtf8TailFromFile } from "./output-reader.js";
import {
  computeTaskFingerprint,
  ManagedTaskStore,
  validateTaskCwdWithinRoots,
} from "./task-store.js";
import {
  DEFAULT_DRAIN_GRACE_MS,
  DEFAULT_MAX_AGENT_CONCURRENT_TASKS,
  DEFAULT_MAX_HOST_CONCURRENT_TASKS,
  DEFAULT_RESULT_TAIL_BYTES,
  DEFAULT_TASK_TIMEOUT_SECONDS,
  MAX_COMPLETION_CONTEXT_BYTES,
  MAX_TASK_COMMAND_BYTES,
  MAX_TASK_LOG_BYTES,
  MAX_TASK_NAME_BYTES,
  MAX_TASK_TIMEOUT_SECONDS,
  MIN_TASK_TIMEOUT_SECONDS,
  type ManagedTaskTerminalStatus,
  type TaskCancelRequest,
  type TaskIntent,
  type TaskResultRecord,
  type TaskRunnerRecord,
} from "./types.js";

const STRIPPED_SECRET_ENV_KEYS = new Set([
  "PASEO_AUTH_TOKEN",
  "PASEO_MCP_TOKEN",
  "PASEO_LOCAL_CREDENTIAL",
  "PASEO_RELAY_SECRET",
  "PASEO_DAEMON_SECRET",
  "PASEO_TOKEN",
]);

export class PlatformUnsupportedError extends Error {
  readonly code = "PLATFORM_UNSUPPORTED";
}

export class InvocationConflictError extends Error {
  readonly code = "INVOCATION_CONFLICT";
}

export class TaskConcurrencyLimitError extends Error {
  readonly code = "TASK_CONCURRENCY_LIMIT_EXCEEDED";
}

export class TaskValidationError extends Error {
  readonly code = "TASK_VALIDATION_ERROR";
}

export function assertSupportedTaskPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new PlatformUnsupportedError(
      "Managed background commands are disabled on Windows in v0.4.1 (macOS/Linux only)",
    );
  }
}

export function buildSanitizedTaskEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (STRIPPED_SECRET_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export async function readHostBootId(): Promise<string> {
  try {
    const raw = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch {
    // Non-Linux (e.g. macOS): fall back to stable process-host identifier.
  }
  return `${process.platform}-boot`;
}

export interface SubmitTaskIntentInput {
  taskId: string;
  agentId: string;
  workspaceId: string;
  invocationId: string;
  command: string;
  name?: string;
  cwd: string;
  allowedWorkspaceRoots: readonly string[];
  timeoutSeconds?: number;
  notifyOnExit?: boolean;
  completionContext?: string;
  maxHostConcurrent?: number;
  maxAgentConcurrent?: number;
  nowMs?: number;
  platform?: NodeJS.Platform;
}

async function findExistingInvocationIntent(
  store: ManagedTaskStore,
  agentId: string,
  invocationId: string,
): Promise<TaskIntent | null> {
  const ids = await store.listTaskIds();
  for (const id of ids) {
    const existing = await store.readIntent(id);
    if (existing && existing.agentId === agentId && existing.invocationId === invocationId) {
      return existing;
    }
  }
  return null;
}

async function countActiveTasks(
  store: ManagedTaskStore,
  agentId: string,
): Promise<{ hostActive: number; agentActive: number }> {
  const ids = await store.listTaskIds();
  let hostActive = 0;
  let agentActive = 0;
  for (const id of ids) {
    const result = await store.readResult(id);
    if (result) continue;
    const intent = await store.readIntent(id);
    if (!intent) continue;
    hostActive += 1;
    if (intent.agentId === agentId) agentActive += 1;
  }
  return { hostActive, agentActive };
}

/**
 * Daemon-only intent submission: validates platform, command/context sizes, realpath cwd,
 * idempotent invocation dedup, and host/agent concurrency limits before writing `intent.json`.
 */
export async function submitTaskIntent(
  store: ManagedTaskStore,
  input: SubmitTaskIntentInput,
): Promise<TaskIntent> {
  assertSupportedTaskPlatform(input.platform);
  assertSafeServerId(input.taskId, "taskId");
  assertValidAgentId(input.agentId);
  assertUtf8ByteLimit(input.command, MAX_TASK_COMMAND_BYTES, "command");
  if (input.name !== undefined) {
    assertUtf8ByteLimit(input.name, MAX_TASK_NAME_BYTES, "name");
  }
  if (input.completionContext !== undefined) {
    assertUtf8ByteLimit(input.completionContext, MAX_COMPLETION_CONTEXT_BYTES, "completionContext");
  }

  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < MIN_TASK_TIMEOUT_SECONDS ||
    timeoutSeconds > MAX_TASK_TIMEOUT_SECONDS
  ) {
    throw new TaskValidationError(
      `timeoutSeconds must be an integer between ${MIN_TASK_TIMEOUT_SECONDS} and ${MAX_TASK_TIMEOUT_SECONDS}`,
    );
  }

  const realCwd = await validateTaskCwdWithinRoots(input.cwd, input.allowedWorkspaceRoots);
  const notifyOnExit = input.notifyOnExit ?? true;
  const fingerprint = computeTaskFingerprint({
    command: input.command,
    cwd: realCwd,
    timeoutSeconds,
    notifyOnExit,
  });

  const existing = await findExistingInvocationIntent(store, input.agentId, input.invocationId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new InvocationConflictError(
        `Invocation ${input.invocationId} already exists with a different fingerprint`,
      );
    }
    return existing;
  }

  const { hostActive, agentActive } = await countActiveTasks(store, input.agentId);
  const maxHost = input.maxHostConcurrent ?? DEFAULT_MAX_HOST_CONCURRENT_TASKS;
  const maxAgent = input.maxAgentConcurrent ?? DEFAULT_MAX_AGENT_CONCURRENT_TASKS;
  if (hostActive >= maxHost || agentActive >= maxAgent) {
    throw new TaskConcurrencyLimitError(
      `Concurrency limit reached (host=${hostActive}/${maxHost}, agent=${agentActive}/${maxAgent})`,
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  const intent: TaskIntent = {
    taskId: input.taskId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    invocationId: input.invocationId,
    fingerprint,
    command: input.command,
    name: input.name,
    cwd: realCwd,
    timeoutSeconds,
    notifyOnExit,
    completionContext: input.completionContext,
    acceptedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + timeoutSeconds * 1000).toISOString(),
  };
  await store.writeIntent(intent);
  return intent;
}

interface StreamLogCapture {
  ended: Promise<void>;
  destroy(): void;
  getBytesDiscarded(): number;
}

function attachBoundedLogStream(
  stream: Readable | null,
  filePath: string,
  maxBytes: number,
): StreamLogCapture {
  if (!stream) {
    return { ended: Promise.resolve(), destroy: () => undefined, getBytesDiscarded: () => 0 };
  }
  let writtenBytes = 0;
  let discardedBytes = 0;
  let writeChain = Promise.resolve();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const finish = () => {
    void writeChain.finally(() => resolveEnded());
  };

  stream.on("data", (chunk: Buffer) => {
    const remaining = maxBytes - writtenBytes;
    if (remaining <= 0) {
      discardedBytes += chunk.length;
      return;
    }
    const toWrite = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    if (chunk.length > remaining) {
      discardedBytes += chunk.length - remaining;
    }
    writtenBytes += toWrite.length;
    writeChain = writeChain
      .then(() => fs.appendFile(filePath, toWrite, { mode: 0o600 }))
      .catch(() => undefined);
  });
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", finish);

  return {
    ended,
    destroy: () => {
      stream.destroy();
      finish();
    },
    getBytesDiscarded: () => discardedBytes,
  };
}

function signalProcessGroupSafe(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Process group already exited.
  }
}

interface RunningTaskHandle {
  taskId: string;
  child: ChildProcess;
  pgid: number;
  done: Promise<TaskResultRecord>;
  markCanceled: () => void;
}

export interface ManagedTaskWorkerOptions {
  store: ManagedTaskStore;
  workerInstanceId?: string;
  version?: string;
  bootId?: string;
  drainGraceMs?: number;
  maxLogBytesPerStream?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  onTaskTerminal?: (result: TaskResultRecord) => void | Promise<void>;
}

/**
 * Non-PTY ManagedTaskWorker (Spec v0.4.1 §5):
 * - Runs detached POSIX process groups via `/bin/sh -c`, `stdin: "ignore"`, stripped secrets.
 * - Never blocks forever on grandchild-inherited stdio pipes (bounded `drainGraceMs`).
 * - Atomic exclusive `runner.json` claim prevents double-spawn.
 * - Supports `current -> draining -> stopped` upgrade lifecycle.
 */
export class ManagedTaskWorker {
  readonly workerInstanceId: string;
  private readonly store: ManagedTaskStore;
  private readonly version: string;
  private readonly drainGraceMs: number;
  private readonly maxLogBytesPerStream: number;
  private readonly killGraceMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly onTaskTerminal?: (result: TaskResultRecord) => void | Promise<void>;
  private readonly running = new Map<string, RunningTaskHandle>();
  private bootId: string;
  private state: "current" | "draining" | "stopped" = "current";
  private readonly startedAt = new Date().toISOString();

  constructor(options: ManagedTaskWorkerOptions) {
    this.store = options.store;
    this.workerInstanceId =
      options.workerInstanceId ?? `wk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.version = options.version ?? "0.4.1";
    this.bootId = options.bootId ?? "";
    this.drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    this.maxLogBytesPerStream = options.maxLogBytesPerStream ?? Math.floor(MAX_TASK_LOG_BYTES / 2);
    this.killGraceMs = options.killGraceMs ?? 500;
    this.platform = options.platform ?? process.platform;
    this.onTaskTerminal = options.onTaskTerminal;
  }

  async start(): Promise<void> {
    assertSupportedTaskPlatform(this.platform);
    await this.store.ensureLayout();
    if (!this.bootId) {
      this.bootId = await readHostBootId();
    }
    await this.persistWorkerState();
  }

  async beginDraining(): Promise<void> {
    this.state = "draining";
    await this.persistWorkerState();
    if (this.running.size === 0) {
      await this.markStopped();
    }
  }

  getState(): "current" | "draining" | "stopped" {
    return this.state;
  }

  activeTaskCount(): number {
    return this.running.size;
  }

  async startTask(taskId: string): Promise<{ done: Promise<TaskResultRecord> }> {
    assertSupportedTaskPlatform(this.platform);
    if (this.state !== "current") {
      throw new Error(
        `Worker ${this.workerInstanceId} is ${this.state} and cannot accept new tasks`,
      );
    }
    if (!this.bootId) {
      this.bootId = await readHostBootId();
    }
    const intent = await this.store.readIntent(taskId);
    if (!intent) {
      throw new Error(`Task intent not found: ${taskId}`);
    }

    const startedAt = new Date().toISOString();
    const claimRecord: TaskRunnerRecord = {
      taskId,
      workerInstanceId: this.workerInstanceId,
      pid: null,
      pgid: null,
      bootId: this.bootId,
      startedAt,
      state: "claiming",
    };
    await this.store.claimTaskExclusive(claimRecord);

    const stdoutPath = this.store.logPath(taskId, "stdout");
    const stderrPath = this.store.logPath(taskId, "stderr");
    const startedMs = Date.now();

    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", intent.command], {
        cwd: intent.cwd,
        env: buildSanitizedTaskEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = await this.commitSpawnFailed(intent, startedAt, error);
      return { done: Promise.resolve(failed) };
    }

    const pgid = child.pid ?? 0;
    const runnerReady = this.store.updateRunner({
      ...claimRecord,
      pid: child.pid ?? null,
      pgid: pgid > 0 ? pgid : null,
      state: "running",
    });

    const stdoutCapture = attachBoundedLogStream(
      child.stdout,
      stdoutPath,
      this.maxLogBytesPerStream,
    );
    const stderrCapture = attachBoundedLogStream(
      child.stderr,
      stderrPath,
      this.maxLogBytesPerStream,
    );

    let canceled = false;
    let timedOut = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

    const stopProcessGroup = () => {
      if (pgid <= 0) return;
      signalProcessGroupSafe(pgid, "SIGTERM");
      killEscalationTimer ??= setTimeout(() => {
        signalProcessGroupSafe(pgid, "SIGKILL");
      }, this.killGraceMs);
    };

    const timeoutTimer = setTimeout(() => {
      if (canceled) return;
      timedOut = true;
      stopProcessGroup();
    }, intent.timeoutSeconds * 1000);

    const done = new Promise<TaskResultRecord>((resolve, reject) => {
      let settled = false;
      const finalize = async (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: Error,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);

        const streamDrainTruncated = await this.drainWithGrace(stdoutCapture, stderrCapture);
        await runnerReady;
        const endedMs = Date.now();
        const endedAt = new Date(endedMs).toISOString();
        const stdoutTail = await readUtf8TailFromFile(stdoutPath, DEFAULT_RESULT_TAIL_BYTES);
        const stderrTail = await readUtf8TailFromFile(stderrPath, DEFAULT_RESULT_TAIL_BYTES);
        const status = resolveTerminalTaskStatus({
          spawnError,
          canceled,
          timedOut,
          exitCode,
        });

        const result: TaskResultRecord = {
          taskId: intent.taskId,
          agentId: intent.agentId,
          workspaceId: intent.workspaceId,
          status,
          exitCode,
          signal,
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedMs - startedMs),
          stdoutTail: stdoutTail.text,
          stderrTail: stderrTail.text,
          stdoutTruncated: stdoutTail.truncated || stdoutCapture.getBytesDiscarded() > 0,
          stderrTruncated: stderrTail.truncated || stderrCapture.getBytesDiscarded() > 0,
          streamDrainTruncated,
          bytesDiscardedStdout: stdoutCapture.getBytesDiscarded(),
          bytesDiscardedStderr: stderrCapture.getBytesDiscarded(),
          ...(spawnError ? { error: spawnError.message } : {}),
        };

        await this.store.commitResultOnce(result);
        await this.store.updateRunner({
          ...claimRecord,
          pid: child.pid ?? null,
          pgid: pgid > 0 ? pgid : null,
          state: "exited",
        });
        this.running.delete(taskId);
        if (this.state === "draining" && this.running.size === 0) {
          await this.markStopped();
        }
        await this.onTaskTerminal?.(result);
        resolve(result);
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
        void finalize(code, signal, error).catch(reject);
      };
      child.once("error", (error) => finish(null, null, error));
      child.once("exit", finish);
    });

    this.running.set(taskId, {
      taskId,
      child,
      pgid,
      done,
      markCanceled: () => {
        if (timedOut) return;
        canceled = true;
        stopProcessGroup();
      },
    });

    // Expose completion separately so the caller can cancel while the task is running.
    void done.catch(() => {});
    await runnerReady;
    return { done };
  }

  async cancelTask(taskId: string, cancelRequest: TaskCancelRequest): Promise<boolean> {
    await this.store.writeCancelRequest(cancelRequest);
    const handle = this.running.get(taskId);
    if (!handle) return false;
    handle.markCanceled();
    return true;
  }

  private async drainWithGrace(
    stdoutCapture: StreamLogCapture,
    stderrCapture: StreamLogCapture,
  ): Promise<boolean> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        stdoutCapture.destroy();
        stderrCapture.destroy();
        resolve();
      }, this.drainGraceMs);
    });
    await Promise.race([Promise.all([stdoutCapture.ended, stderrCapture.ended]), grace]);
    if (timer) clearTimeout(timer);
    return timedOut;
  }

  private async commitSpawnFailed(
    intent: TaskIntent,
    startedAt: string,
    error: unknown,
  ): Promise<TaskResultRecord> {
    const endedAt = new Date().toISOString();
    const result: TaskResultRecord = {
      taskId: intent.taskId,
      agentId: intent.agentId,
      workspaceId: intent.workspaceId,
      status: "spawn_failed",
      exitCode: null,
      signal: null,
      startedAt,
      endedAt,
      durationMs: 0,
      stdoutTail: "",
      stderrTail: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      streamDrainTruncated: false,
      bytesDiscardedStdout: 0,
      bytesDiscardedStderr: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    await this.store.commitResultOnce(result);
    await this.onTaskTerminal?.(result);
    return result;
  }

  private async persistWorkerState(): Promise<void> {
    await this.store.writeWorkerInstance({
      workerInstanceId: this.workerInstanceId,
      pid: process.pid,
      bootId: this.bootId || "unknown",
      version: this.version,
      state: this.state,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  private async markStopped(): Promise<void> {
    this.state = "stopped";
    await this.persistWorkerState();
  }
}

function resolveTerminalTaskStatus(input: {
  spawnError?: Error;
  canceled: boolean;
  timedOut: boolean;
  exitCode: number | null;
}): ManagedTaskTerminalStatus {
  if (input.spawnError) return "spawn_failed";
  if (input.canceled) return "canceled";
  if (input.timedOut) return "timed_out";
  return input.exitCode === 0 ? "succeeded" : "failed";
}

export function isProcessAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles orphaned tasks after a worker SIGKILL or host reboot:
 * - If `runner.json` exists without `result.json` and bootId mismatched or PID is dead,
 *   marks `result.json` as `unknown` and NEVER re-spawns (Spec §5.3 & §11.3.1).
 */
export async function reconcileOrphanTasks(
  store: ManagedTaskStore,
  currentBootId: string,
  isPidAlive: (pid: number) => boolean = isProcessAliveDefault,
): Promise<string[]> {
  const unknownTaskIds: string[] = [];
  const taskIds = await store.listTaskIds();
  for (const taskId of taskIds) {
    const existingResult = await store.readResult(taskId);
    if (existingResult) continue;
    const runner = await store.readRunner(taskId);
    if (!runner) continue;
    const bootMismatch = runner.bootId !== currentBootId;
    const pidMissingOrDead = runner.pid === null || !isPidAlive(runner.pid);
    if (!bootMismatch && !pidMissingOrDead) continue;

    const intent = await store.readIntent(taskId);
    if (!intent) continue;
    const endedAt = new Date().toISOString();
    const committed = await store.commitResultOnce({
      taskId,
      agentId: intent.agentId,
      workspaceId: intent.workspaceId,
      status: "unknown",
      exitCode: null,
      signal: null,
      startedAt: runner.startedAt,
      endedAt,
      durationMs: null,
      stdoutTail: "",
      stderrTail: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      streamDrainTruncated: false,
      bytesDiscardedStdout: 0,
      bytesDiscardedStderr: 0,
      error: bootMismatch ? "host_reboot_boot_id_mismatch" : "worker_process_exited_without_result",
    });
    if (committed) unknownTaskIds.push(taskId);
  }
  return unknownTaskIds;
}

/**
 * Reconciles durable terminal `result.json` files into `ManagedContinuationLedger` WakeEvents
 * (recovering any tasks that finished while the Daemon was disconnected/restarting).
 */
export async function reconcileTaskResultsToLedger(
  store: ManagedTaskStore,
  ledger: ManagedContinuationLedger,
): Promise<string[]> {
  const emittedEventIds: string[] = [];
  const taskIds = await store.listTaskIds();
  for (const taskId of taskIds) {
    const result = await store.readResult(taskId);
    if (!result) continue;
    const intent = await store.readIntent(taskId);
    if (!intent || !intent.notifyOnExit) continue;
    const event = await ledger.recordTaskTerminalEvent({
      taskId,
      agentId: intent.agentId,
      workspaceId: intent.workspaceId,
      payloadRef: `tasks/${taskId}/result.json`,
    });
    if (event) emittedEventIds.push(event.eventId);
  }
  return emittedEventIds;
}
