import { describe, expect, it } from "vitest";
import { validateRenderUiInput } from "@getpaseo/protocol/genui/render-ui-validate";
import { buildRenderUiPlainText } from "./plain-text";
import { resolveRenderUiCardState } from "./render-ui-call";

const metricComparison = {
  type: "metricComparison",
  title: "30 天理论最高额度",
  data: {
    items: [
      { id: "old", label: "旧套餐", value: 7500, unit: "HC" },
      { id: "new", label: "新套餐", value: 1071, unit: "HC" },
    ],
    compare: { from: "old", to: "new", metric: "changePercent", precision: 1, changeIntent: "bad" },
  },
};

function unknownDetail(input: unknown) {
  return { type: "unknown" as const, input, output: null };
}

describe("resolveRenderUiCardState", () => {
  it("renders validated data once the call completes", () => {
    const state = resolveRenderUiCardState({
      status: "completed",
      detail: unknownDetail(metricComparison),
    });
    expect(state.status).toBe("accepted");
  });

  it("parses argument text from providers that send raw JSON", () => {
    const state = resolveRenderUiCardState({
      status: "completed",
      detail: unknownDetail(JSON.stringify(metricComparison)),
    });
    expect(state.status).toBe("accepted");
  });

  it("collapses failed and canceled calls", () => {
    for (const status of ["failed", "canceled"] as const) {
      expect(resolveRenderUiCardState({ status, detail: unknownDetail(metricComparison) })).toEqual(
        { status: "rejected" },
      );
    }
  });

  it("falls back to the plain-text summary for data this client cannot validate", () => {
    expect(
      resolveRenderUiCardState({
        status: "completed",
        detail: unknownDetail({ type: "chart.radar", data: {}, fallbackText: "雷达图摘要" }),
      }),
    ).toEqual({ status: "unsupported", fallbackText: "雷达图摘要" });
  });

  it("previews only the complete, valid prefix while generating", () => {
    const state = resolveRenderUiCardState({
      status: "running",
      detail: unknownDetail({
        type: "metricComparison",
        title: "30 天理论最高额度",
        data: {
          items: [
            { id: "old", label: "旧套餐", value: 7500, unit: "HC" },
            { id: "new", label: "新" },
          ],
        },
      }),
    });
    expect(state).toEqual({
      status: "generating",
      preview: {
        type: "metricComparison",
        title: "30 天理论最高额度",
        metricItems: [{ id: "old", label: "旧套餐", value: 7500, unit: "HC" }],
        priorityItems: [],
      },
    });
  });

  it("shows a bare skeleton for incomplete argument text", () => {
    expect(
      resolveRenderUiCardState({ status: "running", detail: unknownDetail('{"type":"chart.b') }),
    ).toEqual({
      status: "generating",
      preview: { type: null, title: null, metricItems: [], priorityItems: [] },
    });
  });
});

describe("buildRenderUiPlainText", () => {
  function accepted(input: unknown) {
    const result = validateRenderUiInput(input);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    return result.input;
  }

  it("prefers the model's fallbackText", () => {
    expect(buildRenderUiPlainText(accepted({ ...metricComparison, fallbackText: "摘要" }))).toBe(
      "摘要",
    );
  });

  it("generates text from validated data without a fallback", () => {
    expect(buildRenderUiPlainText(accepted(metricComparison))).toBe(
      ["30 天理论最高额度", "旧套餐: 7,500 HC", "新套餐: 1,071 HC", "-85.7%"].join("\n"),
    );
  });

  it("writes missing table cells as a dash", () => {
    expect(
      buildRenderUiPlainText(
        accepted({
          type: "table",
          data: {
            columns: [
              { field: "name", label: "方案" },
              { field: "cost", label: "价格" },
            ],
            rows: [{ name: "A", cost: null }],
          },
        }),
      ),
    ).toBe("方案\t价格\nA\t—");
  });
});
