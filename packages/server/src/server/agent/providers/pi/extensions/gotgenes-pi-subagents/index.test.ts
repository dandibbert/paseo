import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { streamPiHistory } from "../../history-mapper.js";
import {
  GOTGENES_CHILD_SESSION_MARKER,
  GOTGENES_LIFECYCLE_MARKER,
  gotgenesRuntimeBridge,
} from "./runtime-bridge.js";
import type { PiExtensionCustomMapping } from "../contract.js";

const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

function loadRuntimeBridge() {
  const listeners = new Map<string, (event: unknown, ctx?: unknown) => void>();
  const pi = {
    on: (name: string, listener: (event: unknown, ctx?: unknown) => void) =>
      listeners.set(name, listener),
    events: {
      on: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
  };
  new Function("pi", gotgenesRuntimeBridge)(pi);
  return (name: string, event: unknown, ctx?: unknown) => listeners.get(name)?.(event, ctx);
}

function publishService(
  agents: Array<{ id: string; outputFile?: string; status?: string; startedAt?: number }>,
): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = {
    listAgents: () => agents,
    getRecord: (id: string) => agents.find((agent) => agent.id === id),
  };
}

describe("@gotgenes/pi-subagents adapter", () => {
  test.each([true, false])(
    "removes a refused resume from live and replayed subagents (background=%s)",
    async (background) => {
      // The result came from 23.4.0's real AgentTool and SubagentManager after releaseSession().
      // The child session was a fake; releaseSession replaced waiting for the retention sweep.
      const fixture = readSubagentFixture(
        new URL("./fixtures/refused-resume.json", import.meta.url),
      );
      const start = fixture.events[0]!;
      if (start.type !== "tool_execution_start") throw new Error("Expected a tool start");
      start.args = { ...(start.args as object), run_in_background: background };
      const assistant = fixture.messages[0]!;
      if (assistant.role !== "assistant") throw new Error("Expected an assistant tool call");
      for (const block of assistant.content) {
        if (block.type === "toolCall") block.arguments = start.args;
      }
      const events = await verifySubagentFixture(fixture);
      const store = new ProviderSubagentStore();
      store.apply("parent", "pi", { type: "upsert", id: "previous-child", status: "completed" });
      for (const event of events) store.apply("parent", "pi", event.event);
      expect(events.map(({ event }) => event.type)).toEqual(["upsert", "remove"]);
      expect(store.list("parent")).toMatchObject([{ id: "previous-child", status: "completed" }]);
    },
  );

  test("reports a child's file after the child republishes the gotgenes service", async () => {
    const notifications: string[] = [];
    const emit = loadRuntimeBridge();
    const file = "/sessions/parent/tasks/2026-09-30_child-session.jsonl";
    try {
      publishService([{ id: "native-1", outputFile: file }]);
      emit(
        "session_start",
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      );
      // Pi loads gotgenes again inside the child, and that copy replaces the global service.
      publishService([]);
      emit("subagents:child:session-created", { sessionId: "child-session" });

      await expect.poll(() => notifications).toHaveLength(1);
      const host = createPiExtensionHost();
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { subagent_type: "Explore", prompt: "Inspect" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "background" } },
      });
      expect(host.mapRuntimeNotification(notifications[0]!)?.childSessions).toEqual([
        { id: "call-1", file },
      ]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
    }
  });

  test("accepts a live child path before or after the spawn result", () => {
    for (const early of [true, false]) {
      const host = createPiExtensionHost();
      const marker = `${GOTGENES_CHILD_SESSION_MARKER} ${JSON.stringify({ agentId: "native-1", file: "/tmp/child.jsonl" })}`;
      if (early) expect(host.mapRuntimeNotification(marker)?.subagents).toEqual([]);
      const spawn = host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { subagent_type: "Explore", prompt: "Inspect" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "background" } },
      });
      const path = early
        ? spawn?.childSessions
        : host.mapRuntimeNotification(marker)?.childSessions;
      expect(path).toEqual([{ id: "call-1", file: "/tmp/child.jsonl" }]);
    }
  });

  test("treats a subagent-update without a status field as metadata", () => {
    const host = createPiExtensionHost();
    spawnBackground(host, "call-1", "native-1");
    const update = host.mapCustomMessage({
      role: "custom",
      customType: "subagent-update",
      content: "progress",
      details: { id: "native-1", description: "Inspect", message: "progress" },
    });
    expect(update?.subagents).toEqual([{ type: "upsert", id: "call-1", description: "Inspect" }]);
  });
  test("maps captured foreground lifecycle live and on replay", async () => {
    const events = await verifySubagentFixture(
      readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url)),
    );
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toEqual(["running", "completed"]);
  });
  test("correlates a background notification and result collection", async () => {
    const source = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const file = (
      source.messages.find((message) => message.role === "custom") as {
        details: { outputFile: string };
      }
    ).details.outputFile;
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url), {
      from: file,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    expect(upserts.map((event) => event?.status)).toEqual([
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(new Set(upserts.map((event) => event?.id)).size).toBe(1);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });
  test("keeps claimed notification text in a tool row in history", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const notification = fixture.messages.find((message) => message.role === "custom");
    const text = notification?.content;
    const events = [];
    for await (const event of streamPiHistory("pi", fixture.messages)) events.push(event);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: {
        type: "tool_call",
        callId: "pi-custom-1",
        name: notification?.customType,
        status: "completed",
        detail: { type: "plain_text", text },
        metadata: {
          synthetic: true,
          customType: notification?.customType,
          details: notification?.details,
        },
        error: null,
      },
    });
    expect(events.some((event) => event.type === "provider_subagent")).toBe(true);
  });
  test("shares the subagent tool name with Nico without claiming Nico's args", () => {
    const host = createPiExtensionHost();
    const nico = host.mapToolCall({
      callId: "nico",
      toolName: "subagent",
      args: { agent: "scout", task: "Inspect" },
      status: "running",
      result: null,
    });
    const gotgenes = host.mapToolCall({
      callId: "gotgenes",
      toolName: "subagent",
      args: { subagent_type: "general-purpose", prompt: "Inspect" },
      status: "running",
      result: null,
    });
    expect(nico?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "scout" }),
    );
    expect(gotgenes?.detail).toEqual(
      expect.objectContaining({ type: "sub_agent", subAgentType: "general-purpose" }),
    );
    expect(
      host.mapToolCall({
        callId: "foreign",
        toolName: "subagent",
        args: { description: "Inspect" },
        status: "running",
        result: null,
      }),
    ).toBeUndefined();
  });

  test("completes a card from a text-only get_subagent_result report", () => {
    const host = createPiExtensionHost();
    spawnBackground(host, "call-1", "native-1");
    const text =
      "Agent: native-1\nType: Explore | Status: completed | Tool uses: 3 | Duration: 4s\n" +
      "Description: Inspect\n\nDone\n\nFull transcript available at: /tmp/child.jsonl";
    const result = host.mapToolCall({
      callId: "call-2",
      toolName: "get_subagent_result",
      args: { agent_id: "native-1" },
      status: "completed",
      result: { content: [{ type: "text", text }] },
    });
    expect(result?.subagents).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
    expect(result?.childSessions).toEqual([{ id: "call-1", file: "/tmp/child.jsonl" }]);
  });

  test("leaves the card alone when a text report names another agent", () => {
    const host = createPiExtensionHost();
    spawnBackground(host, "call-1", "native-1");
    const result = host.mapToolCall({
      callId: "call-2",
      toolName: "get_subagent_result",
      args: { agent_id: "native-1" },
      status: "completed",
      result: { content: [{ type: "text", text: 'Agent not found: "native-1".' }] },
    });
    expect(result?.subagents).toBeUndefined();
  });

  test("resume updates the original card and keeps later updates on it", () => {
    const host = createPiExtensionHost();
    spawnBackground(host, "call-1", "native-1");
    const resumeArgs = { subagent_type: "Explore", prompt: "Continue", resume: "native-1" };
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "subagent",
        args: resumeArgs,
        status: "running",
        result: null,
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "call-1", status: "running" }]);
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "subagent",
        args: resumeArgs,
        status: "completed",
        result: { details: { agentId: "native-1", status: "completed" } },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "subagent-notification",
        content: "done",
        details: { id: "native-1", status: "completed" },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "call-1", description: undefined, status: "completed" }]);
  });

  test("relays lifecycle events only for agents the parent's service owns", () => {
    const notifications: string[] = [];
    const emit = loadRuntimeBridge();
    try {
      publishService([{ id: "native-1", status: "steered", startedAt: 100 }]);
      emit(
        "session_start",
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      );
      emit("subagents:started", { id: "native-1" });
      emit("subagents:completed", { id: "native-1", status: "steered" });
      // A nested child's agent is not in the parent's service.
      emit("subagents:completed", { id: "grandchild", status: "completed" });
      expect(notifications).toEqual([
        `${GOTGENES_LIFECYCLE_MARKER} {"agentId":"native-1","status":"running","startedAt":100}`,
        `${GOTGENES_LIFECYCLE_MARKER} {"agentId":"native-1","status":"steered","startedAt":100}`,
      ]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
    }
  });

  test("settles a background card from lifecycle events without a result query", () => {
    for (const [native, expected] of [
      ["completed", "completed"],
      ["steered", "completed"],
      ["aborted", "canceled"],
      ["error", "failed"],
    ] as const) {
      const card = cardStatus();
      card.apply(spawnBackground(card.host, "call-1", "native-1"));
      card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "running", 100)));
      card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", native, 100)));
      expect(card.status()).toBe(expected);
    }
  });

  test("keeps a finished card finished through metadata, files, and stale snapshots", () => {
    const card = cardStatus();
    card.apply(spawnBackground(card.host, "call-1", "native-1"));
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "steered", 100)));
    const file = card.host.mapRuntimeNotification(
      `${GOTGENES_CHILD_SESSION_MARKER} ${JSON.stringify({ agentId: "native-1", file: "/tmp/child.jsonl" })}`,
    );
    card.apply(file);
    expect(file?.childSessions).toEqual([{ id: "call-1", file: "/tmp/child.jsonl" }]);
    card.apply(
      card.host.mapCustomMessage({
        role: "custom",
        customType: "subagent-update",
        content: "progress",
        details: { id: "native-1", description: "Renamed" },
      }),
    );
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "running", 100)));
    card.apply(
      card.host.mapToolCall({
        callId: "call-2",
        toolName: "get_subagent_result",
        args: { agent_id: "native-1" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "running" } },
      }),
    );
    expect(card.status()).toBe("completed");
    expect(card.descriptor()?.description).toBe("Renamed");
  });

  test("buffers a lifecycle event that arrives before the spawn result", () => {
    const card = cardStatus();
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "completed", 100)));
    card.apply(spawnBackground(card.host, "call-1", "native-1"));
    expect(card.status()).toBe("completed");
  });

  test("a resume reopens the card and the old run's late completion cannot end it", () => {
    const card = cardStatus();
    card.apply(spawnBackground(card.host, "call-1", "native-1"));
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "completed", 100)));
    const resumeArgs = { subagent_type: "Explore", prompt: "Continue", resume: "native-1" };
    card.apply(
      card.host.mapToolCall({
        callId: "call-2",
        toolName: "subagent",
        args: resumeArgs,
        status: "running",
        result: null,
      }),
    );
    expect(card.status()).toBe("running");
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "completed", 100)));
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "running", 200)));
    expect(card.status()).toBe("running");
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "error", 200)));
    expect(card.status()).toBe("failed");
  });

  test("restores the prior run when gotgenes refuses a resume", () => {
    const card = cardStatus();
    card.apply(spawnBackground(card.host, "call-1", "native-1"));
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-1", "completed", 100)));
    const resumeArgs = { subagent_type: "Explore", prompt: "Continue", resume: "native-1" };
    card.apply(
      card.host.mapToolCall({
        callId: "call-2",
        toolName: "subagent",
        args: resumeArgs,
        status: "running",
        result: null,
      }),
    );
    card.apply(
      card.host.mapToolCall({
        callId: "call-2",
        toolName: "subagent",
        args: resumeArgs,
        status: "completed",
        result: { content: [{ type: "text", text: 'Agent not found: "native-1".' }] },
      }),
    );
    expect(card.status()).toBe("completed");
  });

  test("keeps cards for same-type agents apart", () => {
    const card = cardStatus();
    card.apply(spawnBackground(card.host, "call-1", "native-1"));
    card.apply(spawnBackground(card.host, "call-2", "native-2"));
    card.apply(card.host.mapRuntimeNotification(lifecycle("native-2", "completed", 100)));
    expect(card.status("call-1")).toBe("running");
    expect(card.status("call-2")).toBe("completed");
  });

  test("replays subagents:record entries to settle cards whose results were never mapped", async () => {
    const replay = async (resumed: boolean) => {
      const events = [];
      for await (const event of streamPiHistory(
        "pi",
        [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "subagent",
                arguments: { subagent_type: "Explore", prompt: "Inspect" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "subagent",
            content: [{ type: "text", text: "Started" }],
            details: { agentId: "native-1", status: "background" },
            isError: false,
          },
          ...(resumed
            ? [
                {
                  role: "assistant" as const,
                  content: [
                    {
                      type: "toolCall" as const,
                      id: "call-2",
                      name: "subagent",
                      arguments: {
                        subagent_type: "Explore",
                        prompt: "Continue",
                        resume: "native-1",
                      },
                    },
                  ],
                },
              ]
            : []),
        ] as never,
        [],
        {},
        undefined,
        undefined,
        [
          {
            customType: "subagents:record",
            data: { id: "native-1", status: "steered", startedAt: 100 },
            after: { toolCallId: "call-1", phase: "result" },
          },
        ],
      ))
        events.push(event);
      const store = new ProviderSubagentStore();
      for (const event of events)
        if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      return store.get("parent", "call-1")?.status;
    };
    expect(await replay(false)).toBe("completed");
    // A resume still in flight when history was read stays running.
    expect(await replay(true)).toBe("running");
  });

  test("treats a steered agent as completed", () => {
    const host = createPiExtensionHost();
    spawnBackground(host, "call-1", "native-1");
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "get_subagent_result",
        args: { agent_id: "native-1" },
        status: "completed",
        result: { details: { agentId: "native-1", status: "steered" } },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
  });
});

function lifecycle(agentId: string, status: string, startedAt: number): string {
  return `${GOTGENES_LIFECYCLE_MARKER} ${JSON.stringify({ agentId, status, startedAt })}`;
}

/** Folds adapter output into the real store, as the daemon does. */
function cardStatus() {
  const host = createPiExtensionHost();
  const store = new ProviderSubagentStore();
  return {
    host,
    apply(mapping: Pick<PiExtensionCustomMapping, "subagents"> | undefined) {
      for (const event of mapping?.subagents ?? []) store.apply("parent", "pi", event);
    },
    descriptor: (id = "call-1") => store.get("parent", id),
    status: (id = "call-1") => store.get("parent", id)?.status,
  };
}

function spawnBackground(
  host: ReturnType<typeof createPiExtensionHost>,
  callId: string,
  agentId: string,
) {
  return host.mapToolCall({
    callId,
    toolName: "subagent",
    args: { subagent_type: "Explore", prompt: "Inspect" },
    status: "completed",
    result: { details: { agentId, status: "background" } },
  });
}
