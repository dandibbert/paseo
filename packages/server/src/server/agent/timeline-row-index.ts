import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/** Only fields that determine projection identity/grouping belong in the resident index. */
function projectionItem(item: AgentTimelineItem): AgentTimelineItem {
  switch (item.type) {
    case "assistant_message":
      return {
        type: item.type,
        text: "",
        ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
      };
    case "user_message":
      return {
        type: item.type,
        text: "",
        ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
        ...(item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
      };
    case "reasoning":
      return { type: item.type, text: "" };
    case "tool_call":
      return {
        type: item.type,
        callId: item.callId,
        name: "",
        status: item.status,
        error: null,
        detail: { type: "unknown", input: null, output: null },
      };
    case "plugin":
      return {
        type: item.type,
        id: item.id,
        pluginId: item.pluginId,
        kind: "",
        version: item.version,
        data: null,
      };
    case "todo":
      return { type: item.type, items: [] };
    case "error":
      return { type: item.type, message: "" };
    case "notification":
      return { type: item.type, level: item.level, message: "" };
    case "compaction":
      return { type: item.type, status: item.status };
  }
}

export function timelineProjectionIndexRow(row: AgentTimelineRow): AgentTimelineRow {
  return {
    seq: row.seq,
    timestamp: row.timestamp,
    item: projectionItem(row.item),
    ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
    ...(row.providerMessageId !== undefined ? { providerMessageId: row.providerMessageId } : {}),
  };
}
