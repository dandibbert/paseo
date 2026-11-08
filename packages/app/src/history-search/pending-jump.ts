/**
 * A message a history search result asked to open, held until that agent's chat find is
 * mounted (or already mounted in a retained pane) to take it.
 */
export interface PendingChatJump {
  query: string;
  seq: number;
}

const pending = new Map<string, PendingChatJump>();
const listeners = new Set<() => void>();

function keyFor(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function requestChatJump(input: {
  serverId: string;
  agentId: string;
  query: string;
  seq: number;
}): void {
  pending.set(keyFor(input.serverId, input.agentId), { query: input.query, seq: input.seq });
  listeners.forEach((listener) => listener());
}

export function takeChatJump(serverId: string, agentId: string): PendingChatJump | null {
  const key = keyFor(serverId, agentId);
  const jump = pending.get(key) ?? null;
  pending.delete(key);
  return jump;
}

export function subscribeChatJumps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
