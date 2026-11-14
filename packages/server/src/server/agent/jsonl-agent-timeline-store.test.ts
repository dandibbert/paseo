import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { JsonlAgentTimelineStore } from "./jsonl-agent-timeline-store.js";

describe("JsonlAgentTimelineStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-jsonl-timeline-"));
    dirs.push(dir);
    return dir;
  }

  test("persists appended rows across instances and merges enriched rows by seq", async () => {
    const dir = await createDir();
    const logger = createTestLogger();
    const first = new JsonlAgentTimelineStore(dir, logger);

    await first.bulkInsert("agent/one", [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "hello", clientMessageId: "c1" },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "hi" },
      },
    ]);
    await first.updateCommittedRow("agent/one", {
      seq: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      providerMessageId: "provider-msg-1",
      item: { type: "user_message", text: "hello", clientMessageId: "c1" },
    });
    await first.flush();

    const reopened = new JsonlAgentTimelineStore(dir, logger);
    await expect(reopened.getLatestCommittedSeq("agent/one")).resolves.toBe(2);
    await expect(reopened.getCommittedRows("agent/one")).resolves.toEqual([
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        providerMessageId: "provider-msg-1",
        item: { type: "user_message", text: "hello", clientMessageId: "c1" },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "hi" },
      },
    ]);
    await expect(reopened.getLastItem("agent/one")).resolves.toEqual({
      type: "assistant_message",
      text: "hi",
    });
    await expect(reopened.getLastAssistantMessage("agent/one")).resolves.toBe("hi");
  });

  test("ignores a truncated trailing line left by an abrupt crash", async () => {
    const dir = await createDir();
    const logger = createTestLogger();
    const store = new JsonlAgentTimelineStore(dir, logger);

    await store.appendCommitted("agent-crash", {
      type: "user_message",
      text: "persisted",
    });
    await appendFile(path.join(dir, "agent-crash.jsonl"), '{"seq":2,"timestamp":', "utf8");

    await expect(store.getCommittedRows("agent-crash")).resolves.toEqual([
      expect.objectContaining({
        seq: 1,
        item: { type: "user_message", text: "persisted" },
      }),
    ]);
  });

  test("serializes delete and subsequent writes without resurrecting deleted rows", async () => {
    const dir = await createDir();
    const store = new JsonlAgentTimelineStore(dir);

    const p1 = store.bulkInsert("agent-del", [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "assistant_message", text: "old" },
      },
    ]);
    const p2 = store.deleteAgent("agent-del");
    const p3 = store.updateCommittedRow("agent-del", {
      seq: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      providerMessageId: "late",
      item: { type: "assistant_message", text: "old" },
    });
    await Promise.all([p1, p2, p3]);

    await expect(store.getCommittedRows("agent-del")).resolves.toEqual([]);

    await store.bulkInsert("agent-del", [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "fresh" },
      },
    ]);
    await expect(store.getCommittedRows("agent-del")).resolves.toEqual([
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "fresh" },
      },
    ]);
  });

  test("supports paged fetchCommitted over persisted rows", async () => {
    const dir = await createDir();
    await mkdir(dir, { recursive: true });
    const store = new JsonlAgentTimelineStore(dir);

    for (let i = 1; i <= 5; i += 1) {
      await store.appendCommitted("agent-page", {
        type: "user_message",
        text: `msg-${i}`,
      });
    }

    const tail = await store.fetchCommitted("agent-page", { direction: "tail", limit: 2 });
    expect(tail.hasOlder).toBe(true);
    expect(tail.hasNewer).toBe(false);
    expect(tail.rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "msg-4" },
      { type: "user_message", text: "msg-5" },
    ]);
  });
});
