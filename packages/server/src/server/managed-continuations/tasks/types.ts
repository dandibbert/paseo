import { z } from "zod";

export const MAX_TASK_COMMAND_BYTES = 16 * 1024;
export const MAX_TASK_NAME_BYTES = 128;
export const MAX_COMPLETION_CONTEXT_BYTES = 4 * 1024;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 7200;
export const MIN_TASK_TIMEOUT_SECONDS = 5;
export const MAX_TASK_TIMEOUT_SECONDS = 86_400;
export const DEFAULT_DRAIN_GRACE_MS = 1000;
export const MAX_TASK_LOG_BYTES = 32 * 1024 * 1024; // 32 MiB
export const DEFAULT_RESULT_TAIL_BYTES = 4 * 1024; // 4 KiB
export const DEFAULT_OUTPUT_MAX_BYTES = 8192;
export const MAX_OUTPUT_READ_BYTES = 65_536;
export const DEFAULT_MAX_HOST_CONCURRENT_TASKS = 8;
export const DEFAULT_MAX_AGENT_CONCURRENT_TASKS = 3;

export const ManagedTaskTerminalStatusSchema = z.enum([
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "spawn_failed",
  "unknown",
]);
export type ManagedTaskTerminalStatus = z.infer<typeof ManagedTaskTerminalStatusSchema>;

/** Daemon-only file: `tasks/<taskId>/intent.json` */
export const TaskIntentSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  invocationId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  command: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  timeoutSeconds: z.number().int().min(MIN_TASK_TIMEOUT_SECONDS).max(MAX_TASK_TIMEOUT_SECONDS),
  notifyOnExit: z.boolean(),
  completionContext: z.string().optional(),
  acceptedAt: z.string().min(1),
  deadlineAt: z.string().min(1),
});
export type TaskIntent = z.infer<typeof TaskIntentSchema>;

/** Daemon-only file: `tasks/<taskId>/cancel.json` */
export const TaskCancelRequestSchema = z.object({
  taskId: z.string().min(1),
  requestedAt: z.string().min(1),
  reason: z.string().min(1),
  requestedBy: z.enum(["user", "agent", "authorization_revoked", "archive", "daemon_stop"]),
});
export type TaskCancelRequest = z.infer<typeof TaskCancelRequestSchema>;

/** Worker-only file: `tasks/<taskId>/runner.json` */
export const TaskRunnerRecordSchema = z.object({
  taskId: z.string().min(1),
  workerInstanceId: z.string().min(1),
  pid: z.number().int().positive().nullable(),
  pgid: z.number().int().positive().nullable(),
  bootId: z.string().min(1),
  startedAt: z.string().min(1),
  state: z.enum(["claiming", "running", "exited"]),
});
export type TaskRunnerRecord = z.infer<typeof TaskRunnerRecordSchema>;

/** Worker-only file: `tasks/<taskId>/result.json` (single atomic terminal commit) */
export const TaskResultRecordSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  status: ManagedTaskTerminalStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  streamDrainTruncated: z.boolean(),
  bytesDiscardedStdout: z.number().int().nonnegative(),
  bytesDiscardedStderr: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type TaskResultRecord = z.infer<typeof TaskResultRecordSchema>;

/** Worker-only file: `task-worker/<workerInstanceId>.json` */
export const TaskWorkerInstanceSchema = z.object({
  workerInstanceId: z.string().min(1),
  pid: z.number().int().positive(),
  bootId: z.string().min(1),
  version: z.string().min(1),
  state: z.enum(["current", "draining", "stopped"]),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TaskWorkerInstance = z.infer<typeof TaskWorkerInstanceSchema>;

export interface ReadTaskOutputInput {
  taskId: string;
  callerAgentId: string;
  callerWorkspaceId?: string;
  stream: "stdout" | "stderr";
  cursor?: string;
  tailBytes?: number;
  maxBytes?: number;
}

export interface ReadTaskOutputResult {
  taskId: string;
  stream: "stdout" | "stderr";
  text: string;
  startByte: number;
  endByte: number;
  nextCursor?: string;
  truncated: boolean;
  bytesDiscarded: number;
}
