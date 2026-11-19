import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { assertSafeServerId, sha256Hex } from "../codec.js";
import {
  TaskCancelRequestSchema,
  TaskIntentSchema,
  TaskResultRecordSchema,
  TaskRunnerRecordSchema,
  TaskWorkerInstanceSchema,
  type TaskCancelRequest,
  type TaskIntent,
  type TaskResultRecord,
  type TaskRunnerRecord,
  type TaskWorkerInstance,
} from "./types.js";

export class TaskPathSecurityError extends Error {
  readonly code = "TASK_PATH_SECURITY_VIOLATION";
}

export class TaskClaimConflictError extends Error {
  readonly code = "TASK_ALREADY_CLAIMED";
}

/**
 * Single-writer durable store for `$PASEO_HOME/managed-continuations/tasks/` and `task-worker/`.
 *
 * Ownership discipline (Spec v0.4.1 §5.3):
 * - Daemon-only files: `intent.json`, `cancel.json`
 * - Worker-only files: `runner.json`, `stdout.log`, `stderr.log`, `result.json`, `task-worker/*.json`
 */
export class ManagedTaskStore {
  readonly baseDir: string;
  readonly tasksDir: string;
  readonly workersDir: string;

  constructor(paseoHomeDir: string) {
    this.baseDir = path.join(path.resolve(paseoHomeDir), "managed-continuations");
    this.tasksDir = path.join(this.baseDir, "tasks");
    this.workersDir = path.join(this.baseDir, "task-worker");
  }

  async ensureLayout(): Promise<void> {
    for (const dir of [this.baseDir, this.tasksDir, this.workersDir]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this.assertNoSymlink(dir);
    }
  }

  taskDir(taskId: string): string {
    assertSafeServerId(taskId, "taskId");
    return path.join(this.tasksDir, taskId);
  }

  intentPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "intent.json");
  }

  cancelPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "cancel.json");
  }

  runnerPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "runner.json");
  }

  resultPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "result.json");
  }

  logPath(taskId: string, stream: "stdout" | "stderr"): string {
    return path.join(this.taskDir(taskId), `${stream}.log`);
  }

  workerPath(workerInstanceId: string): string {
    assertSafeServerId(workerInstanceId, "workerInstanceId");
    return path.join(this.workersDir, `${workerInstanceId}.json`);
  }

  async ensureTaskDir(taskId: string): Promise<string> {
    await this.ensureLayout();
    const dir = this.taskDir(taskId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.assertNoSymlink(dir);
    return dir;
  }

  // --- Daemon-only writers ---

  async writeIntent(intent: TaskIntent): Promise<void> {
    const parsed = TaskIntentSchema.parse(intent);
    await this.ensureTaskDir(parsed.taskId);
    await this.writeJsonAtomic0600(this.intentPath(parsed.taskId), parsed);
  }

  async readIntent(taskId: string): Promise<TaskIntent | null> {
    return this.readJsonValidated(this.intentPath(taskId), TaskIntentSchema);
  }

  async writeCancelRequest(cancel: TaskCancelRequest): Promise<void> {
    const parsed = TaskCancelRequestSchema.parse(cancel);
    await this.ensureTaskDir(parsed.taskId);
    await this.writeJsonAtomic0600(this.cancelPath(parsed.taskId), parsed);
  }

  async readCancelRequest(taskId: string): Promise<TaskCancelRequest | null> {
    return this.readJsonValidated(this.cancelPath(taskId), TaskCancelRequestSchema);
  }

  // --- Worker-only writers ---

  /**
   * Atomically claims a task using `wx` exclusive creation of `runner.json` so two workers
   * or a restart can NEVER double-spawn the same `taskId`.
   */
  async claimTaskExclusive(record: TaskRunnerRecord): Promise<void> {
    const parsed = TaskRunnerRecordSchema.parse(record);
    await this.ensureTaskDir(parsed.taskId);
    const target = this.runnerPath(parsed.taskId);
    await this.assertNoSymlink(target);
    const payload = JSON.stringify(parsed, null, 2);
    try {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new TaskClaimConflictError(`Task ${parsed.taskId} has already been claimed`);
      }
      throw error;
    }
  }

  async updateRunner(record: TaskRunnerRecord): Promise<void> {
    const parsed = TaskRunnerRecordSchema.parse(record);
    await this.writeJsonAtomic0600(this.runnerPath(parsed.taskId), parsed);
  }

  async readRunner(taskId: string): Promise<TaskRunnerRecord | null> {
    return this.readJsonValidated(this.runnerPath(taskId), TaskRunnerRecordSchema);
  }

  /** Single atomic terminal commit for `result.json` (never overwritten once committed). */
  async commitResultOnce(result: TaskResultRecord): Promise<boolean> {
    const parsed = TaskResultRecordSchema.parse(result);
    const existing = await this.readResult(parsed.taskId);
    if (existing) return false;
    await this.ensureTaskDir(parsed.taskId);
    await this.writeJsonAtomic0600(this.resultPath(parsed.taskId), parsed);
    return true;
  }

  async readResult(taskId: string): Promise<TaskResultRecord | null> {
    return this.readJsonValidated(this.resultPath(taskId), TaskResultRecordSchema);
  }

  async writeWorkerInstance(instance: TaskWorkerInstance): Promise<void> {
    const parsed = TaskWorkerInstanceSchema.parse(instance);
    await this.ensureLayout();
    await this.writeJsonAtomic0600(this.workerPath(parsed.workerInstanceId), parsed);
  }

  async listWorkerInstances(): Promise<TaskWorkerInstance[]> {
    let entries: string[];
    try {
      await this.assertNoSymlink(this.workersDir);
      entries = await fs.readdir(this.workersDir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const results: TaskWorkerInstance[] = [];
    for (const name of entries.sort()) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = await this.readJsonValidated(
        path.join(this.workersDir, name),
        TaskWorkerInstanceSchema,
      );
      if (parsed) results.push(parsed);
    }
    return results;
  }

  async listTaskIds(): Promise<string[]> {
    let entries: string[];
    try {
      await this.assertNoSymlink(this.tasksDir);
      entries = await fs.readdir(this.tasksDir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return entries.filter((name) => !name.startsWith(".")).sort();
  }

  async assertNoSymlink(targetPath: string): Promise<void> {
    try {
      const stat = await fs.lstat(targetPath);
      if (stat.isSymbolicLink()) {
        throw new TaskPathSecurityError(
          `Symlink rejected inside managed task private tree: ${targetPath}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async writeJsonAtomic0600(targetPath: string, value: unknown): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.assertNoSymlink(dir);
    await this.assertNoSymlink(targetPath);

    const payload = JSON.stringify(value, null, 2);
    const tempPath = path.join(
      dir,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readJsonValidated<T>(targetPath: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      await this.assertNoSymlink(targetPath);
      const raw = await fs.readFile(targetPath, "utf8");
      return schema.parse(JSON.parse(raw));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

/**
 * Validates `cwd` using `fs.realpath()` against allowed workspace roots.
 * Correctly handles macOS `/tmp -> /private/tmp` and `/var -> /private/var` by resolving
 * BOTH the candidate `cwd` and each allowed root via `realpath()`.
 */
export async function validateTaskCwdWithinRoots(
  cwd: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!cwd || cwd.includes("\0")) {
    throw new TaskPathSecurityError("Invalid task cwd");
  }
  const realCwd = await fs.realpath(cwd);
  const stat = await fs.stat(realCwd);
  if (!stat.isDirectory()) {
    throw new TaskPathSecurityError(`Task cwd is not a directory: ${cwd}`);
  }
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (realCwd === realRoot || realCwd.startsWith(`${realRoot}${path.sep}`)) {
      return realCwd;
    }
  }
  throw new TaskPathSecurityError(`Task cwd escapes allowed workspace roots: ${cwd}`);
}

export function computeTaskFingerprint(input: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  notifyOnExit: boolean;
}): string {
  return sha256Hex(
    JSON.stringify({
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
      notifyOnExit: input.notifyOnExit,
    }),
  );
}
