import type { Logger } from "pino";
import type { AgentManagerEvent } from "../agent-manager.js";
import { parseRateLimitRetry } from "./parse.js";

export { parseRateLimitRetry, type RateLimitRetry } from "./parse.js";

/** A continue message this agent is waiting to send. */
export interface RateLimitResumeState {
  dueAt: string;
  /** Rate-limited turns in a row, counting the one that scheduled this. */
  attempt: number;
}

/** Sent after a stated reset time, so a clock a little behind the provider's does not miss it. */
export const RATE_LIMIT_RESUME_GRACE_MS = 30_000;
/** Wait before each retry when the provider names no time. Fixed, not growing. */
export const RATE_LIMIT_RETRY_MS = 90_000;

export const RATE_LIMIT_RESUME_PROMPT =
  "Your previous turn stopped because the model API hit its rate limit (HTTP 429). " +
  "The quota should be available again now. Continue the work you were doing from where it " +
  "stopped and finish the original task as quickly as you can.";

interface Timers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface Dependencies {
  enabled(): boolean;
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  /** Publishes the pending resume on the agent so clients can show and cancel it. */
  publish(agentId: string, state: RateLimitResumeState | null): void;
  /** True while the agent is in a turn; a resume never interrupts one. */
  isRunning(agentId: string): boolean;
  dispatch(agentId: string, prompt: string): Promise<unknown>;
  logger: Logger;
  clock?: () => number;
  timers?: Timers;
}

interface Pending {
  handle: unknown;
  state: RateLimitResumeState;
}

const defaultTimers: Timers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Sends a continue message to an agent whose turn failed on a rate limit, at the time the
 * provider named or 90 seconds later. Anything else the agent does in the meantime (a message
 * from the user, a finished turn, archiving) cancels the pending message. The schedule lives in
 * memory: a daemon restart drops it.
 */
export function createRateLimitResume(deps: Dependencies) {
  const clock = deps.clock ?? (() => Date.now());
  const timers = deps.timers ?? defaultTimers;
  const pending = new Map<string, Pending>();
  /** Rate-limited turns in a row, reset by any turn that ends otherwise. */
  const streaks = new Map<string, number>();
  /** Agents whose next turn is the resume this service sent. */
  const resuming = new Set<string>();

  function cancel(agentId: string): boolean {
    const entry = pending.get(agentId);
    if (!entry) return false;
    timers.clear(entry.handle);
    pending.delete(agentId);
    deps.publish(agentId, null);
    return true;
  }

  function schedule(agentId: string, message: string): void {
    const retry = parseRateLimitRetry(message, new Date(clock()));
    if (!retry) {
      streaks.delete(agentId);
      return;
    }
    const attempt = (streaks.get(agentId) ?? 0) + 1;
    streaks.set(agentId, attempt);
    if (!deps.enabled()) return;
    const now = clock();
    const dueAtMs =
      retry.kind === "at"
        ? Math.max(retry.at.getTime(), now) + RATE_LIMIT_RESUME_GRACE_MS
        : now + RATE_LIMIT_RETRY_MS;
    cancel(agentId);
    const state = { dueAt: new Date(dueAtMs).toISOString(), attempt };
    const handle = timers.set(() => void fire(agentId), dueAtMs - now);
    pending.set(agentId, { handle, state });
    deps.publish(agentId, state);
    deps.logger.info({ agentId, ...state }, "Rate limited; continuing the agent later");
  }

  async function fire(agentId: string): Promise<void> {
    if (!pending.has(agentId)) return;
    pending.delete(agentId);
    deps.publish(agentId, null);
    if (!deps.enabled() || deps.isRunning(agentId)) return;
    resuming.add(agentId);
    try {
      await deps.dispatch(agentId, RATE_LIMIT_RESUME_PROMPT);
    } catch (err) {
      resuming.delete(agentId);
      deps.logger.warn({ err, agentId }, "Failed to continue a rate-limited agent");
    }
  }

  function onEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_removed") {
      cancel(event.agentId);
      streaks.delete(event.agentId);
      return;
    }
    if (event.type === "agent_state") {
      if (event.agent.lifecycle === "closed") cancel(event.agent.id);
      return;
    }
    if (event.type !== "agent_stream") return;
    const { agentId, event: stream } = event;
    switch (stream.type) {
      case "turn_started":
        // A turn this service did not send means someone else took over the agent.
        if (!resuming.delete(agentId)) cancel(agentId);
        return;
      case "turn_failed":
        schedule(
          agentId,
          [stream.error, stream.code, stream.diagnostic].filter(Boolean).join("\n"),
        );
        return;
      case "turn_completed":
      case "turn_canceled":
        streaks.delete(agentId);
        cancel(agentId);
        return;
      default:
        return;
    }
  }

  const unsubscribe = deps.subscribe(onEvent);

  return {
    /** The resume this agent is waiting to send, if any. */
    get(agentId: string): RateLimitResumeState | null {
      return pending.get(agentId)?.state ?? null;
    },
    /** Drops the pending resume. False when there was none. */
    cancel,
    stop(): void {
      unsubscribe();
      for (const agentId of pending.keys()) cancel(agentId);
    },
  };
}

export type RateLimitResume = ReturnType<typeof createRateLimitResume>;
