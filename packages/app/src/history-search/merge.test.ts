import { expect, it } from "vitest";
import { mergeHistoryTextAnswers, type HostHistoryTextAnswer } from "./merge";

function hit(agentId: string, seq: number, updatedAt: string) {
  return {
    agentId,
    title: agentId,
    cwd: "/repo",
    workspaceId: null,
    provider: "claude",
    updatedAt,
    seq,
    role: "assistant" as const,
    snippet: `match ${seq}`,
    agentMatchCount: 2,
  };
}

function answer(serverId: string, hits: ReturnType<typeof hit>[]): HostHistoryTextAnswer {
  return {
    serverId,
    serverLabel: serverId,
    payload: { requestId: "r", hits, indexedAgents: 3, truncated: false, error: null },
  };
}

it("keeps each chat's newest match and orders chats from every host by recency", () => {
  const merged = mergeHistoryTextAnswers([
    answer("mac", [hit("a", 4, "2026-01-01T00:00:00Z"), hit("a", 9, "2026-01-01T00:00:00Z")]),
    answer("linux", [hit("a", 1, "2026-03-01T00:00:00Z")]),
  ]);
  expect(merged.results.map((result) => [result.serverId, result.agentId, result.seq])).toEqual([
    ["linux", "a", 1],
    ["mac", "a", 9],
  ]);
  expect(merged.indexedAgents).toBe(6);
});
