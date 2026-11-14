import { access, appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

function isValidTimelineRow(value: unknown): value is AgentTimelineRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.seq !== "number" ||
    !Number.isInteger(candidate.seq) ||
    candidate.seq < 1 ||
    typeof candidate.timestamp !== "string" ||
    typeof candidate.item !== "object" ||
    candidate.item === null
  ) {
    return false;
  }
  const item = candidate.item as Record<string, unknown>;
  return typeof item.type === "string";
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Append-only per-agent JSONL timeline store.
 *
 * Each committed row is appended as a single line (`O(1)` disk write, no full-file rewrites),
 * and row enrichment (`updateCommittedRow`) appends an updated record for the same `seq` that
 * supersedes earlier records when replayed.
 */
export class JsonlAgentTimelineStore implements AgentTimelineStore {
  private readonly dir: string;
  private readonly logger?: Logger;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dir: string, logger?: Logger) {
    this.dir = dir;
    this.logger = logger?.child({ module: "agent", component: "jsonl-timeline-store" });
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return await this.enqueue(agentId, async () => {
      const existing = await this.readRowsFromDisk(agentId);
      const nextSeq = (existing.at(-1)?.seq ?? 0) + 1;
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      };
      await this.appendRowsToDisk(agentId, [row]);
      return row;
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return await this.enqueue(agentId, async () => {
      const rows = await this.readRowsFromDisk(agentId);
      const memory = new InMemoryAgentTimelineStore();
      memory.initialize(agentId, { rows });
      return memory.fetch(agentId, options);
    });
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return await this.enqueue(agentId, async () => {
      const rows = await this.readRowsFromDisk(agentId);
      return rows.at(-1)?.seq ?? 0;
    });
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return await this.enqueue(agentId, async () => await this.readRowsFromDisk(agentId));
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    return await this.enqueue(agentId, async () => {
      const rows = await this.readRowsFromDisk(agentId);
      return rows.at(-1)?.item ?? null;
    });
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return await this.enqueue(agentId, async () => {
      const rows = await this.readRowsFromDisk(agentId);
      if (rows.length === 0) {
        return null;
      }
      const memory = new InMemoryAgentTimelineStore();
      memory.initialize(agentId, { rows });
      return memory.getLastAssistantMessage(agentId);
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.enqueue(agentId, async () => {
      await rm(this.fileFor(agentId), { force: true });
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.enqueue(agentId, async () => {
      await this.appendRowsToDisk(agentId, rows);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.enqueue(agentId, async () => {
      const filePath = this.fileFor(agentId);
      try {
        await access(filePath);
      } catch (error) {
        if (isEnoentError(error)) {
          return;
        }
        throw error;
      }
      await appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
    });
  }

  async flush(): Promise<void> {
    while (this.queues.size > 0) {
      const pending = [...this.queues.values()];
      await Promise.allSettled(pending);
    }
  }

  private fileFor(agentId: string): string {
    if (!agentId) {
      throw new Error("Timeline agentId must be non-empty");
    }
    return path.join(this.dir, `${encodeURIComponent(agentId)}.jsonl`);
  }

  private enqueue<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(agentId, tail);
    void tail.finally(() => {
      if (this.queues.get(agentId) === tail) {
        this.queues.delete(agentId);
      }
    });
    return run;
  }

  private async appendRowsToDisk(
    agentId: string,
    rows: readonly AgentTimelineRow[],
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    await appendFile(this.fileFor(agentId), payload, "utf8");
  }

  private async readRowsFromDisk(agentId: string): Promise<AgentTimelineRow[]> {
    const filePath = this.fileFor(agentId);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      throw error;
    }

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const bySeq = new Map<number, AgentTimelineRow>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (index === lines.length - 1) {
          this.logger?.warn(
            { err: error, agentId, filePath },
            "Ignoring truncated trailing timeline line",
          );
        } else {
          this.logger?.warn(
            { err: error, agentId, filePath, lineIndex: index },
            "Skipping malformed timeline line",
          );
        }
        continue;
      }
      if (!isValidTimelineRow(parsed)) {
        this.logger?.warn({ agentId, filePath, lineIndex: index }, "Skipping invalid timeline row");
        continue;
      }
      bySeq.set(parsed.seq, parsed);
    }

    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
}
