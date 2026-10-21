import { z } from "zod";

// Strict render_ui v1 component schemas. Mirrors design/genui/schemas/render-ui.v1.schema.json.
// The daemon validates tool input with these and the app re-validates before rendering,
// so a card only ever shows data both sides accepted. Cross-field rules (field
// references, units, totals) live in render-ui-validate.ts.

export const RENDER_UI_TOOL_NAME = "render_ui";
export const RENDER_UI_SCHEMA_VERSION = 1;
export const RENDER_UI_MAX_INPUT_BYTES = 16 * 1024;

const ShortTextSchema = z.string().min(1).max(160);
const DetailTextSchema = z.string().min(1).max(220);
const CellValueSchema = z.union([z.string(), z.number(), z.null()]);
const RowSchema = z.record(z.string(), CellValueSchema);

export const RENDER_UI_LEAF_TYPES = [
  "metricComparison",
  "metric",
  "progress",
  "chart.bar",
  "chart.line",
  "chart.pie",
  "table",
  "priorityList",
  "steps",
] as const;

export const RENDER_UI_TYPES = [...RENDER_UI_LEAF_TYPES, "card", "grid"] as const;

export const RenderUiTypeSchema = z.enum(RENDER_UI_TYPES);
export type RenderUiType = z.infer<typeof RenderUiTypeSchema>;

export const ChangeIntentSchema = z.enum(["good", "bad", "neutral"]);
export type ChangeIntent = z.infer<typeof ChangeIntentSchema>;

export const PriorityDecisionSchema = z.enum(["change", "adjust", "keep"]);
export type PriorityDecision = z.infer<typeof PriorityDecisionSchema>;

export const PriorityLevelSchema = z.enum(["high", "medium", "low"]);
export type PriorityLevel = z.infer<typeof PriorityLevelSchema>;

export const StepStatusSchema = z.enum(["done", "current", "todo", "blocked"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const BarOrientationSchema = z.enum(["vertical", "horizontal"]);
export type BarOrientation = z.infer<typeof BarOrientationSchema>;

// A horizontal bar chart grows one band per row, so it takes fewer rows than a vertical one.
export const HORIZONTAL_BAR_MAX_ROWS = 40;

export const MetricComparisonItemSchema = z.strictObject({
  id: ShortTextSchema,
  label: ShortTextSchema,
  value: z.number(),
  unit: ShortTextSchema.optional(),
  detail: DetailTextSchema.optional(),
});
export type MetricComparisonItem = z.infer<typeof MetricComparisonItemSchema>;

export const MetricComparisonDataSchema = z.strictObject({
  items: z.array(MetricComparisonItemSchema).length(2),
  compare: z.strictObject({
    from: ShortTextSchema,
    to: ShortTextSchema,
    metric: z.literal("changePercent"),
    precision: z.number().int().min(0).max(3).optional(),
    changeIntent: ChangeIntentSchema.optional(),
  }),
});
export type MetricComparisonData = z.infer<typeof MetricComparisonDataSchema>;

export const MetricDataSchema = z.strictObject({
  label: ShortTextSchema,
  value: z.number(),
  unit: ShortTextSchema.optional(),
  detail: DetailTextSchema.optional(),
});
export type MetricData = z.infer<typeof MetricDataSchema>;

export const ProgressDataSchema = z.strictObject({
  label: ShortTextSchema,
  current: z.number().min(0),
  total: z.number().gt(0),
  unit: ShortTextSchema.optional(),
  detail: DetailTextSchema.optional(),
});
export type ProgressData = z.infer<typeof ProgressDataSchema>;

export const ChartSeriesSchema = z.strictObject({
  field: ShortTextSchema,
  label: ShortTextSchema,
});
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

export const CartesianChartDataSchema = z.strictObject({
  description: DetailTextSchema.optional(),
  x: ShortTextSchema,
  series: z.array(ChartSeriesSchema).min(1).max(6),
  rows: z.array(RowSchema).min(1).max(200),
  yUnit: ShortTextSchema.optional(),
});
export type CartesianChartData = z.infer<typeof CartesianChartDataSchema>;

// Omitted orientation lets the app pick: vertical, or horizontal when category labels
// would not fit under vertical bars.
export const BarChartDataSchema = CartesianChartDataSchema.extend({
  orientation: BarOrientationSchema.optional(),
});
export type BarChartData = z.infer<typeof BarChartDataSchema>;

export const PieChartDataSchema = z.strictObject({
  description: DetailTextSchema.optional(),
  labelField: ShortTextSchema,
  valueField: ShortTextSchema,
  rows: z.array(RowSchema).min(2).max(24),
  unit: ShortTextSchema.optional(),
});
export type PieChartData = z.infer<typeof PieChartDataSchema>;

export const TableDataSchema = z.strictObject({
  description: DetailTextSchema.optional(),
  columns: z.array(ChartSeriesSchema).min(2).max(12),
  rows: z.array(RowSchema).min(1).max(50),
});
export type TableData = z.infer<typeof TableDataSchema>;

export const PriorityListItemSchema = z.strictObject({
  decision: PriorityDecisionSchema,
  priority: PriorityLevelSchema.optional(),
  title: ShortTextSchema,
  body: z.string().min(1).max(4000),
});
export type PriorityListItem = z.infer<typeof PriorityListItemSchema>;

export const PriorityListDataSchema = z.strictObject({
  items: z.array(PriorityListItemSchema).min(1).max(12),
});
export type PriorityListData = z.infer<typeof PriorityListDataSchema>;

export const StepItemSchema = z.strictObject({
  title: ShortTextSchema,
  body: z.string().min(1).max(1000).optional(),
  meta: ShortTextSchema.optional(),
  status: StepStatusSchema.optional(),
});
export type StepItem = z.infer<typeof StepItemSchema>;

export const StepsDataSchema = z.strictObject({
  items: z.array(StepItemSchema).min(1).max(20),
});
export type StepsData = z.infer<typeof StepsDataSchema>;

// Follow-up buttons under a top-level card. Pressing one sends `prompt` to the agent that
// drew the card, as the user, after the user confirms the exact text.
export const RenderUiActionSchema = z.strictObject({
  label: z.string().min(1).max(40),
  prompt: z.string().min(1).max(2000),
});
export type RenderUiAction = z.infer<typeof RenderUiActionSchema>;

function leafComponent<TType extends string, TData extends z.ZodType>(type: TType, data: TData) {
  return z.strictObject({
    type: z.literal(type),
    title: ShortTextSchema.optional(),
    data,
  });
}

export const RenderUiLeafSchema = z.discriminatedUnion("type", [
  leafComponent("metricComparison", MetricComparisonDataSchema),
  leafComponent("metric", MetricDataSchema),
  leafComponent("progress", ProgressDataSchema),
  leafComponent("chart.bar", BarChartDataSchema),
  leafComponent("chart.line", CartesianChartDataSchema),
  leafComponent("chart.pie", PieChartDataSchema),
  leafComponent("table", TableDataSchema),
  leafComponent("priorityList", PriorityListDataSchema),
  leafComponent("steps", StepsDataSchema),
]);
export type RenderUiLeaf = z.infer<typeof RenderUiLeafSchema>;

export const CardDataSchema = z.strictObject({
  children: z.array(RenderUiLeafSchema).min(1).max(4),
});
export type CardData = z.infer<typeof CardDataSchema>;

const CardComponentSchema = leafComponent("card", CardDataSchema);

export const GridDataSchema = z.strictObject({
  children: z
    .array(z.discriminatedUnion("type", [...RenderUiLeafSchema.options, CardComponentSchema]))
    .min(2)
    .max(4),
});
export type GridData = z.infer<typeof GridDataSchema>;

export const RenderUiComponentSchema = z.discriminatedUnion("type", [
  ...RenderUiLeafSchema.options,
  CardComponentSchema,
  leafComponent("grid", GridDataSchema),
]);
export type RenderUiComponent = z.infer<typeof RenderUiComponentSchema>;
export type RenderUiCardChild = CardData["children"][number];
export type RenderUiGridChild = GridData["children"][number];

// Top-level tool input: a component plus the envelope fields only the outermost call carries.
function topLevelComponent<TType extends string, TData extends z.ZodType>(
  type: TType,
  data: TData,
) {
  return z.strictObject({
    type: z.literal(type),
    title: ShortTextSchema.optional(),
    data,
    fallbackText: z.string().min(1).max(1000).optional(),
    actions: z.array(RenderUiActionSchema).min(1).max(4).optional(),
    schemaVersion: z.literal(RENDER_UI_SCHEMA_VERSION).optional(),
  });
}

export const RenderUiInputSchema = z.discriminatedUnion("type", [
  topLevelComponent("metricComparison", MetricComparisonDataSchema),
  topLevelComponent("metric", MetricDataSchema),
  topLevelComponent("progress", ProgressDataSchema),
  topLevelComponent("chart.bar", BarChartDataSchema),
  topLevelComponent("chart.line", CartesianChartDataSchema),
  topLevelComponent("chart.pie", PieChartDataSchema),
  topLevelComponent("table", TableDataSchema),
  topLevelComponent("priorityList", PriorityListDataSchema),
  topLevelComponent("steps", StepsDataSchema),
  topLevelComponent("card", CardDataSchema),
  topLevelComponent("grid", GridDataSchema),
]);
export type RenderUiInput = z.infer<typeof RenderUiInputSchema>;
