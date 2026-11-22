import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvocationConflictError,
  ManagedContinuationLedger,
  ManagedContinuationStore,
  ManagedTaskStore,
  ManagedTaskWorker,
  PlatformUnsupportedError,
  TaskAccessDeniedError,
  TaskClaimConflictError,
  TaskOutputQueryError,
  TaskPathSecurityError,
  buildSanitizedTaskEnv,
  readManagedTaskOutput,
  reconcileOrphanTasks,
  reconcileTaskResultsToLedger,
  submitTaskIntent,
  type RunIdentity,
} from "../index.js";

// Managed background commands run on macOS and Linux only; Windows refuses them by design.
describe.skipIf(process.platform === "win32")(
  "Managed Continuations PR B — Non-PTY ManagedTaskWorker & Durable Results",
  () => {
    let tmpHome: string;
    let workspaceDir: string;

    beforeEach(async () => {
      tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-b-home-"));
      workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-b-ws-"));
    });

    afterEach(async () => {
      await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("runs a non-PTY command, separates stdout/stderr, strips Paseo secrets, and reconciles result.json into Ledger WakeEvent", async () => {
      const taskStore = new ManagedTaskStore(tmpHome);
      const ledgerStore = new ManagedContinuationStore(tmpHome);
      const ledger = new ManagedContinuationLedger({
        store: ledgerStore,
        daemonInstanceId: "daemon-b-1",
      });
      const origin: RunIdentity = { daemonInstanceId: "daemon-b-1", runToken: "origin-b-1" };

      await ledger.registerTaskLease({
        leaseId: "lease_b1",
        taskId: "task_b1",
        agentId: "agent-b",
        workspaceId: "ws-b",
        origin,
      });

      const sanitized = buildSanitizedTaskEnv({
        PATH: "/usr/bin:/bin",
        PASEO_AUTH_TOKEN: "top-secret-token",
        PASEO_MCP_TOKEN: "mcp-secret",
        SAFE_VAR: "ok",
      });
      expect(sanitized.PASEO_AUTH_TOKEN).toBeUndefined();
      expect(sanitized.PASEO_MCP_TOKEN).toBeUndefined();
      expect(sanitized.GIT_TERMINAL_PROMPT).toBe("0");
      expect(sanitized.SAFE_VAR).toBe("ok");

      await submitTaskIntent(taskStore, {
        taskId: "task_b1",
        agentId: "agent-b",
        workspaceId: "ws-b",
        invocationId: "inv_1",
        command: "echo BUILD_OUT; echo BUILD_FAILED >&2; exit 2",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        timeoutSeconds: 30,
        notifyOnExit: true,
      });

      const worker = new ManagedTaskWorker({ store: taskStore, bootId: "boot-1" });
      await worker.start();
      const { done } = await worker.startTask("task_b1");
      const result = await done;

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(2);
      expect(result.stdoutTail).toContain("BUILD_OUT");
      expect(result.stderrTail).toContain("BUILD_FAILED");
      expect(result.streamDrainTruncated).toBe(false);

      const emitted = await reconcileTaskResultsToLedger(taskStore, ledger);
      expect(emitted).toEqual(["task:task_b1:terminal"]);
      const storedEvent = await ledgerStore.readEvent("task:task_b1:terminal");
      expect(storedEvent).not.toBeNull();
      expect(storedEvent!.state).toBe("pending");
    });

    it("does not hang on grandchild-inherited stdio pipes and records exitCode + streamDrainTruncated without misclassifying as timed_out", async () => {
      const taskStore = new ManagedTaskStore(tmpHome);
      await submitTaskIntent(taskStore, {
        taskId: "task_pipe",
        agentId: "agent-b",
        workspaceId: "ws-b",
        invocationId: "inv_pipe",
        command: "(sleep 5) & echo DIRECT_DONE; exit 0",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        timeoutSeconds: 30,
        notifyOnExit: false,
      });

      const worker = new ManagedTaskWorker({
        store: taskStore,
        bootId: "boot-1",
        drainGraceMs: 250,
      });
      await worker.start();
      const startMs = Date.now();
      const { done } = await worker.startTask("task_pipe");
      const result = await done;
      const elapsedMs = Date.now() - startMs;

      expect(elapsedMs).toBeLessThan(3000);
      expect(result.status).toBe("succeeded");
      expect(result.exitCode).toBe(0);
      expect(result.streamDrainTruncated).toBe(true);
      expect(result.stdoutTail).toContain("DIRECT_DONE");
    });

    it("prevents double-spawn via exclusive claim, supports cancel + draining lifecycle, and marks boot-mismatched orphan tasks as unknown", async () => {
      const taskStore = new ManagedTaskStore(tmpHome);
      await submitTaskIntent(taskStore, {
        taskId: "task_cancel",
        agentId: "agent-b",
        workspaceId: "ws-b",
        invocationId: "inv_cancel",
        command: "sleep 30",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        timeoutSeconds: 60,
        notifyOnExit: false,
      });

      const worker = new ManagedTaskWorker({
        store: taskStore,
        bootId: "boot-1",
        killGraceMs: 100,
      });
      await worker.start();
      const { done } = await worker.startTask("task_cancel");

      await expect(worker.startTask("task_cancel")).rejects.toThrow(TaskClaimConflictError);

      await worker.beginDraining();
      expect(worker.getState()).toBe("draining");

      const canceled = await worker.cancelTask("task_cancel", {
        taskId: "task_cancel",
        requestedAt: new Date().toISOString(),
        reason: "user_requested",
        requestedBy: "user",
      });
      expect(canceled).toBe(true);
      const result = await done;
      expect(result.status).toBe("canceled");
      expect(worker.getState()).toBe("stopped");

      await submitTaskIntent(taskStore, {
        taskId: "task_orphan",
        agentId: "agent-b",
        workspaceId: "ws-b",
        invocationId: "inv_orphan",
        command: "echo never-respawn",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        timeoutSeconds: 60,
        notifyOnExit: true,
      });
      await taskStore.claimTaskExclusive({
        taskId: "task_orphan",
        workerInstanceId: "wk_old",
        pid: 999999,
        pgid: 999999,
        bootId: "boot-old",
        startedAt: new Date().toISOString(),
        state: "running",
      });

      const unknowns = await reconcileOrphanTasks(taskStore, "boot-new", () => false);
      expect(unknowns).toEqual(["task_orphan"]);
      const orphanResult = await taskStore.readResult("task_orphan");
      expect(orphanResult!.status).toBe("unknown");
      expect(orphanResult!.error).toBe("host_reboot_boot_id_mismatch");
    });

    it("enforces UTF-8 boundary-safe cursor/tail pagination and task ownership isolation", async () => {
      const taskStore = new ManagedTaskStore(tmpHome);
      await submitTaskIntent(taskStore, {
        taskId: "task_utf8",
        agentId: "agent-owner",
        workspaceId: "ws-1",
        invocationId: "inv_utf8",
        command: "printf '你好世界🚀测试输出'",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        timeoutSeconds: 30,
        notifyOnExit: false,
      });

      const worker = new ManagedTaskWorker({ store: taskStore, bootId: "boot-1" });
      await worker.start();
      const { done } = await worker.startTask("task_utf8");
      await done;

      await expect(
        readManagedTaskOutput(taskStore, {
          taskId: "task_utf8",
          callerAgentId: "agent-other",
          stream: "stdout",
        }),
      ).rejects.toThrow(TaskAccessDeniedError);

      await expect(
        readManagedTaskOutput(taskStore, {
          taskId: "task_utf8",
          callerAgentId: "agent-owner",
          stream: "stdout",
          cursor: "0",
          tailBytes: 10,
        }),
      ).rejects.toThrow(TaskOutputQueryError);

      const tail = await readManagedTaskOutput(taskStore, {
        taskId: "task_utf8",
        callerAgentId: "agent-owner",
        stream: "stdout",
        tailBytes: 8,
      });
      expect(tail.text.includes("\uFFFD")).toBe(false);
      expect(tail.text.length).toBeGreaterThan(0);

      const page1 = await readManagedTaskOutput(taskStore, {
        taskId: "task_utf8",
        callerAgentId: "agent-owner",
        stream: "stdout",
        cursor: "0",
        maxBytes: 7,
      });
      expect(page1.text.includes("\uFFFD")).toBe(false);
      expect(page1.nextCursor).toBeDefined();
    });

    it("enforces Windows fail-closed gate, cwd realpath containment, symlink rejection, and invocation fingerprint conflict", async () => {
      const taskStore = new ManagedTaskStore(tmpHome);

      await expect(
        submitTaskIntent(taskStore, {
          taskId: "task_win",
          agentId: "agent-1",
          workspaceId: "ws-1",
          invocationId: "inv_win",
          command: "echo hi",
          cwd: workspaceDir,
          allowedWorkspaceRoots: [workspaceDir],
          platform: "win32",
        }),
      ).rejects.toThrow(PlatformUnsupportedError);

      await expect(
        submitTaskIntent(taskStore, {
          taskId: "task_escape",
          agentId: "agent-1",
          workspaceId: "ws-1",
          invocationId: "inv_escape",
          command: "echo hi",
          cwd: tmpHome,
          allowedWorkspaceRoots: [workspaceDir],
        }),
      ).rejects.toThrow(TaskPathSecurityError);

      const first = await submitTaskIntent(taskStore, {
        taskId: "task_dedup",
        agentId: "agent-1",
        workspaceId: "ws-1",
        invocationId: "inv_same",
        command: "echo v1",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
      });
      const same = await submitTaskIntent(taskStore, {
        taskId: "task_dedup_2",
        agentId: "agent-1",
        workspaceId: "ws-1",
        invocationId: "inv_same",
        command: "echo v1",
        cwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
      });
      expect(same.taskId).toBe(first.taskId);

      await expect(
        submitTaskIntent(taskStore, {
          taskId: "task_dedup_3",
          agentId: "agent-1",
          workspaceId: "ws-1",
          invocationId: "inv_same",
          command: "echo v2-different",
          cwd: workspaceDir,
          allowedWorkspaceRoots: [workspaceDir],
        }),
      ).rejects.toThrow(InvocationConflictError);
    });
  },
);
