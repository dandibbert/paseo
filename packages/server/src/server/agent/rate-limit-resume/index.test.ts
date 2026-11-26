import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AgentManagerEvent } from "../agent-manager.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  createRateLimitResume,
  parseRateLimitRetry,
  RATE_LIMIT_RESUME_PROMPT,
  type RateLimitResumeState,
} from "./index.js";

const COOLING_DOWN =
  'API Error: Request rejected (429) · gcp: All credentials for model gcp/gemini-4-hydrogen are cooling down (last error: { "error": { "code": 429, "status": "RESOU… (rate limited: not asked again before 17:58 UTC+8)';
const EXHAUSTED =
  "API Error: Request rejected (429) · gcp: Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.";

describe("parseRateLimitRetry", () => {
  it("reads the stated time in its own UTC offset", () => {
    // 17:40 in UTC+8.
    const now = new Date("2026-11-26T09:40:00Z");
    expect(parseRateLimitRetry(COOLING_DOWN, now)).toEqual({
      kind: "at",
      at: new Date("2026-11-26T09:58:00Z"),
    });
  });

  it("takes a time well in the past to mean tomorrow", () => {
    // 23:50 in UTC+8; the reset is 00:10 the next day there.
    const now = new Date("2026-11-26T15:50:00Z");
    const message = "429 rate limited: not asked again before 00:10 UTC+8";
    expect(parseRateLimitRetry(message, now)).toEqual({
      kind: "at",
      at: new Date("2026-11-26T16:10:00Z"),
    });
  });

  it("keeps a time that just passed on the same day", () => {
    const now = new Date("2026-11-26T10:00:00Z");
    expect(parseRateLimitRetry(COOLING_DOWN, now)).toEqual({
      kind: "at",
      at: new Date("2026-11-26T09:58:00Z"),
    });
  });

  it("backs off when the provider names no time", () => {
    expect(parseRateLimitRetry(EXHAUSTED, new Date())).toEqual({ kind: "backoff" });
  });

  it("ignores errors that are not rate limits", () => {
    expect(parseRateLimitRetry("API Error: 500 Internal server error", new Date())).toBeNull();
  });
});

interface Harness {
  emit(event: AgentManagerEvent): void;
  advance(ms: number): Promise<void>;
  published: Array<[string, RateLimitResumeState | null]>;
  dispatched: Array<[string, string]>;
  running: Set<string>;
  service: ReturnType<typeof createRateLimitResume>;
  setEnabled(value: boolean): void;
}

function createHarness(startMs: number): Harness {
  let now = startMs;
  let enabled = true;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  let listener: (event: AgentManagerEvent) => void = () => {};
  const harness: Harness = {
    emit: (event) => listener(event),
    async advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.run();
        }
      }
      await Promise.resolve();
    },
    published: [],
    dispatched: [],
    running: new Set(),
    setEnabled: (value) => {
      enabled = value;
    },
    service: null as never,
  };
  harness.service = createRateLimitResume({
    enabled: () => enabled,
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    publish: (agentId, state) => harness.published.push([agentId, state]),
    isRunning: (agentId) => harness.running.has(agentId),
    dispatch: async (agentId, prompt) => {
      harness.dispatched.push([agentId, prompt]);
    },
    logger: pino({ level: "silent" }),
    clock: () => now,
    timers: {
      set: (run, delayMs) => {
        const timer = { at: now + delayMs, run, live: true };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    },
  });
  return harness;
}

function stream(agentId: string, event: AgentStreamEvent): AgentManagerEvent {
  return { type: "agent_stream", agentId, event };
}

function failed(error: string): AgentStreamEvent {
  return { type: "turn_failed", provider: "claude", error };
}

describe("createRateLimitResume", () => {
  it("continues the agent 30 seconds after the stated time", async () => {
    const h = createHarness(Date.parse("2026-11-26T09:40:00Z"));
    h.emit(stream("a1", failed(COOLING_DOWN)));
    expect(h.service.get("a1")).toEqual({ dueAt: "2026-11-26T09:58:30.000Z", attempt: 1 });

    await h.advance(18 * 60_000);
    expect(h.dispatched).toEqual([]);
    await h.advance(30_000);
    expect(h.dispatched).toEqual([["a1", RATE_LIMIT_RESUME_PROMPT]]);
    expect(h.published.at(-1)).toEqual(["a1", null]);
  });

  it("backs off 2, 5, 10, then 15 minutes while turns keep failing", async () => {
    let now = 0;
    const h = createHarness(now);
    const waits: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      h.emit(stream("a1", failed(EXHAUSTED)));
      const due = h.service.get("a1");
      if (!due) throw new Error("expected a pending resume");
      const wait = Date.parse(due.dueAt) - now;
      waits.push(wait / 60_000);
      await h.advance(wait);
      now += wait;
      h.emit(stream("a1", { type: "turn_started", provider: "claude" }));
    }
    expect(waits).toEqual([2, 5, 10, 15, 15]);
    expect(h.dispatched).toHaveLength(5);
  });

  it("starts the backoff over after a turn that finishes", async () => {
    const h = createHarness(0);
    h.emit(stream("a1", failed(EXHAUSTED)));
    await h.advance(2 * 60_000);
    h.emit(stream("a1", { type: "turn_started", provider: "claude" }));
    h.emit(stream("a1", { type: "turn_completed", provider: "claude" }));
    h.emit(stream("a1", failed(EXHAUSTED)));
    expect(h.service.get("a1")?.attempt).toBe(1);
  });

  it("drops the pending message when someone else starts a turn", async () => {
    const h = createHarness(0);
    h.emit(stream("a1", failed(EXHAUSTED)));
    h.emit(stream("a1", { type: "turn_started", provider: "claude" }));
    expect(h.service.get("a1")).toBeNull();
    await h.advance(60 * 60_000);
    expect(h.dispatched).toEqual([]);
  });

  it("drops the pending message when the agent is removed or cancelled by hand", async () => {
    const h = createHarness(0);
    h.emit(stream("a1", failed(EXHAUSTED)));
    h.emit({ type: "agent_removed", agentId: "a1", internal: false });
    h.emit(stream("a2", failed(EXHAUSTED)));
    expect(h.service.cancel("a2")).toBe(true);
    expect(h.service.cancel("a2")).toBe(false);
    await h.advance(60 * 60_000);
    expect(h.dispatched).toEqual([]);
  });

  it("does nothing when the host turned it off, and never interrupts a running turn", async () => {
    const h = createHarness(0);
    h.setEnabled(false);
    h.emit(stream("a1", failed(EXHAUSTED)));
    expect(h.service.get("a1")).toBeNull();

    h.setEnabled(true);
    h.emit(stream("a2", failed(EXHAUSTED)));
    h.running.add("a2");
    await h.advance(60 * 60_000);
    expect(h.dispatched).toEqual([]);
  });

  it("ignores failures that are not rate limits", () => {
    const h = createHarness(0);
    h.emit(stream("a1", failed("API Error: 500 Internal server error")));
    expect(h.service.get("a1")).toBeNull();
  });
});
