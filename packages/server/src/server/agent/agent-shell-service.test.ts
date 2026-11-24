import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentShellContextEntry } from "@getpaseo/protocol/messages";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  AgentShellBusyError,
  AgentShellInvalidRequestError,
  AgentShellService,
  MAX_SHELL_CONTEXT_ENTRIES,
  buildPendingShellTextAttachment,
  extractCommandOutput,
  formatShellCommandInput,
  formatShellDisplayOutput,
  truncateShellContextOutput,
} from "./agent-shell-service.js";

function createFakeTerminal(params: {
  id: string;
  cwd: string;
  workspaceId: string;
  name: string;
}) {
  const sentInputs: string[] = [];
  const finishListeners = new Set<(info: { exitCode: number | null }) => void>();
  const exitListeners = new Set<(info: { exitCode: number | null; signal?: number }) => void>();
  let lines: string[] = ["~/repo % "];
  let exitInfo: { exitCode: number | null; signal?: number } | null = null;

  const session: TerminalSession = {
    id: params.id,
    name: params.name,
    cwd: params.cwd,
    workspaceId: params.workspaceId,
    send(msg) {
      if (msg.type === "input") {
        sentInputs.push(msg.data);
      }
    },
    subscribe: () => () => undefined,
    onCommandFinished(listener) {
      finishListeners.add(listener);
      return () => finishListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onTitleChange: () => () => undefined,
    onActivityChange: () => () => undefined,
    getSize: () => ({ rows: 24, cols: 80 }),
    hasOutput: () => lines.length > 0,
    getReplayPreamble: () => "",
    getTitle: () => undefined,
    getActivity: () => null,
    setActivity: () => undefined,
    clearActivityAttention: () => false,
    setTitle: () => undefined,
    getExitInfo: () => exitInfo,
    kill: () => {
      exitInfo = { exitCode: 0 };
      for (const listener of exitListeners) {
        listener(exitInfo);
      }
    },
    killAndWait: async () => undefined,
  };

  return {
    session,
    sentInputs,
    setLines(nextLines: string[]) {
      lines = nextLines;
    },
    getLines() {
      return lines;
    },
    emitCommandFinished(exitCode: number | null) {
      for (const listener of finishListeners) {
        listener({ exitCode });
      }
    },
    emitExit(info: { exitCode: number | null; signal?: number }) {
      exitInfo = info;
      for (const listener of exitListeners) {
        listener(info);
      }
    },
  };
}

function createHarness() {
  const terminals = new Map<string, ReturnType<typeof createFakeTerminal>>();
  let nextTermSeq = 1;
  const timelineUpdates: Array<{ agentId: string; item: AgentTimelineItem; timestamp?: string }> =
    [];

  const agentState: {
    id: string;
    cwd: string;
    workspaceId: string;
    lifecycle: "idle" | "running" | "closed";
    internal: boolean;
    config: { title: string | null };
    shellTerminalId?: string;
    pendingShellContext?: AgentShellContextEntry[];
  } = {
    id: "agent-1",
    cwd: "/repo",
    workspaceId: "ws-1",
    lifecycle: "idle",
    internal: false,
    config: { title: "Fix Tests" },
  };

  const agentManager = {
    getAgent: (id: string) =>
      id === agentState.id ? (agentState as unknown as ManagedAgent) : undefined,
    listAgents: () => [agentState as unknown as ManagedAgent],
    setShellTerminalId: vi.fn(async (_agentId: string, terminalId: string) => {
      agentState.shellTerminalId = terminalId;
    }),
    getPendingShellContext: vi.fn(() => [...(agentState.pendingShellContext ?? [])]),
    updatePendingShellContext: vi.fn(
      async (_agentId: string, next: readonly AgentShellContextEntry[] | undefined) => {
        agentState.pendingShellContext = next?.length ? [...next] : undefined;
        return [...(agentState.pendingShellContext ?? [])];
      },
    ),
    upsertUserShellTimelineItem: vi.fn(
      async (
        agentId: string,
        item: Extract<AgentTimelineItem, { type: "tool_call" }>,
        options?: { timestamp?: string },
      ) => {
        timelineUpdates.push({ agentId, item, timestamp: options?.timestamp });
        return { seq: timelineUpdates.length, epoch: "e1", timestamp: options?.timestamp ?? "" };
      },
    ),
  };

  const terminalManager = {
    getTerminal: (id: string) => terminals.get(id)?.session,
    createTerminal: vi.fn(async (opts: { cwd: string; workspaceId: string; name?: string }) => {
      const id = `term-${nextTermSeq++}`;
      const fake = createFakeTerminal({
        id,
        cwd: opts.cwd,
        workspaceId: opts.workspaceId,
        name: opts.name ?? "shell",
      });
      terminals.set(id, fake);
      return fake.session;
    }),
    captureTerminal: vi.fn(async (id: string) => {
      const fake = terminals.get(id);
      const lines = fake ? fake.getLines() : [];
      return { lines, totalLines: lines.length };
    }),
  } as unknown as TerminalManager;

  const isBusyMock = vi.fn(() => false);
  const service = new AgentShellService({
    agentManager,
    terminalManager,
    logger: pino({ level: "silent" }),
    isTerminalBusyByOther: isBusyMock,
  });

  return {
    service,
    agentState,
    terminals,
    timelineUpdates,
    agentManager,
    terminalManager,
    isBusyMock,
  };
}

describe("agent-shell-service helpers", () => {
  it("formats single-line and multi-line commands with Ctrl-U clear line", () => {
    expect(formatShellCommandInput("git status\n")).toEqual({
      input: "\x15git status\r",
      isWrapped: false,
      normalizedCommand: "git status",
    });

    expect(formatShellCommandInput("cd packages/server\r\nnpm test\n")).toEqual({
      input: "\x15{\ncd packages/server\nnpm test\n}\r",
      isWrapped: true,
      normalizedCommand: "cd packages/server\nnpm test",
    });
  });

  it("extracts single-line and multi-line command output cleanly", () => {
    const single = extractCommandOutput({
      baselineLines: ["prev output", "~/repo % "],
      afterLines: ["prev output", "~/repo % echo hello", "hello", "100%"],
      command: "echo hello",
      isWrapped: false,
    });
    expect(single).toBe("hello\n100%");

    const multi = extractCommandOutput({
      baselineLines: ["~/repo % "],
      afterLines: ["~/repo % {", "brace> cd src", "brace> ls", "}", "index.ts", "~/repo % "],
      command: "cd src\nls",
      isWrapped: true,
      stripTrailingPrompt: true,
    });
    expect(multi).toBe("index.ts");
  });

  it("truncates card display output to last 200 lines", () => {
    const input = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`).join("\n");
    const formatted = formatShellDisplayOutput(input);
    expect(formatted.startsWith("...(showing last 200 lines)\n")).toBe(true);
    expect(formatted).toContain("line-6");
    expect(formatted).not.toContain("line-5\n");
    expect(formatted.endsWith("line-205")).toBe(true);
  });

  it("truncates context entry output to 8KB on UTF-8 line boundaries", () => {
    const line = "测试内容-1234567890-abcdef";
    const big = Array.from({ length: 500 }, () => line).join("\n");
    const result = truncateShellContextOutput(big, 8 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(8 * 1024);
    expect(result.output.startsWith("[...earlier output truncated...]\n")).toBe(true);
    expect(result.output.endsWith(line)).toBe(true);
  });

  it("builds a single user_shell_commands attachment capped at 32KB keeping newest entries", () => {
    const bigChunk = "x".repeat(7500);
    const entries: AgentShellContextEntry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `cmd-${i}`,
      command: `run-${i}`,
      cwd: "/repo",
      exitCode: 0,
      output: bigChunk,
      outputBytes: Buffer.byteLength(bigChunk, "utf8"),
      completedAt: `2026-11-23T00:00:0${i}Z`,
      terminalId: "term-1",
    }));

    const built = buildPendingShellTextAttachment(entries, 32 * 1024);
    expect(built).not.toBeNull();
    expect(built!.attachment.contextKind).toBe("user_shell_commands");
    expect(Buffer.byteLength(built!.attachment.text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(built!.attachedIds).toEqual(["cmd-2", "cmd-3", "cmd-4", "cmd-5"]);
  });
});

describe("AgentShellService", () => {
  it("creates and reuses a dedicated terminal, runs command, and queues pending context", async () => {
    const h = createHarness();
    const run = await h.service.runCommand({ agentId: "agent-1", command: "git status" });

    expect(run.terminalId).toBe("term-1");
    expect(h.service.isDedicatedShellTerminal("term-1")).toBe(true);
    expect(h.service.isTerminalBusy("term-1")).toBe(true);
    expect(h.agentState.shellTerminalId).toBe("term-1");
    expect(h.terminals.get("term-1")?.session.name).toBe("Fix Tests · shell");
    expect(h.terminals.get("term-1")?.sentInputs).toEqual(["\x15git status\r"]);
    expect(h.timelineUpdates).toHaveLength(1);
    expect(h.timelineUpdates[0]!.item).toMatchObject({
      type: "tool_call",
      status: "running",
      detail: {
        type: "shell",
        command: "git status",
        origin: "user",
        terminalId: "term-1",
      },
    });

    // Reject concurrent run
    await expect(
      h.service.runCommand({ agentId: "agent-1", command: "ls" }),
    ).rejects.toBeInstanceOf(AgentShellBusyError);

    h.terminals.get("term-1")!.setLines(["~/repo % git status", "On branch main"]);
    h.terminals.get("term-1")!.emitCommandFinished(0);
    await vi.waitFor(() => expect(h.timelineUpdates).toHaveLength(2));

    expect(h.service.isTerminalBusy("term-1")).toBe(false);
    expect(h.timelineUpdates[1]!.item).toMatchObject({
      type: "tool_call",
      callId: run.callId,
      status: "completed",
      detail: {
        type: "shell",
        command: "git status",
        output: "On branch main",
        exitCode: 0,
        origin: "user",
        terminalId: "term-1",
      },
    });
    expect(h.agentState.pendingShellContext).toHaveLength(1);
    expect(h.agentState.pendingShellContext![0]).toMatchObject({
      id: run.callId,
      command: "git status",
      exitCode: 0,
      output: "On branch main",
    });

    // Second command reuses same terminal
    const run2 = await h.service.runCommand({ agentId: "agent-1", command: "ls" });
    expect(run2.terminalId).toBe("term-1");
    h.terminals.get("term-1")!.emitCommandFinished(2);
    await vi.waitFor(() => expect(h.agentState.pendingShellContext).toHaveLength(2));
    expect(h.timelineUpdates[3]!.item).toMatchObject({
      status: "failed",
      detail: { exitCode: 2 },
    });
  });

  it("supports manual completion and context removal/consume", async () => {
    const h = createHarness();
    const run = await h.service.runCommand({ agentId: "agent-1", command: "sh -c 'echo ok'" });
    h.terminals.get("term-1")!.setLines(["~/repo % sh -c 'echo ok'", "ok", "~/repo % "]);

    const finished = await h.service.finishCommand({ agentId: "agent-1", callId: run.callId });
    expect(finished.status).toBe("completed");
    expect(finished.exitCode).toBeNull();
    expect(finished.entry.output).toBe("ok");

    // Seed extra entries beyond 20 limit via direct runs / context
    const remaining = await h.service.updatePendingContext({
      agentId: "agent-1",
      remove: [run.callId],
    });
    expect(remaining).toEqual([]);
  });

  it("caps pendingShellContext at 20 entries and recreates exited dedicated terminal", async () => {
    const h = createHarness();
    const run1 = await h.service.runCommand({ agentId: "agent-1", command: "echo 1" });
    h.terminals.get("term-1")!.emitExit({ exitCode: 1 });
    await vi.waitFor(() => expect(h.agentState.pendingShellContext).toHaveLength(1));

    // Populate 20 entries directly to test 20 cap on finish
    h.agentState.pendingShellContext = Array.from(
      { length: MAX_SHELL_CONTEXT_ENTRIES },
      (_, i) => ({
        id: `old-${i}`,
        command: `cmd-${i}`,
        cwd: "/repo",
        exitCode: 0,
        output: "",
        outputBytes: 0,
        completedAt: "2026-11-23T00:00:00Z",
        terminalId: "term-1",
      }),
    );

    const run2 = await h.service.runCommand({ agentId: "agent-1", command: "echo 2" });
    expect(run2.terminalId).toBe("term-2");
    h.terminals.get("term-2")!.emitCommandFinished(0);
    const hasRun2Entry = () =>
      Boolean(h.agentState.pendingShellContext?.some((entry) => entry.id === run2.callId));
    await vi.waitFor(() => expect(hasRun2Entry()).toBe(true));
    expect(h.agentState.pendingShellContext).toHaveLength(20);
    expect(h.agentState.pendingShellContext![0]!.id).toBe("old-1");
    expect(h.agentState.pendingShellContext![19]!.id).toBe(run2.callId);

    // Consuming only specific IDs leaves others intact
    const afterConsume = await h.service.consumePendingContextIds("agent-1", [
      "old-1",
      run2.callId,
    ]);
    expect(afterConsume.map((e) => e.id)).not.toContain("old-1");
    expect(afterConsume.map((e) => e.id)).not.toContain(run2.callId);
    expect(afterConsume).toHaveLength(18);
    expect(run1.callId).not.toBe(run2.callId);
  });

  it("rejects empty commands and busy terminals", async () => {
    const h = createHarness();
    await expect(
      h.service.runCommand({ agentId: "agent-1", command: "   \n  " }),
    ).rejects.toBeInstanceOf(AgentShellInvalidRequestError);

    h.isBusyMock.mockReturnValue(true);
    await expect(
      h.service.runCommand({ agentId: "agent-1", command: "pwd" }),
    ).rejects.toBeInstanceOf(AgentShellBusyError);
  });
});
