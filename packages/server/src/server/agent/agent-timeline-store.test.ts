import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { selectProjectedTimelinePage } from "./timeline-projection.js";
const stores: InMemoryAgentTimelineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
function spillingStore() {
  const store = new InMemoryAgentTimelineStore({ maxMemoryBytes: 0 });
  stores.push(store);
  return store;
}

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });
  it("retains all old history on disk with the same epoch, cursors, and late prompt acknowledgement", () => {
    const store = spillingStore();
    store.initialize("agent", { epoch: "e" });
    store.append("agent", {
      type: "user_message",
      text: "prompt",
      messageId: "client",
      clientMessageId: "client",
    });
    for (let i = 0; i < 100; i++)
      store.append("agent", { type: "assistant_message", text: `message-${i}` });
    const beforeReads = store.getStorageStats().payloadReads;
    expect(store.getItemCount("agent")).toBe(101);
    expect(store.getStorageStats().payloadReads).toBe(beforeReads);
    expect(
      store.fetch("agent", { direction: "tail", limit: 2 }).rows.map((row) => row.seq),
    ).toEqual([100, 101]);
    expect(store.getStorageStats().payloadReads - beforeReads).toBe(2);
    const older = store.fetch("agent", {
      direction: "before",
      cursor: { epoch: "e", seq: 4 },
      limit: 3,
    });
    expect(older.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(older.hasOlder).toBe(false);
    expect(older.hasNewer).toBe(true);
    expect(store.enrichSubmittedUserMessage("agent", "client", "provider")?.providerMessageId).toBe(
      "provider",
    );
    expect(store.getSubmittedUserMessage("agent", "client")?.item).toMatchObject({
      text: "prompt",
    });
    expect(store.fetch("agent", { limit: 0 }).rows).toHaveLength(101);
    store.delete("agent");
    expect(store.getStorageStats().spilledRows).toBe(0);
  });

  it("hydrates only the requested projected page, not every heavy historical payload", () => {
    const store = spillingStore();
    store.initialize("agent", { epoch: "e" });
    for (let i = 0; i < 500; i++) {
      store.append("agent", { type: "user_message", text: `${i}: ${"history".repeat(2000)}` });
    }
    const before = store.getStorageStats().payloadReads;
    const page = store.fetchProjectedPage("agent", { direction: "tail", limit: 2 });
    expect(page.entries.map((e) => e.seqStart)).toEqual([499, 500]);
    expect(page.hasOlder).toBe(true);
    expect(store.getStorageStats().payloadReads - before).toBe(2);
    expect(store.getStorageStats().residentBytes).toBe(0);
  });

  it("matches in-memory projection across spilled lifecycle, text, plugin and turn boundaries", () => {
    const store = spillingStore();
    const rows: AgentTimelineRow[] = [];
    function push(item: AgentTimelineRow["item"], turnId = "turn-a") {
      rows.push({ seq: rows.length + 1, timestamp: String(rows.length), turnId, item });
    }
    push({ type: "user_message", text: "user" });
    push({
      type: "tool_call",
      callId: "tool",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "shell", command: "pwd" },
      metadata: { first: true },
    });
    push({ type: "assistant_message", text: "first ", messageId: "a" });
    push({ type: "assistant_message", text: "second", messageId: "a" });
    push({ type: "reasoning", text: "thinking " });
    push({ type: "reasoning", text: "done" });
    push({
      type: "tool_call",
      callId: "tool",
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: null, output: "done" },
      metadata: { second: true },
    });
    push({
      type: "plugin",
      id: "p",
      pluginId: "plugin",
      kind: "k",
      version: 1,
      data: { first: 1 },
    });
    push({ type: "user_message", text: "next" });
    push({ type: "plugin", id: "p", pluginId: "plugin", kind: "k", version: 1, data: { last: 2 } });
    push(
      {
        type: "tool_call",
        callId: "tool",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "ls" },
      },
      "turn-b",
    );
    push({ type: "assistant_message", text: "last", messageId: "" }, "turn-b");
    store.initialize("agent", { epoch: "e", rows });
    for (const direction of ["tail", "before", "after"] as const) {
      for (const limit of [0, 1, 2, 10]) {
        for (const seq of [0, 2, 4, 7, 10, 12, 100]) {
          const cursor = { epoch: "e", seq };
          expect(store.fetchProjectedPage("agent", { direction, cursor, limit })).toEqual(
            selectProjectedTimelinePage({ rows, direction, cursorSeq: seq, limit }),
          );
        }
      }
    }
  });

  it("replacing a seeded timeline releases previous spill blocks", () => {
    const store = spillingStore();
    store.initialize("agent", { items: [{ type: "assistant_message", text: "old" }] });
    store.initialize("agent", { items: [{ type: "assistant_message", text: "new" }] });
    expect(store.getItems("agent")).toEqual([{ type: "assistant_message", text: "new" }]);
    expect(store.getStorageStats().spilledRows).toBe(1);
  });
});
