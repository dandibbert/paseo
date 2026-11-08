import type { HistoryTextSearchPayload } from "@getpaseo/client/internal/daemon-client";

export type HistoryTextHit = HistoryTextSearchPayload["hits"][number];

/** One chat in the results: its newest matching message, and how many others match. */
export interface HistoryTextResult extends HistoryTextHit {
  serverId: string;
  serverLabel: string;
}

export interface HostHistoryTextAnswer {
  serverId: string;
  serverLabel: string;
  payload: HistoryTextSearchPayload;
}

/** Keeps each agent's newest hit and orders chats across hosts by when they last changed. */
export function mergeHistoryTextAnswers(answers: readonly HostHistoryTextAnswer[]): {
  results: HistoryTextResult[];
  indexedAgents: number;
  truncated: boolean;
} {
  const byAgent = new Map<string, HistoryTextResult>();
  let indexedAgents = 0;
  let truncated = false;
  for (const answer of answers) {
    indexedAgents += answer.payload.indexedAgents;
    truncated ||= answer.payload.truncated;
    for (const hit of answer.payload.hits) {
      const key = `${answer.serverId}:${hit.agentId}`;
      const existing = byAgent.get(key);
      if (existing && existing.seq >= hit.seq) continue;
      byAgent.set(key, { ...hit, serverId: answer.serverId, serverLabel: answer.serverLabel });
    }
  }
  const results = [...byAgent.values()].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq,
  );
  return { results, indexedAgents, truncated };
}
