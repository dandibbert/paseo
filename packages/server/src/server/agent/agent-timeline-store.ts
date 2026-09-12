import { randomUUID } from "node:crypto";
import { TimelinePayloadStore, type TimelinePayloadHandle } from "./timeline-payload-store.js";
import { timelineProjectionIndexRow } from "./timeline-row-index.js";
import {
  hydrateTimelineProjectionEntry,
  selectProjectedTimelinePage,
  selectTimelineWindowByProjectedLimit,
  type ProjectedTimelinePageSelection,
  type TimelineSeqRange,
} from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface IndexedTimelineRow extends AgentTimelineRow {
  payload: TimelinePayloadHandle;
}

interface AgentTimelineState {
  epoch: string;
  rows: IndexedTimelineRow[];
  nextSeq: number;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

interface FetchContext {
  state: AgentTimelineState;
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>;
  limit: number;
  selectAll: boolean;
  cursor: AgentTimelineFetchOptions["cursor"];
  minSeq: number;
  maxSeq: number;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
}

function fetchTail(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const selected =
    selectAll || limit >= state.rows.length
      ? state.rows
      : state.rows.slice(state.rows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: false,
    rows: selected.map(cloneRow),
  };
}

function fetchAfter(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, maxSeq, window } = ctx;
  const baseSeq = cursor?.seq ?? 0;
  const startIdx = state.rows.findIndex((row) => row.seq > baseSeq);
  if (startIdx < 0) {
    return {
      epoch: state.epoch,
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window,
      hasOlder: baseSeq >= minSeq,
      hasNewer: false,
      rows: [],
    };
  }

  const selected = selectAll
    ? state.rows.slice(startIdx)
    : state.rows.slice(startIdx, startIdx + limit);
  const lastSelected = selected[selected.length - 1];
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected[0].seq > minSeq,
    hasNewer: lastSelected !== null && lastSelected !== undefined && lastSelected.seq < maxSeq,
    rows: selected.map(cloneRow),
  };
}

function fetchBefore(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, window } = ctx;
  const beforeSeq = cursor?.seq ?? state.nextSeq;
  const endExclusive = state.rows.findIndex((row) => row.seq >= beforeSeq);
  const boundedRows = endExclusive < 0 ? state.rows : state.rows.slice(0, endExclusive);
  const selected =
    selectAll || limit >= boundedRows.length
      ? boundedRows
      : boundedRows.slice(boundedRows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: endExclusive >= 0,
    rows: selected.map(cloneRow),
  };
}

function fetchReset(
  ctx: FetchContext,
  flags: { staleCursor: boolean; gap: boolean },
): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const rows =
    selectAll || limit >= state.rows.length
      ? state.rows.map(cloneRow)
      : state.rows.slice(state.rows.length - limit).map(cloneRow);
  return {
    epoch: state.epoch,
    direction,
    reset: true,
    staleCursor: flags.staleCursor,
    gap: flags.gap,
    window,
    hasOlder: rows.length > 0 && rows[0].seq > minSeq,
    hasNewer: false,
    rows,
  };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();
  private readonly payloads: TimelinePayloadStore;

  constructor(options: { maxMemoryBytes?: number } = {}) {
    this.payloads = new TimelinePayloadStore(options.maxMemoryBytes);
  }

  getItemCount(agentId: string): number {
    return this.requireState(agentId).rows.length;
  }

  getStorageStats(): ReturnType<TimelinePayloadStore["stats"]> {
    return this.payloads.stats();
  }

  dispose(): void {
    this.states.clear();
    this.payloads.dispose();
  }

  private indexRow(row: AgentTimelineRow): IndexedTimelineRow {
    return { ...timelineProjectionIndexRow(row), payload: this.payloads.put(row) };
  }

  private materialize(agentId: string, row: AgentTimelineRow): AgentTimelineRow {
    const rows = this.requireState(agentId).rows;
    const index = this.lowerBound(rows, row.seq);
    const found = rows[index];
    if (!found || found.seq !== row.seq)
      throw new Error("Timeline projection refers to a missing row");
    return this.payloads.get(found.payload);
  }

  private lowerBound(rows: readonly AgentTimelineRow[], seq: number): number {
    let left = 0;
    let right = rows.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (rows[middle].seq < seq) left = middle + 1;
      else right = middle;
    }
    return left;
  }

  private *readRanges(
    agentId: string,
    ranges: readonly TimelineSeqRange[],
  ): Iterable<AgentTimelineRow> {
    const rows = this.requireState(agentId).rows;
    for (const range of ranges) {
      for (
        let i = this.lowerBound(rows, range.startSeq);
        i < rows.length && rows[i].seq <= range.endSeq;
        i++
      ) {
        yield this.payloads.get(rows[i].payload);
      }
    }
  }

  fetchProjectedPage(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): ProjectedTimelinePageSelection {
    const state = this.requireState(agentId);
    const control = this.fetchIndex(agentId, options);
    const page = selectProjectedTimelinePage({
      rows: state.rows,
      bounds: control.window,
      direction: control.reset ? "tail" : control.direction,
      cursorSeq: options?.cursor?.seq,
      limit: options?.limit,
    });
    return {
      ...page,
      entries: page.entries.map((entry) =>
        hydrateTimelineProjectionEntry(entry, this.readRanges(agentId, entry.sourceSeqRanges)),
      ),
    };
  }

  fetchProjectedWindow(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    const timeline = this.fetchIndex(agentId, { ...options, limit: 0 });
    const selected = selectTimelineWindowByProjectedLimit({
      rows: timeline.rows,
      direction: timeline.reset ? "tail" : timeline.direction,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      ...timeline,
      rows: selected.selectedRows.map((row) => this.materialize(agentId, row)),
      hasOlder:
        timeline.hasOlder || (selected.minSeq !== null && selected.minSeq > timeline.window.minSeq),
      hasNewer:
        timeline.hasNewer || (selected.maxSeq !== null && selected.maxSeq < timeline.window.maxSeq),
    };
  }

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const seedRows = options?.rows?.length
      ? options.rows
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const rows: IndexedTimelineRow[] = [];
    try {
      for (const row of seedRows) rows.push(this.indexRow(row));
    } catch (error) {
      for (const row of rows) this.payloads.release(row.payload);
      throw error;
    }
    const nextSeq = options?.nextSeq ?? (rows.length ? rows[rows.length - 1].seq + 1 : 1);
    this.delete(agentId);
    this.states.set(agentId, { epoch: options?.epoch ?? randomUUID(), rows, nextSeq });
  }

  delete(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state) return;
    for (const row of state.rows) this.payloads.release(row.payload);
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId).rows.map((row) => this.payloads.get(row.payload).item);
  }

  getRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).rows.map((row) => this.payloads.get(row.payload));
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).rows.find(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? this.payloads.get(row.payload) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const index = state.rows.findIndex(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    const previous = state.rows[index];
    if (!previous) return null;
    const row = { ...this.payloads.get(previous.payload), providerMessageId };
    state.rows[index] = this.indexRow(row);
    this.payloads.release(previous.payload);
    return row;
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const result = this.fetchIndex(agentId, options);
    return { ...result, rows: result.rows.map((row) => this.materialize(agentId, row)) };
  }

  private fetchIndex(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    const limit =
      requestedLimit === undefined
        ? DEFAULT_TIMELINE_FETCH_LIMIT
        : Math.max(0, Math.floor(requestedLimit));
    const cursor = options?.cursor;
    const minSeq = state.rows.length ? state.rows[0].seq : 0;
    const maxSeq = state.rows.length ? state.rows[state.rows.length - 1].seq : 0;
    const selectAll = limit === 0;

    const window = {
      minSeq,
      maxSeq,
      nextSeq: state.nextSeq,
    };

    const ctx: FetchContext = {
      state,
      direction,
      limit,
      selectAll,
      cursor,
      minSeq,
      maxSeq,
      window,
    };

    if (cursor && typeof cursor.epoch === "string" && cursor.epoch !== state.epoch) {
      return fetchReset(ctx, { staleCursor: true, gap: false });
    }

    if (direction === "after" && cursor && state.rows.length > 0 && cursor.seq < minSeq - 1) {
      return fetchReset(ctx, { staleCursor: false, gap: true });
    }

    if (state.rows.length === 0) {
      return {
        epoch: state.epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }

    if (direction === "tail") {
      return fetchTail(ctx);
    }
    if (direction === "after") {
      return fetchAfter(ctx);
    }
    return fetchBefore(ctx);
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    const indexed = this.indexRow(row);
    state.nextSeq += 1;
    state.rows.push(indexed);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    const last = state.rows[state.rows.length - 1];
    return last ? this.payloads.get(last.payload).item : null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const rows = this.requireState(agentId).rows;
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const indexed = rows[i];
      const item =
        indexed.item.type === "assistant_message"
          ? this.payloads.get(indexed.payload).item
          : indexed.item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
    }

    if (chunks.length === 0) {
      return null;
    }

    return chunks.toReversed().join("");
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
