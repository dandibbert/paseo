import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { formatAgentMessage } from "../agent/agent-messages/envelope.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import {
  DEFAULT_MANAGED_SHELL_POLICY,
  ManagedContinuationsRuntime,
  registerManagedContinuationTools,
  type ContinuationCheckpointEvent,
  type ManagedToolCallerContext,
  type RunIdentity,
} from "./index.js";

interface RegisteredEntry {
  config: PaseoToolConfig;
  handler: (
    input: Record<string, unknown>,
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>;
}

describe("Managed Continuations PR D — Protocol Capabilities, Runtime Lifecycle & 8 Tool Registration", () => {
  let tmpHome: string;
  let workspaceDir: string;
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-d-home-"));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-mc-d-ws-"));
    nowMs = Date.parse("2026-11-19T12:00:01.000Z");
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("keeps ServerInfoStatusPayloadSchema backward-compatible with optional managedContinuations and managedTasks flags", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-legacy",
    });
    expect(legacy.features).toBeUndefined();

    const modern = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-modern",
      features: {
        managedContinuations: true,
        managedTasks: false,
      },
    });
    expect(modern.features?.managedContinuations).toBe(true);
    expect(modern.features?.managedTasks).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "runs ordered runtime startup/shutdown and registers all 8 Agent Tools with default-deny policy enforcement",
    async () => {
      const checkpoints: ContinuationCheckpointEvent[] = [];
      const runtime = new ManagedContinuationsRuntime({
        paseoHome: tmpHome,
        daemonInstanceId: "daemon-d-1",
        bootId: "boot-d-1",
        clock,
        reconcileIntervalMs: 0,
        agentManager: {
          tryReserveManagedWake: async () => ({ status: "busy" }),
          commitManagedWake: async () => {
            throw new Error("unused in tool registration test");
          },
          releaseManagedWake: async () => undefined,
          emitContinuationCheckpoint: (cp) => checkpoints.push(cp),
        },
      });

      let barrierCalled = false;
      const startup = await runtime.start({
        restartRecoveryBarrier: async () => {
          barrierCalled = true;
        },
        receiptProbe: () => ({ status: "not_submitted" }),
      });
      expect(barrierCalled).toBe(true);
      expect(startup.reconcileReport.corruptRecords).toHaveLength(0);

      const origin: RunIdentity = { daemonInstanceId: "daemon-d-1", runToken: "origin-d-1" };
      let shellAuthorized = false;
      const resolveCallerContext = async (): Promise<ManagedToolCallerContext> => ({
        agentId: "agent-d",
        workspaceId: "ws-d",
        defaultCwd: workspaceDir,
        allowedWorkspaceRoots: [workspaceDir],
        originRun: origin,
        shellPolicy: shellAuthorized
          ? { hostEnabled: true, workspaceEnabled: true, profileMode: "full" }
          : DEFAULT_MANAGED_SHELL_POLICY,
        providerCapabilities: { coldSessionResume: true },
      });

      const registered = new Map<string, RegisteredEntry>();
      registerManagedContinuationTools({
        registerTool: (name, config, handler) => {
          registered.set(name, { config, handler });
        },
        toolsService: runtime.tools,
        resolveCallerContext,
      });

      expect(Array.from(registered.keys()).sort()).toEqual([
        "cancel_background_command",
        "cancel_scheduled_wakeup",
        "get_background_command",
        "list_background_commands",
        "list_scheduled_wakeups",
        "read_background_command_output",
        "run_background_command",
        "send_later",
      ]);

      // 1) Default-deny returns structured isError with HOST_SHELL_DISABLED
      const denied = await registered
        .get("run_background_command")!
        .handler({ command: "echo hello" }, {});
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain("HOST_SHELL_DISABLED");

      // 2) Authorized run_background_command + list + read + send_later + cancel_scheduled_wakeup
      shellAuthorized = true;
      const runRes = await registered
        .get("run_background_command")!
        .handler({ command: "echo PR_D_OK", timeoutSeconds: 30, notifyOnExit: false }, {});
      expect(runRes.isError).toBeUndefined();
      const taskId = (runRes.structuredContent as { taskId: string }).taskId;

      while (!(await runtime.taskStore.readResult(taskId))) {
        await new Promise((r) => setTimeout(r, 20));
      }

      const listRes = await registered.get("list_background_commands")!.handler({}, {});
      expect((listRes.structuredContent as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual(
        [taskId],
      );

      const outRes = await registered
        .get("read_background_command_output")!
        .handler({ taskId, stream: "stdout", tailBytes: 1024 }, {});
      expect((outRes.structuredContent as { text: string }).text).toContain("PR_D_OK");

      const wakeRes = await registered
        .get("send_later")!
        .handler({ prompt: "Check PR D status", afterSeconds: 60 }, {});
      expect(wakeRes.isError).toBeUndefined();
      const wakeId = (wakeRes.structuredContent as { wakeId: string }).wakeId;

      const cancelWakeRes = await registered
        .get("cancel_scheduled_wakeup")!
        .handler({ wakeId }, {});
      expect(cancelWakeRes.structuredContent).toEqual({ canceled: true, wakeId });
      expect(checkpoints.length).toBeGreaterThan(0);

      // 3) Graceful stop with killTasks: false leaves worker draining/stopped cleanly
      const stopRes = await runtime.stop({ killTasks: false });
      expect(stopRes.canceledTaskIds).toHaveLength(0);
    },
  );
  it("starts the autonomous turn budget over when a person sends the agent a message", async () => {
    let listener: ((event: AgentManagerEvent) => void) | undefined;
    const runtime = new ManagedContinuationsRuntime({
      paseoHome: tmpHome,
      daemonInstanceId: "daemon-d-budget",
      bootId: "boot-d-budget",
      clock,
      reconcileIntervalMs: 0,
      platform: "win32",
      agentManager: {
        tryReserveManagedWake: async () => ({ status: "busy" }),
        commitManagedWake: async () => {
          throw new Error("unused");
        },
        releaseManagedWake: async () => undefined,
        emitContinuationCheckpoint: () => undefined,
        subscribe: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      },
    });
    await runtime.start({
      restartRecoveryBarrier: async () => undefined,
      receiptProbe: () => ({ status: "not_submitted" }),
    });
    const accounting = await runtime.ledger.recordHumanBudgetReset("agent-budget", "seed");
    await runtime.ledgerStore.writeAccounting({ ...accounting, consecutiveAutonomousTurns: 20 });
    const said = (text: string) =>
      listener?.({
        type: "agent_stream",
        agentId: "agent-budget",
        event: { type: "timeline", provider: "codex", item: { type: "user_message", text } },
      });
    const used = async () =>
      (await runtime.ledgerStore.readAccounting("agent-budget"))?.consecutiveAutonomousTurns;

    said(
      formatAgentMessage({
        id: "msg-wake",
        source: {
          kind: "managed-continuation",
          agentId: "agent-budget",
          eventIds: ["ev-1"],
          origin: "managed-command",
        },
        text: "Task finished.",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await used()).toBe(20);

    said("keep going");
    await expect.poll(used).toBe(0);
    await runtime.stop();
  });
});
