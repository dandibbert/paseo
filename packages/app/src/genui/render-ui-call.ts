import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  MetricComparisonItemSchema,
  PriorityListItemSchema,
  RenderUiTypeSchema,
  type MetricComparisonItem,
  type PriorityListItem,
  type RenderUiInput,
  type RenderUiType,
} from "@getpaseo/protocol/genui/render-ui-schema";
import { validateRenderUiInput } from "@getpaseo/protocol/genui/render-ui-validate";

// What the generating card may show before the call completes. Only fields that are
// complete and individually valid make it in, so the accepted card never contradicts it.
// Streaming providers (Claude) send a best-effort parse of the partial JSON, where the
// last string or number may still be growing ("7" before "7500"). A value is known to be
// complete only once a later key or array element exists, so the last one is withheld.
export interface RenderUiPreview {
  type: RenderUiType | null;
  title: string | null;
  metricItems: MetricComparisonItem[];
  priorityItems: PriorityListItem[];
}

export type RenderUiCardState =
  | { status: "generating"; preview: RenderUiPreview }
  | { status: "accepted"; input: RenderUiInput }
  // Completed, but this client cannot validate the input (for example a newer daemon
  // added a component type). Show the model's plain-text summary instead of a card.
  | { status: "unsupported"; fallbackText: string | null }
  | { status: "rejected" };

export type RenderUiCallStatus = "running" | "executing" | "completed" | "failed" | "canceled";

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Providers that stream raw argument text send incomplete JSON while generating.
    return null;
  }
}

export function readRenderUiInput(detail: ToolCallDetail): unknown {
  if (detail.type !== "unknown") {
    return null;
  }
  return typeof detail.input === "string" ? parseJsonObject(detail.input) : detail.input;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readValidItems<T>(
  value: unknown,
  parse: (item: unknown) => { success: true; data: T } | { success: false },
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: T[] = [];
  for (const item of value.slice(0, -1)) {
    const parsed = parse(item);
    if (!parsed.success) {
      break;
    }
    items.push(parsed.data);
  }
  return items;
}

function isClosedKey(keys: readonly string[], key: string): boolean {
  const index = keys.indexOf(key);
  return index !== -1 && index < keys.length - 1;
}

export function buildRenderUiPreview(raw: unknown): RenderUiPreview {
  const record = readRecord(raw);
  const keys = record ? Object.keys(record) : [];
  const type = RenderUiTypeSchema.safeParse(isClosedKey(keys, "type") ? record?.type : undefined);
  const title = isClosedKey(keys, "title") ? record?.title : undefined;
  const data = readRecord(record?.data);
  const resolvedType = type.success ? type.data : null;
  return {
    type: resolvedType,
    title: typeof title === "string" && title.trim().length > 0 ? title : null,
    metricItems:
      resolvedType === "metricComparison"
        ? readValidItems(data?.items, (item) => MetricComparisonItemSchema.safeParse(item))
        : [],
    priorityItems:
      resolvedType === "priorityList"
        ? readValidItems(data?.items, (item) => PriorityListItemSchema.safeParse(item))
        : [],
  };
}

function readFallbackText(raw: unknown): string | null {
  const fallbackText = readRecord(raw)?.fallbackText;
  return typeof fallbackText === "string" && fallbackText.trim().length > 0 ? fallbackText : null;
}

export function resolveRenderUiCardState(input: {
  status: RenderUiCallStatus;
  detail: ToolCallDetail;
}): RenderUiCardState {
  if (input.status === "failed" || input.status === "canceled") {
    return { status: "rejected" };
  }
  const raw = readRenderUiInput(input.detail);
  if (input.status !== "completed") {
    return { status: "generating", preview: buildRenderUiPreview(raw) };
  }
  const result = validateRenderUiInput(raw);
  if (result.ok) {
    return { status: "accepted", input: result.input };
  }
  return { status: "unsupported", fallbackText: readFallbackText(raw) };
}
