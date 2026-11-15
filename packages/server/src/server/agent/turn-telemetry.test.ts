import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TurnTelemetryTracker } from "./turn-telemetry.js";
import { JsonlAgentTimelineStore } from "./jsonl-agent-timeline-store.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("TurnTelemetryTracker", () => {
  test("computes TTFT, active generation duration, tool/approval exclusion, and output TPS", () => {
    const tracker = new TurnTelemetryTracker();
    tracker.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      startedAtMs: 1_000,
      model: "claude-sonnet-4-6",
    });

    // First model token arrives at +400ms
    tracker.observeRawEvent({
      agentId: "agent-1",
      turnId: "turn-1",
      nowMs: 1_400,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "Let me check..." },
      },
    });

    // Tool starts at +900ms (first gen segment = 500ms)
    tracker.observeRawEvent({
      agentId: "agent-1",
      turnId: "turn-1",
      nowMs: 1_900,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: "Bash",
          callId: "call-1",
          status: "running",
        },
      },
    });

    // Permission requested during tool at +2_000ms, resolved at +4_000ms (2_000ms approval wait)
    tracker.observeRawEvent({
      agentId: "agent-1",
      nowMs: 2_000,
      event: {
        type: "permission_requested",
        provider: "claude",
        request: {
          id: "perm-1",
          provider: "claude",
          name: "Bash",
          kind: "tool",
        },
      },
    });
    tracker.observeRawEvent({
      agentId: "agent-1",
      nowMs: 4_000,
      event: {
        type: "permission_resolved",
        provider: "claude",
        requestId: "perm-1",
        resolution: { behavior: "allow" },
      },
    });

    // Tool completes at +5_900ms (4_000ms tool wall duration)
    tracker.observeRawEvent({
      agentId: "agent-1",
      turnId: "turn-1",
      nowMs: 5_900,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: "Bash",
          callId: "call-1",
          status: "completed",
        },
      },
    });

    // Final assistant tokens stream from +6_200ms to +7_700ms (second gen segment = 1_500ms)
    tracker.observeRawEvent({
      agentId: "agent-1",
      turnId: "turn-1",
      nowMs: 6_200,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "Done." },
      },
    });
    tracker.recordCommittedRow("agent-1", "turn-1", {
      seq: 2,
      timestamp: new Date(7_700).toISOString(),
      turnId: "turn-1",
      item: { type: "assistant_message", text: "Done." },
    });

    const { telemetry, targetRow } = tracker.finalizeTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      nowMs: 7_700,
      turnUsage: {
        inputTokens: 1_000,
        cachedInputTokens: 800,
        cacheCreationInputTokens: 200,
        outputTokens: 100,
      },
    });

    expect(targetRow?.seq).toBe(2);
    expect(telemetry).toEqual({
      ttftMs: 400,
      durationMs: 6_700,
      apiDurationMs: 700, // 6_700 - 4_000 tool - 2_000 approval
      generationDurationMs: 2_000, // 500ms + 1_500ms
      toolDurationMs: 4_000,
      approvalWaitMs: 2_000,
      outputTps: 50, // 100 tokens / 2.0s
      toolCallCount: 1,
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 800,
        cacheCreationInputTokens: 200,
        outputTokens: 100,
      },
    });
  });

  test("prefers provider-reported TTFT and API duration while keeping daemon tool metrics", () => {
    const tracker = new TurnTelemetryTracker();
    tracker.startTurn({ agentId: "agent-1", turnId: "turn-2", startedAtMs: 10_000 });
    const { telemetry } = tracker.finalizeTurn({
      agentId: "agent-1",
      turnId: "turn-2",
      nowMs: 12_000,
      providerTelemetry: {
        ttftMs: 320,
        timeToRequestMs: 45,
        durationMs: 2_100,
        apiDurationMs: 1_800,
        apiTurnCount: 3,
        stopReason: "end_turn",
        model: "gcp-cpa/gcp/gemini-4-hydrogen",
        canonicalModel: "gemini-4-hydrogen",
        usage: {
          inputTokens: 500,
          outputTokens: 90,
          cacheCreationInputTokens: 150,
          totalCostUsd: 0.6,
        },
      },
    });

    expect(telemetry).toEqual({
      ttftMs: 320,
      timeToRequestMs: 45,
      durationMs: 2_100,
      apiDurationMs: 1_800,
      outputTps: 50, // 90 tokens / 1.8s
      apiTurnCount: 3,
      stopReason: "end_turn",
      model: "gcp-cpa/gcp/gemini-4-hydrogen",
      canonicalModel: "gemini-4-hydrogen",
      usage: {
        inputTokens: 500,
        outputTokens: 90,
        cacheCreationInputTokens: 150,
        totalCostUsd: 0.6,
      },
    });
  });

  test("persists and reloads turn telemetry in JsonlAgentTimelineStore without duplicating merged chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-telemetry-jsonl-"));
    const durable = new JsonlAgentTimelineStore(dir);
    const memory = new InMemoryAgentTimelineStore();
    memory.initialize("agent-1");

    const r1 = memory.append(
      "agent-1",
      { type: "user_message", text: "hello" },
      { turnId: "turn-1" },
    );
    const r2 = memory.append(
      "agent-1",
      { type: "assistant_message", text: "part1 " },
      { turnId: "turn-1" },
    );
    const r3 = memory.append(
      "agent-1",
      { type: "assistant_message", text: "part2" },
      { turnId: "turn-1" },
    );
    await durable.bulkInsert("agent-1", [r1, r2, r3]);

    const telemetry = { ttftMs: 250, outputTps: 62.5, apiTurnCount: 1 };
    memory.enrichTurnTelemetry("agent-1", "turn-1", telemetry, r3.seq);
    await durable.updateCommittedRow("agent-1", { ...r3, telemetry });

    const reloaded = await durable.fetchCommitted("agent-1", { direction: "tail" });
    expect(reloaded.rows).toHaveLength(2);
    expect(reloaded.rows[1]?.item).toEqual({
      type: "assistant_message",
      text: "part1 part2",
    });
    expect(reloaded.rows[1]?.telemetry).toEqual(telemetry);
  });
});
