import type { AgentStreamEvent, AgentTurnTelemetry, AgentUsage } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const MIN_TPS_DENOMINATOR_MS = 50;

interface TurnTrackerState {
  agentId: string;
  turnId: string;
  startedAtMs: number;
  model?: string;
  firstModelTokenAtMs: number | null;
  activeGenStartMs: number | null;
  accumulatedGenerationMs: number;
  activeToolCallIds: Set<string>;
  seenToolCallIds: Set<string>;
  toolWallSpanStartMs: number | null;
  toolWallDurationMs: number;
  activePermissionIds: Set<string>;
  approvalWallSpanStartMs: number | null;
  approvalWallDurationMs: number;
  lastCommittedRow: AgentTimelineRow | null;
  lastAssistantCommittedRow: AgentTimelineRow | null;
}

function createTurnState(input: {
  agentId: string;
  turnId: string;
  startedAtMs: number;
  model?: string;
}): TurnTrackerState {
  return {
    agentId: input.agentId,
    turnId: input.turnId,
    startedAtMs: input.startedAtMs,
    ...(input.model ? { model: input.model } : {}),
    firstModelTokenAtMs: null,
    activeGenStartMs: null,
    accumulatedGenerationMs: 0,
    activeToolCallIds: new Set(),
    seenToolCallIds: new Set(),
    toolWallSpanStartMs: null,
    toolWallDurationMs: 0,
    activePermissionIds: new Set(),
    approvalWallSpanStartMs: null,
    approvalWallDurationMs: 0,
    lastCommittedRow: null,
    lastAssistantCommittedRow: null,
  };
}

function flushGenerationWindow(state: TurnTrackerState, nowMs: number): void {
  if (state.activeGenStartMs === null) {
    return;
  }
  state.accumulatedGenerationMs += Math.max(0, nowMs - state.activeGenStartMs);
  state.activeGenStartMs = null;
}

function flushToolWallSpan(state: TurnTrackerState, nowMs: number): void {
  if (state.toolWallSpanStartMs === null) {
    return;
  }
  state.toolWallDurationMs += Math.max(0, nowMs - state.toolWallSpanStartMs);
  state.toolWallSpanStartMs = null;
}

function flushApprovalWallSpan(state: TurnTrackerState, nowMs: number): void {
  if (state.approvalWallSpanStartMs === null) {
    return;
  }
  state.approvalWallDurationMs += Math.max(0, nowMs - state.approvalWallSpanStartMs);
  state.approvalWallSpanStartMs = null;
}

function readFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mergeUsage(
  turnUsage: AgentUsage | undefined,
  providerTelemetryUsage: AgentUsage | undefined,
  fallbackUsage: AgentUsage | undefined,
): AgentUsage | undefined {
  const base = providerTelemetryUsage ?? turnUsage;
  if (!base && !fallbackUsage) {
    return undefined;
  }
  if (!base) {
    return fallbackUsage ? { ...fallbackUsage } : undefined;
  }
  return {
    ...fallbackUsage,
    ...base,
  };
}

function assignIfDefined<K extends keyof AgentTurnTelemetry>(
  target: AgentTurnTelemetry,
  key: K,
  value: AgentTurnTelemetry[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function pickTpsDenominatorMs(
  generationDurationMs: number | undefined,
  apiDurationMs: number | undefined,
): number | undefined {
  if (generationDurationMs !== undefined && generationDurationMs >= MIN_TPS_DENOMINATOR_MS) {
    return generationDurationMs;
  }
  if (apiDurationMs !== undefined && apiDurationMs >= MIN_TPS_DENOMINATOR_MS) {
    return apiDurationMs;
  }
  return undefined;
}

function computeOutputTps(
  providerTelemetry: AgentTurnTelemetry | undefined,
  usage: AgentUsage | undefined,
  generationDurationMs: number | undefined,
  apiDurationMs: number | undefined,
): number | undefined {
  const explicit = readFiniteNonNegative(providerTelemetry?.outputTps);
  if (explicit !== undefined) {
    return explicit;
  }
  const outputTokens = readFiniteNonNegative(usage?.outputTokens);
  const denominatorMs = pickTpsDenominatorMs(generationDurationMs, apiDurationMs);
  if (outputTokens === undefined || outputTokens <= 0 || denominatorMs === undefined) {
    return undefined;
  }
  return Math.round((outputTokens / (denominatorMs / 1000)) * 10) / 10;
}

function resolveDurationMs(
  providerDurationMs: unknown,
  state: TurnTrackerState | undefined,
  nowMs: number,
): number | undefined {
  return (
    readFiniteNonNegative(providerDurationMs) ??
    (state ? Math.max(0, nowMs - state.startedAtMs) : undefined)
  );
}

function resolveTtftMs(
  providerTtftMs: unknown,
  state: TurnTrackerState | undefined,
): number | undefined {
  return (
    readFiniteNonNegative(providerTtftMs) ??
    (state && state.firstModelTokenAtMs !== null
      ? Math.max(0, state.firstModelTokenAtMs - state.startedAtMs)
      : undefined)
  );
}

function resolveToolDurationMs(
  providerToolDurationMs: unknown,
  state: TurnTrackerState | undefined,
): number | undefined {
  const fromProvider = readFiniteNonNegative(providerToolDurationMs);
  if (fromProvider !== undefined) {
    return fromProvider;
  }
  if (state && (state.toolWallDurationMs > 0 || state.seenToolCallIds.size > 0)) {
    return state.toolWallDurationMs;
  }
  return undefined;
}

function resolveApiDurationMs(
  providerApiDurationMs: unknown,
  durationMs: number | undefined,
  state: TurnTrackerState | undefined,
): number | undefined {
  return (
    readFiniteNonNegative(providerApiDurationMs) ??
    (durationMs !== undefined && state
      ? Math.max(0, durationMs - state.toolWallDurationMs - state.approvalWallDurationMs)
      : undefined)
  );
}

function resolvePositiveStateDuration(
  providerValue: unknown,
  stateValue: number | undefined,
): number | undefined {
  return (
    readFiniteNonNegative(providerValue) ??
    (stateValue !== undefined && stateValue > 0 ? stateValue : undefined)
  );
}

function deriveTurnTimings(params: {
  nowMs: number;
  state: TurnTrackerState | undefined;
  providerTelemetry: AgentTurnTelemetry | undefined;
}): {
  durationMs: number | undefined;
  ttftMs: number | undefined;
  toolDurationMs: number | undefined;
  approvalWaitMs: number | undefined;
  apiDurationMs: number | undefined;
  generationDurationMs: number | undefined;
} {
  const { nowMs, state, providerTelemetry } = params;
  const durationMs = resolveDurationMs(providerTelemetry?.durationMs, state, nowMs);
  return {
    durationMs,
    ttftMs: resolveTtftMs(providerTelemetry?.ttftMs, state),
    toolDurationMs: resolveToolDurationMs(providerTelemetry?.toolDurationMs, state),
    approvalWaitMs: resolvePositiveStateDuration(
      providerTelemetry?.approvalWaitMs,
      state?.approvalWallDurationMs,
    ),
    apiDurationMs: resolveApiDurationMs(providerTelemetry?.apiDurationMs, durationMs, state),
    generationDurationMs: resolvePositiveStateDuration(
      providerTelemetry?.generationDurationMs,
      state?.accumulatedGenerationMs,
    ),
  };
}

function buildFinalTelemetry(params: {
  nowMs: number;
  state: TurnTrackerState | undefined;
  providerTelemetry: AgentTurnTelemetry | undefined;
  turnUsage: AgentUsage | undefined;
  fallbackUsage: AgentUsage | undefined;
  model: string | undefined;
}): AgentTurnTelemetry | undefined {
  const { nowMs, state, providerTelemetry, turnUsage, fallbackUsage, model } = params;
  const timings = deriveTurnTimings({ nowMs, state, providerTelemetry });
  const usage = mergeUsage(turnUsage, providerTelemetry?.usage, fallbackUsage);
  const outputTps = computeOutputTps(
    providerTelemetry,
    usage,
    timings.generationDurationMs,
    timings.apiDurationMs,
  );
  const toolCallCount =
    readFiniteNonNegative(providerTelemetry?.toolCallCount) ??
    (state && state.seenToolCallIds.size > 0 ? state.seenToolCallIds.size : undefined);

  const telemetry: AgentTurnTelemetry = {};
  assignIfDefined(telemetry, "ttftMs", timings.ttftMs);
  assignIfDefined(
    telemetry,
    "timeToRequestMs",
    readFiniteNonNegative(providerTelemetry?.timeToRequestMs),
  );
  assignIfDefined(telemetry, "durationMs", timings.durationMs);
  assignIfDefined(telemetry, "apiDurationMs", timings.apiDurationMs);
  assignIfDefined(telemetry, "generationDurationMs", timings.generationDurationMs);
  assignIfDefined(telemetry, "toolDurationMs", timings.toolDurationMs);
  assignIfDefined(telemetry, "approvalWaitMs", timings.approvalWaitMs);
  assignIfDefined(telemetry, "outputTps", outputTps);
  assignIfDefined(
    telemetry,
    "apiTurnCount",
    readFiniteNonNegative(providerTelemetry?.apiTurnCount),
  );
  assignIfDefined(telemetry, "toolCallCount", toolCallCount);
  assignIfDefined(telemetry, "stopReason", providerTelemetry?.stopReason);
  assignIfDefined(telemetry, "model", providerTelemetry?.model ?? state?.model ?? model);
  assignIfDefined(telemetry, "canonicalModel", providerTelemetry?.canonicalModel);
  assignIfDefined(telemetry, "usage", usage);

  return Object.keys(telemetry).length > 0 ? telemetry : undefined;
}

export class TurnTelemetryTracker {
  private readonly turns = new Map<string, TurnTrackerState>();
  private readonly activeTurnByAgent = new Map<string, string>();

  startTurn(input: {
    agentId: string;
    turnId: string;
    startedAtMs?: number;
    model?: string;
  }): void {
    const key = this.key(input.agentId, input.turnId);
    const existing = this.turns.get(key);
    if (existing) {
      if (input.model && !existing.model) {
        existing.model = input.model;
      }
      this.activeTurnByAgent.set(input.agentId, input.turnId);
      return;
    }
    this.turns.set(
      key,
      createTurnState({
        agentId: input.agentId,
        turnId: input.turnId,
        startedAtMs: input.startedAtMs ?? Date.now(),
        model: input.model,
      }),
    );
    this.activeTurnByAgent.set(input.agentId, input.turnId);
  }

  observeRawEvent(input: {
    agentId: string;
    turnId?: string;
    event: AgentStreamEvent;
    nowMs?: number;
    model?: string;
  }): void {
    const nowMs = input.nowMs ?? Date.now();
    const resolvedTurnId = input.turnId ?? this.activeTurnByAgent.get(input.agentId);
    if (!resolvedTurnId) {
      return;
    }
    const key = this.key(input.agentId, resolvedTurnId);
    let state = this.turns.get(key);
    if (!state) {
      if (input.event.type === "turn_started") {
        this.startTurn({
          agentId: input.agentId,
          turnId: resolvedTurnId,
          startedAtMs: nowMs,
          model: input.model,
        });
        return;
      }
      state = createTurnState({
        agentId: input.agentId,
        turnId: resolvedTurnId,
        startedAtMs: nowMs,
        model: input.model,
      });
      this.turns.set(key, state);
      this.activeTurnByAgent.set(input.agentId, resolvedTurnId);
    }

    switch (input.event.type) {
      case "turn_started":
        return;
      case "timeline":
        this.observeTimelineItem(state, input.event.item, nowMs);
        return;
      case "permission_requested":
        flushGenerationWindow(state, nowMs);
        state.activePermissionIds.add(input.event.request.id);
        if (state.approvalWallSpanStartMs === null) {
          state.approvalWallSpanStartMs = nowMs;
        }
        return;
      case "permission_resolved":
        state.activePermissionIds.delete(input.event.requestId);
        if (state.activePermissionIds.size === 0) {
          flushApprovalWallSpan(state, nowMs);
        }
        return;
      default:
        return;
    }
  }

  recordCommittedRow(agentId: string, turnId: string | undefined, row: AgentTimelineRow): void {
    const resolvedTurnId = turnId ?? row.turnId ?? this.activeTurnByAgent.get(agentId);
    if (!resolvedTurnId) {
      return;
    }
    const state = this.turns.get(this.key(agentId, resolvedTurnId));
    if (!state || row.item.type === "user_message") {
      return;
    }
    state.lastCommittedRow = row;
    if (row.item.type === "assistant_message") {
      state.lastAssistantCommittedRow = row;
    }
  }

  finalizeTurn(input: {
    agentId: string;
    turnId?: string;
    nowMs?: number;
    providerTelemetry?: AgentTurnTelemetry;
    turnUsage?: AgentUsage;
    fallbackUsage?: AgentUsage;
    model?: string;
  }): { telemetry: AgentTurnTelemetry | undefined; targetRow: AgentTimelineRow | null } {
    const nowMs = input.nowMs ?? Date.now();
    const resolvedTurnId = input.turnId ?? this.activeTurnByAgent.get(input.agentId);
    const state = resolvedTurnId
      ? this.turns.get(this.key(input.agentId, resolvedTurnId))
      : undefined;

    if (state) {
      flushGenerationWindow(state, nowMs);
      flushToolWallSpan(state, nowMs);
      flushApprovalWallSpan(state, nowMs);
      this.turns.delete(this.key(input.agentId, state.turnId));
      if (this.activeTurnByAgent.get(input.agentId) === state.turnId) {
        this.activeTurnByAgent.delete(input.agentId);
      }
    }

    const targetRow = state ? (state.lastAssistantCommittedRow ?? state.lastCommittedRow) : null;

    return {
      telemetry: buildFinalTelemetry({
        nowMs,
        state,
        providerTelemetry: input.providerTelemetry,
        turnUsage: input.turnUsage,
        fallbackUsage: input.fallbackUsage,
        model: input.model,
      }),
      targetRow,
    };
  }

  discardTurn(agentId: string, turnId?: string): void {
    const resolvedTurnId = turnId ?? this.activeTurnByAgent.get(agentId);
    if (!resolvedTurnId) {
      return;
    }
    this.turns.delete(this.key(agentId, resolvedTurnId));
    if (this.activeTurnByAgent.get(agentId) === resolvedTurnId) {
      this.activeTurnByAgent.delete(agentId);
    }
  }

  discardAgent(agentId: string): void {
    this.activeTurnByAgent.delete(agentId);
    const prefix = `${agentId}:`;
    for (const key of this.turns.keys()) {
      if (key.startsWith(prefix)) {
        this.turns.delete(key);
      }
    }
  }

  private observeTimelineItem(
    state: TurnTrackerState,
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
    nowMs: number,
  ): void {
    if (item.type === "assistant_message" || item.type === "reasoning") {
      if (state.firstModelTokenAtMs === null) {
        state.firstModelTokenAtMs = nowMs;
      }
      if (state.activeToolCallIds.size === 0 && state.activePermissionIds.size === 0) {
        if (state.activeGenStartMs === null) {
          state.activeGenStartMs = nowMs;
        }
      }
      return;
    }

    if (item.type === "tool_call") {
      const callId = item.callId || item.name;
      state.seenToolCallIds.add(callId);
      if (item.status === "running") {
        flushGenerationWindow(state, nowMs);
        state.activeToolCallIds.add(callId);
        if (state.toolWallSpanStartMs === null) {
          state.toolWallSpanStartMs = nowMs;
        }
      } else {
        state.activeToolCallIds.delete(callId);
        if (state.activeToolCallIds.size === 0) {
          flushToolWallSpan(state, nowMs);
        }
      }
    }
  }

  private key(agentId: string, turnId: string): string {
    return `${agentId}:${turnId}`;
  }
}
