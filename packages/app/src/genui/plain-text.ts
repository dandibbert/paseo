import type { RenderUiInput } from "@getpaseo/protocol/genui/render-ui-schema";
import {
  deriveRenderUiValues,
  readPieSlices,
  type RenderUiNode,
} from "@getpaseo/protocol/genui/render-ui-validate";
import {
  computeProgress,
  DEFAULT_CHANGE_PERCENT_PRECISION,
} from "@getpaseo/protocol/genui/compute";
import { formatCell, formatSignedPercent, formatWithUnit } from "./format";

// Plain-text rendering of a card for "Copy as text". The model's fallbackText wins;
// otherwise the text is generated from the validated data so nothing is invented.
export function buildRenderUiPlainText(input: RenderUiInput): string {
  if (input.fallbackText) {
    return input.fallbackText;
  }
  return describeNode(input).join("\n");
}

// The validated data as text, ignoring fallbackText. Backs "View data".
export function buildRenderUiDataText(input: RenderUiInput): string {
  return describeNode(input).join("\n");
}

function withTitle(node: RenderUiNode, lines: string[]): string[] {
  return node.title ? [node.title, ...lines] : lines;
}

function describeNode(node: RenderUiNode): string[] {
  switch (node.type) {
    case "metricComparison": {
      const derived = deriveRenderUiValues(node);
      const items = node.data.items.map(
        (item) => `${item.label}: ${formatWithUnit(item.value, item.unit)}`,
      );
      const change =
        "changePercent" in derived
          ? formatSignedPercent(
              derived.changePercent,
              node.data.compare.precision ?? DEFAULT_CHANGE_PERCENT_PRECISION,
            )
          : null;
      return withTitle(node, change ? [...items, change] : items);
    }
    case "metric":
      return withTitle(node, [
        `${node.data.label}: ${formatWithUnit(node.data.value, node.data.unit)}`,
      ]);
    case "progress": {
      const { percent } = computeProgress(node.data);
      return withTitle(node, [
        `${node.data.label}: ${formatWithUnit(node.data.current, node.data.unit)} / ${formatWithUnit(node.data.total, node.data.unit)} (${percent}%)`,
      ]);
    }
    case "chart.bar":
    case "chart.line": {
      const { data } = node;
      const header = [data.x, ...data.series.map((series) => series.label)].join("\t");
      const rows = data.rows.map((row) =>
        [
          formatCell(row[data.x]),
          ...data.series.map((series) => formatCell(row[series.field])),
        ].join("\t"),
      );
      return withTitle(node, data.yUnit ? [header, ...rows, data.yUnit] : [header, ...rows]);
    }
    case "chart.pie": {
      const derived = deriveRenderUiValues(node);
      const slices = readPieSlices(node.data);
      const shares = "shares" in derived ? derived.shares : [];
      return withTitle(
        node,
        slices.map(
          (slice, index) =>
            `${slice.label}: ${formatWithUnit(slice.value, node.data.unit)} (${shares[index]?.percent ?? 0}%)`,
        ),
      );
    }
    case "table": {
      const { columns, rows } = node.data;
      return withTitle(node, [
        columns.map((column) => column.label).join("\t"),
        ...rows.map((row) => columns.map((column) => formatCell(row[column.field])).join("\t")),
      ]);
    }
    case "priorityList":
      return withTitle(
        node,
        node.data.items.map((item) => `- ${item.title}: ${item.body}`),
      );
    case "steps":
      return withTitle(
        node,
        node.data.items.map((item, index) =>
          [
            `${index + 1}.`,
            item.status ? `[${item.status}]` : null,
            item.meta ? `${item.meta} ·` : null,
            item.body ? `${item.title}: ${item.body}` : item.title,
          ]
            .filter((part): part is string => part !== null)
            .join(" "),
        ),
      );
    case "card":
    case "grid":
      return withTitle(
        node,
        node.data.children.flatMap((child) => describeNode(child)),
      );
  }
}
