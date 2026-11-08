import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { HistoryTextIndex } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function row(seq: number, type: "user_message" | "assistant_message", text: string) {
  return {
    seq,
    timestamp: "2026-11-08T00:00:00.000Z",
    item: { type, text },
  } as unknown as AgentTimelineRow;
}

function agent(id: string, updatedAt: string, title = id) {
  return {
    id,
    cwd: `/work/${id}`,
    provider: "codex",
    updatedAt: new Date(updatedAt),
    config: { title },
  };
}

function createIndex(rowsByAgent: Record<string, AgentTimelineRow[]>) {
  const dir = mkdtempSync(path.join(tmpdir(), "history-search-"));
  dirs.push(dir);
  return new HistoryTextIndex({
    dir: path.join(dir, "index"),
    logger: pino({ level: "silent" }),
    readRows: async (agentId) => rowsByAgent[agentId] ?? [],
    delayMs: 0,
  });
}

describe("history text index", () => {
  it("finds a remembered fragment of an old message and where it is", async () => {
    const index = createIndex({
      a1: [
        row(1, "user_message", "构建失败了，看一下"),
        row(4, "assistant_message", "原因是 **签名证书不受信任**，需要管理员执行一次。"),
      ],
      a2: [row(2, "user_message", "unrelated")],
    });
    await index.index(agent("a1", "2026-11-07T00:00:00Z", "Fix signing"));
    await index.index(agent("a2", "2026-11-08T00:00:00Z"));

    const result = await index.search("证书不受信任");
    expect(result.indexedAgents).toBe(2);
    expect(result.hits).toEqual([
      expect.objectContaining({
        agentId: "a1",
        title: "Fix signing",
        seq: 4,
        role: "assistant",
        snippet: "原因是 签名证书不受信任，需要管理员执行一次。",
        agentMatchCount: 1,
      }),
    ]);
  });

  it("lists recently updated agents first and caps the results", async () => {
    const rows = [row(1, "user_message", "deploy the relay")];
    const index = createIndex({ old: rows, recent: rows });
    await index.index(agent("old", "2026-01-01T00:00:00Z"));
    await index.index(agent("recent", "2026-11-01T00:00:00Z"));

    const result = await index.search("deploy", 1);
    expect(result.hits.map((hit) => hit.agentId)).toEqual(["recent"]);
    expect(result.truncated).toBe(true);
  });

  it("ignores agents that are mid-turn or internal, and indexes them once they settle", async () => {
    const index = createIndex({ a1: [row(1, "user_message", "hello world")] });
    index.observe({ ...agent("a1", "2026-11-08T00:00:00Z"), lifecycle: "running" });
    index.observe({ ...agent("a1", "2026-11-08T00:00:00Z"), lifecycle: "idle", internal: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await index.search("hello")).hits).toEqual([]);

    index.observe({ ...agent("a1", "2026-11-08T00:00:00Z"), lifecycle: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await index.search("hello")).hits).toHaveLength(1);
  });
});
