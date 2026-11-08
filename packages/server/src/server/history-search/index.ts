import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { searchableBlocks, searchPattern } from "../agent/chat-search/index.js";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * Message text of every agent this daemon has seen, so history can be searched without
 * resuming sessions. Paseo keeps no durable timeline of its own, and loading an old agent
 * resumes its provider session, so an agent enters the index when a turn of it ends or when it
 * is opened and its history loads. Agents never opened since this shipped are not indexed.
 */

export interface IndexedMessage {
  /** The projected timeline seq the in-chat find navigates to. */
  seq: number;
  role: "user" | "assistant";
  text: string;
}

interface IndexFile {
  agentId: string;
  title: string | null;
  cwd: string;
  workspaceId: string | null;
  provider: string;
  updatedAt: string;
  messages: IndexedMessage[];
}

export interface HistorySearchHit {
  agentId: string;
  title: string | null;
  cwd: string;
  workspaceId: string | null;
  provider: string;
  updatedAt: string;
  seq: number;
  role: "user" | "assistant";
  snippet: string;
  /** Matches in this agent, for "n more in this chat". */
  agentMatchCount: number;
}

export interface HistorySearchResult {
  hits: HistorySearchHit[];
  indexedAgents: number;
  truncated: boolean;
}

export interface IndexableAgent {
  id: string;
  cwd: string;
  workspaceId?: string;
  provider: string;
  updatedAt: Date;
  internal?: boolean;
  config: { title?: string | null };
}

const SNIPPET_CONTEXT = 60;

export function messagesFromRows(rows: readonly AgentTimelineRow[]): IndexedMessage[] {
  const messages: IndexedMessage[] = [];
  for (const row of rows) {
    const item = row.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const text = item.text.replace(/\r/g, "").trim();
    if (!text) continue;
    messages.push({
      seq: row.seq,
      role: item.type === "user_message" ? "user" : "assistant",
      text,
    });
  }
  return messages;
}

function searchableText(message: IndexedMessage): string {
  // Assistant Markdown is matched on what the reader sees, like the in-chat find.
  return message.role === "assistant" ? searchableBlocks(message.text).join("\n") : message.text;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Matches one agent's messages; the newest match first, as people search for recent work. */
export function searchIndexFile(file: IndexFile, query: string): HistorySearchHit[] {
  const pattern = searchPattern(query);
  const matches: Array<{ message: IndexedMessage; text: string; index: number; length: number }> =
    [];
  for (const message of file.messages) {
    const text = searchableText(message);
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) matches.push({ message, text, index: match.index, length: match[0].length });
  }
  return matches.toReversed().map(({ message, text, index, length }) => ({
    agentId: file.agentId,
    title: file.title,
    cwd: file.cwd,
    workspaceId: file.workspaceId,
    provider: file.provider,
    updatedAt: file.updatedAt,
    seq: message.seq,
    role: message.role,
    snippet: snippetAround(text, index, length),
    agentMatchCount: matches.length,
  }));
}

export class HistoryTextIndex {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly readRows: (agentId: string) => Promise<AgentTimelineRow[]>;
  private readonly delayMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, IndexableAgent>();

  constructor(input: {
    dir: string;
    logger: Logger;
    readRows: (agentId: string) => Promise<AgentTimelineRow[]>;
    /** Coalesces the bursts of state changes around a turn's end. */
    delayMs?: number;
  }) {
    this.dir = input.dir;
    this.logger = input.logger.child({ module: "history-search" });
    this.readRows = input.readRows;
    this.delayMs = input.delayMs ?? 5000;
  }

  /** Called for every agent state change; indexes agents that are not mid-turn. */
  observe(agent: IndexableAgent & { lifecycle: string }): void {
    if (agent.internal || agent.lifecycle === "running" || agent.lifecycle === "initializing") {
      return;
    }
    this.pending.set(agent.id, agent);
    if (this.timers.has(agent.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(agent.id);
      const latest = this.pending.get(agent.id);
      this.pending.delete(agent.id);
      if (latest) void this.index(latest);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(agent.id, timer);
  }

  async index(agent: IndexableAgent): Promise<void> {
    try {
      const messages = messagesFromRows(await this.readRows(agent.id));
      if (messages.length === 0) return;
      const file: IndexFile = {
        agentId: agent.id,
        title: agent.config.title ?? null,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId ?? null,
        provider: agent.provider,
        updatedAt: agent.updatedAt.toISOString(),
        messages,
      };
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.fileFor(agent.id), JSON.stringify(file));
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Failed to index agent history");
    }
  }

  async remove(agentId: string): Promise<void> {
    await rm(this.fileFor(agentId), { force: true });
  }

  async search(query: string, limit = 50): Promise<HistorySearchResult> {
    if (!query.trim()) return { hits: [], indexedAgents: 0, truncated: false };
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return { hits: [], indexedAgents: 0, truncated: false };
    }
    const hits: HistorySearchHit[] = [];
    for (const name of names) {
      try {
        const file = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as IndexFile;
        hits.push(...searchIndexFile(file, query));
      } catch (error) {
        this.logger.warn({ err: error, file: name }, "Skipping unreadable history index file");
      }
      // A large index must not stall the daemon's event loop.
      await setImmediate();
    }
    hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq);
    return {
      hits: hits.slice(0, limit),
      indexedAgents: names.length,
      truncated: hits.length > limit,
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private fileFor(agentId: string): string {
    return path.join(this.dir, `${encodeURIComponent(agentId)}.json`);
  }
}

// The running daemon's index, read by sessions and server_info; null in tests and embedders
// that do not start one.
let activeIndex: HistoryTextIndex | null = null;

export function setActiveHistoryTextIndex(index: HistoryTextIndex | null): void {
  activeIndex = index;
}

export function getActiveHistoryTextIndex(): HistoryTextIndex | null {
  return activeIndex;
}
