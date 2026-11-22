import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type JsonValue = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

/** A T3 turn item as it arrives: only the fields read here are relied on. */
export type T3TurnItem = Record<string, unknown> & { id: string; type: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

export function readTurnItem(value: unknown): T3TurnItem | undefined {
  const item = record(value);
  return typeof item.id === "string" && typeof item.type === "string"
    ? (item as T3TurnItem)
    : undefined;
}

type ToolStatus = "running" | "completed" | "canceled" | "failed";

function toolStatus(item: T3TurnItem): ToolStatus {
  switch (item.status) {
    case "completed":
      return item.type === "command_execution" &&
        typeof item.exitCode === "number" &&
        item.exitCode !== 0
        ? "failed"
        : "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "canceled";
    default:
      return "running";
  }
}

function toolCall(
  item: T3TurnItem,
  name: string,
  detail: ProviderToolCallDetail,
  errorMessage?: string,
): ProviderTimelineItem {
  const status = toolStatus(item);
  const base = { type: "tool_call" as const, id: item.id, callId: item.id, name, detail };
  return status === "failed"
    ? { ...base, status, error: errorMessage ?? text(item.title) ?? "Failed" }
    : { ...base, status, error: null };
}

type Mapper = (
  item: T3TurnItem,
  clientMessageIds: ReadonlyMap<string, string>,
) => ProviderTimelineItem | undefined;

function noticeLevel(level: unknown): "info" | "warning" | "error" {
  if (level === "error") return "error";
  if (level === "warning") return "warning";
  return "info";
}

function todoStatus(status: unknown): "pending" | "in_progress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "running") return "in_progress";
  return "pending";
}

function fileChangeDetail(item: T3TurnItem): ProviderToolCallDetail {
  const filePath = text(item.fileName) ?? "";
  const diff = text(item.diffStr);
  const oldString = text(item.oldStr);
  const newString = text(item.newStr);
  if (oldString === undefined && newString !== undefined && diff === undefined) {
    return { type: "write", filePath, content: newString };
  }
  return {
    type: "edit",
    filePath,
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
    ...(diff !== undefined ? { unifiedDiff: diff } : {}),
  };
}

function notification(item: T3TurnItem, message: string, level: unknown = "info") {
  return { type: "notification" as const, id: item.id, level: noticeLevel(level), message };
}

const contextMoved: Mapper = (item) =>
  notification(item, text(item.title) ?? "T3 moved this conversation's context.");

const MAPPERS: Record<string, Mapper> = {
  user_message(item, clientMessageIds) {
    const messageId = text(item.messageId);
    const clientMessageId = messageId ? clientMessageIds.get(messageId) : undefined;
    return {
      type: "user_message",
      id: item.id,
      text: text(item.text) ?? "",
      ...(messageId ? { messageId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    };
  },
  assistant_message: (item) => ({
    type: "assistant_message",
    id: item.id,
    text: text(item.text) ?? "",
    ...(text(item.messageId) ? { messageId: text(item.messageId) } : {}),
  }),
  reasoning: (item) => ({ type: "reasoning", id: item.id, text: text(item.text) ?? "" }),
  command_execution: (item) =>
    toolCall(item, "shell", {
      type: "shell",
      command: text(item.input) ?? "",
      ...(text(item.output) !== undefined ? { output: text(item.output) } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    }),
  file_change: (item) => toolCall(item, "edit", fileChangeDetail(item)),
  file_search(item) {
    const results = Array.isArray(item.results) ? item.results.map(record) : [];
    const filePaths = [...new Set(results.flatMap((result) => text(result.fileName) ?? []))];
    return toolCall(item, "search", {
      type: "search",
      query: text(item.pattern) ?? text(item.title) ?? "",
      toolName: "grep",
      filePaths,
      numFiles: filePaths.length,
      numMatches: results.length,
    });
  },
  web_search(item) {
    const results = Array.isArray(item.results) ? item.results.map(record) : [];
    const patterns = Array.isArray(item.patterns) ? item.patterns.map(String) : [];
    return toolCall(item, "web_search", {
      type: "search",
      query: patterns.join(", ") || (text(item.title) ?? ""),
      toolName: "web_search",
      webResults: results.flatMap((result) => {
        const url = text(result.url);
        return url ? [{ title: text(result.title) ?? url, url }] : [];
      }),
    });
  },
  dynamic_tool: (item) =>
    toolCall(item, text(item.toolName) ?? "tool", {
      type: "unknown",
      input: json(item.input),
      output: json(item.output),
    }),
  subagent: (item) =>
    toolCall(item, "subagent", {
      type: "sub_agent",
      description: text(item.prompt),
      log: text(item.result) ?? text(item.progress) ?? "",
    }),
  proposed_plan: (item) =>
    toolCall(item, "plan", { type: "plan", text: text(item.markdown) ?? "" }),
  todo_list(item) {
    const steps = Array.isArray(item.steps) ? item.steps.map(record) : [];
    return {
      type: "todo",
      id: item.id,
      items: steps.map((step) => {
        const status = todoStatus(step.status);
        const id = text(step.id);
        const entry: { text: string; completed: boolean; status: typeof status; id?: string } = {
          text: text(step.text) ?? "",
          completed: status === "completed",
          status,
        };
        if (id) entry.id = id;
        return entry;
      }),
    };
  },
  compaction: (item) => ({
    type: "compaction",
    id: item.id,
    status: item.status === "completed" ? "completed" : "loading",
    ...(typeof item.beforeTokenCount === "number" ? { preTokens: item.beforeTokenCount } : {}),
  }),
  error: (item) => ({
    type: "error",
    id: item.id,
    message: text(record(item.failure).message) ?? "Antigravity reported an error.",
  }),
  system_notice: (item) => notification(item, text(item.message) ?? "", item.level),
  notification: (item) =>
    notification(item, [text(item.summary), text(item.detail)].filter(Boolean).join("\n")),
  run_interrupt_result: (item) => notification(item, text(item.message) ?? ""),
  link_request: (item) =>
    notification(
      item,
      item.linkStatus === "pending"
        ? "Antigravity asked to link another T3 environment. Paseo does not link environments; it keeps working without one."
        : "Antigravity asked to link another T3 environment.",
      "warning",
    ),
  fork: contextMoved,
  handoff: contextMoved,
  thread_created: contextMoved,
};

/**
 * Maps one T3 turn item onto Paseo's timeline. Items with no Paseo counterpart, or that only
 * mark T3's own bookkeeping, map to nothing. Approval, question and secret items surface as
 * permissions instead.
 */
export function mapTurnItem(
  item: T3TurnItem,
  clientMessageIds: ReadonlyMap<string, string>,
): ProviderTimelineItem | undefined {
  return Object.hasOwn(MAPPERS, item.type) ? MAPPERS[item.type](item, clientMessageIds) : undefined;
}
