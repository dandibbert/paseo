import {
  computeChangePercent,
  computePieShares,
  computeProgress,
  type ChangePercentResult,
} from "./compute.js";
import {
  RenderUiInputSchema,
  type CartesianChartData,
  type MetricComparisonData,
  type PieChartData,
  type RenderUiCardChild,
  type RenderUiGridChild,
  type RenderUiInput,
  type RenderUiType,
  type TableData,
} from "./render-ui-schema.js";

// Allowed gap between 100 and the sum of a `unit: "%"` pie. Models round each slice to a
// whole number, so three equal slices legitimately sum to 99.
const PERCENT_PIE_TOLERANCE = 1;

export type RenderUiIssuePath = Array<string | number>;

export interface RenderUiIssue {
  path: RenderUiIssuePath;
  message: string;
}

export interface PieDerived {
  total: number;
  shares: Array<{ label: string; percent: number }>;
}

export interface ContainerDerived {
  children: RenderUiDerived[];
}

export type RenderUiDerived =
  | ChangePercentResult
  | { percent: number }
  | PieDerived
  | ContainerDerived
  | Record<string, never>;

export type RenderUiValidationResult =
  | { ok: true; input: RenderUiInput; derived: RenderUiDerived }
  | { ok: false; type: RenderUiType | null; issues: RenderUiIssue[] };

// Any component that can appear in a validated tree: the top-level input or a nested child.
export type RenderUiNode = RenderUiInput | RenderUiCardChild | RenderUiGridChild;

export function validateRenderUiInput(raw: unknown): RenderUiValidationResult {
  const parsed = RenderUiInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      type: readDeclaredType(raw),
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter((segment) => typeof segment !== "symbol"),
        message: issue.message,
      })),
    };
  }
  const issues: RenderUiIssue[] = [];
  collectSemanticIssues(parsed.data, ["data"], issues);
  if (issues.length > 0) {
    return { ok: false, type: parsed.data.type, issues };
  }
  return { ok: true, input: parsed.data, derived: deriveRenderUiValues(parsed.data) };
}

function readDeclaredType(raw: unknown): RenderUiType | null {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return null;
  }
  const result = RenderUiInputSchema.options.find((option) => option.shape.type.value === raw.type);
  return result ? result.shape.type.value : null;
}

// Expects input that already passed RenderUiInputSchema.
export function deriveRenderUiValues(component: RenderUiNode): RenderUiDerived {
  switch (component.type) {
    case "metricComparison":
      return deriveMetricComparison(component.data);
    case "progress":
      return { percent: computeProgress(component.data).percent };
    case "chart.pie":
      return derivePie(component.data);
    case "card":
    case "grid":
      return { children: component.data.children.map((child) => deriveRenderUiValues(child)) };
    default:
      return {};
  }
}

function deriveMetricComparison(data: MetricComparisonData): ChangePercentResult {
  const from = data.items.find((item) => item.id === data.compare.from);
  const to = data.items.find((item) => item.id === data.compare.to);
  if (!from || !to) {
    throw new Error("metricComparison compare ids must be validated before deriving values");
  }
  return computeChangePercent({
    from: from.value,
    to: to.value,
    precision: data.compare.precision,
  });
}

export function readPieSlices(data: PieChartData): Array<{ label: string; value: number }> {
  return data.rows.map((row) => {
    const label = row[data.labelField];
    const value = row[data.valueField];
    return {
      label: typeof label === "string" ? label : String(label),
      value: typeof value === "number" ? value : 0,
    };
  });
}

function derivePie(data: PieChartData): PieDerived {
  const slices = readPieSlices(data);
  const result = computePieShares(slices.map((slice) => slice.value));
  return {
    total: result.total,
    shares: slices.map((slice, index) => ({
      label: slice.label,
      percent: result.shares[index].percent,
    })),
  };
}

function collectSemanticIssues(
  component: RenderUiNode,
  dataPath: RenderUiIssuePath,
  issues: RenderUiIssue[],
): void {
  switch (component.type) {
    case "metricComparison":
      checkMetricComparison(component.data, dataPath, issues);
      return;
    case "chart.bar":
    case "chart.line":
      checkCartesianChart(component.data, dataPath, issues);
      return;
    case "chart.pie":
      checkPieChart(component.data, dataPath, issues);
      return;
    case "table":
      checkTable(component.data, dataPath, issues);
      return;
    case "card":
    case "grid":
      component.data.children.forEach((child, index) => {
        collectSemanticIssues(child, [...dataPath, "children", index, "data"], issues);
      });
      return;
    default:
      return;
  }
}

function checkMetricComparison(
  data: MetricComparisonData,
  path: RenderUiIssuePath,
  issues: RenderUiIssue[],
): void {
  const ids = data.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    issues.push({ path: [...path, "items"], message: "item ids must be unique" });
    return;
  }
  const from = data.items.find((item) => item.id === data.compare.from);
  const to = data.items.find((item) => item.id === data.compare.to);
  if (!from) {
    issues.push({
      path: [...path, "compare", "from"],
      message: `"${data.compare.from}" is not one of the item ids (${ids.join(", ")})`,
    });
  }
  if (!to) {
    issues.push({
      path: [...path, "compare", "to"],
      message: `"${data.compare.to}" is not one of the item ids (${ids.join(", ")})`,
    });
  }
  if (!from || !to) {
    return;
  }
  if (from.id === to.id) {
    issues.push({ path: [...path, "compare"], message: "compare.from and compare.to must differ" });
  }
  if (from.unit !== to.unit) {
    issues.push({
      path: [...path, "items"],
      message: "both items must use the same unit to compute changePercent",
    });
  }
}

function checkCartesianChart(
  data: CartesianChartData,
  path: RenderUiIssuePath,
  issues: RenderUiIssue[],
): void {
  const fields = data.series.map((series) => series.field);
  if (new Set(fields).size !== fields.length) {
    issues.push({ path: [...path, "series"], message: "series fields must be unique" });
  }
  data.series.forEach((series, index) => {
    if (series.field === data.x) {
      issues.push({
        path: [...path, "series", index, "field"],
        message: `series field "${series.field}" is the x field; series must be numeric fields`,
      });
    }
  });
  data.rows.forEach((row, rowIndex) => {
    const xValue = row[data.x];
    if (xValue === undefined || xValue === null) {
      issues.push({
        path: [...path, "rows", rowIndex, data.x],
        message: `row is missing the x field "${data.x}"`,
      });
    }
    for (const field of fields) {
      if (!(field in row)) {
        issues.push({
          path: [...path, "rows", rowIndex, field],
          message: `row is missing series field "${field}" (use null for a missing value)`,
        });
        continue;
      }
      const value = row[field];
      if (value !== null && typeof value !== "number") {
        issues.push({
          path: [...path, "rows", rowIndex, field],
          message: `series value must be a number or null, got ${JSON.stringify(value)}`,
        });
      }
    }
  });
}

function checkPieChart(data: PieChartData, path: RenderUiIssuePath, issues: RenderUiIssue[]): void {
  const issueCountBefore = issues.length;
  let total = 0;
  data.rows.forEach((row, rowIndex) => {
    const label = row[data.labelField];
    const value = row[data.valueField];
    if (typeof label !== "string" || label.trim().length === 0) {
      issues.push({
        path: [...path, "rows", rowIndex, data.labelField],
        message: `labelField "${data.labelField}" must be a non-empty string`,
      });
    }
    if (typeof value !== "number" || value < 0) {
      issues.push({
        path: [...path, "rows", rowIndex, data.valueField],
        message: `valueField "${data.valueField}" must be a non-negative number`,
      });
      return;
    }
    total += value;
  });
  if (issues.length > issueCountBefore) {
    return;
  }
  if (total <= 0) {
    issues.push({ path: [...path, "rows"], message: "pie values must sum to more than zero" });
    return;
  }
  if (data.unit === "%" && Math.abs(total - 100) > PERCENT_PIE_TOLERANCE) {
    issues.push({
      path: [...path, "rows"],
      message: `percent slices sum to ${total}, expected about 100`,
    });
  }
}

function checkTable(data: TableData, path: RenderUiIssuePath, issues: RenderUiIssue[]): void {
  const fields = data.columns.map((column) => column.field);
  if (new Set(fields).size !== fields.length) {
    issues.push({ path: [...path, "columns"], message: "column fields must be unique" });
    return;
  }
  data.rows.forEach((row, rowIndex) => {
    for (const field of fields) {
      if (!(field in row)) {
        issues.push({
          path: [...path, "rows", rowIndex, field],
          message: `row is missing column "${field}" (use null for an empty cell)`,
        });
      }
    }
  });
}
