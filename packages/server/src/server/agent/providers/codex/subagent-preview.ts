import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { curateAgentActivity } from "../../activity-curator.js";

export const SUBAGENT_PREVIEW_MAX_BYTES = 8 * 1024;
const MAX_ITEM_BYTES = 2 * 1024;
const MAX_ITEMS = 32;
const TRUNCATION_NOTICE =
  "[Earlier activity omitted from preview; open the subagent for full history.]\n";

function tailUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  // Copy rather than retaining a V8 sliced string backed by the complete history.
  return bytes.toString("utf8", start);
}

/** The parent card is a preview; the independent provider-subagent timeline owns history. */
export class CodexSubagentPreview {
  private readonly entries = new Map<string, string>();
  private truncated = false;
  private bytes = 0;

  upsert(id: string, item: AgentTimelineItem): void {
    const summary = curateAgentActivity([item], { labelAssistantMessages: true });
    const text = tailUtf8(summary, MAX_ITEM_BYTES);
    this.truncated ||= text !== summary;
    this.bytes -= Buffer.byteLength(this.entries.get(id) ?? "", "utf8");
    this.entries.set(id, text);
    this.bytes += Buffer.byteLength(text, "utf8");
    const budget = SUBAGENT_PREVIEW_MAX_BYTES - Buffer.byteLength(TRUNCATION_NOTICE) - MAX_ITEMS;
    while (this.entries.size > MAX_ITEMS || this.bytes > budget) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= Buffer.byteLength(this.entries.get(oldest) ?? "", "utf8");
      this.entries.delete(oldest);
      this.truncated = true;
    }
  }

  render(): string {
    return (this.truncated ? TRUNCATION_NOTICE : "") + [...this.entries.values()].join("\n");
  }
}
