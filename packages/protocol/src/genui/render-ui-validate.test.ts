import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RENDER_UI_TYPES } from "./render-ui-schema.js";
import { validateRenderUiInput } from "./render-ui-validate.js";

const designRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../design/genui");
const fixturesDir = join(designRoot, "tests/fixtures");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

function readMarkdownJsonExamples(relativePath: string): unknown[] {
  const text = readFileSync(join(designRoot, relativePath), "utf8");
  return [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map((match): unknown => JSON.parse(match[1]))
    .filter(
      (example): example is { type: unknown; data: unknown } =>
        typeof example === "object" && example !== null && "type" in example && "data" in example,
    );
}

const referenceA = {
  type: "metricComparison",
  title: "30 天理论最高额度",
  data: {
    items: [
      { id: "old", label: "旧套餐", value: 7500, unit: "HC" },
      { id: "new", label: "新套餐", value: 1071, unit: "HC" },
    ],
    compare: { from: "old", to: "new", metric: "changePercent", precision: 1, changeIntent: "bad" },
  },
  fallbackText: "旧 7,500 HC，新 1,071 HC。",
};

describe("validateRenderUiInput with design fixtures", () => {
  const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));

  it("covers every v1 component type", () => {
    const types = new Set(
      fixtureNames.map((name) => {
        const result = validateRenderUiInput(readFixture(name));
        return result.ok ? result.input.type : null;
      }),
    );
    expect([...types].sort()).toEqual([...RENDER_UI_TYPES].sort());
  });

  it.each(fixtureNames)("accepts fixture %s", (name) => {
    const result = validateRenderUiInput(readFixture(name));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each([
    "skills/paseo-genui/references/components.md",
    "skills/paseo-genui/references/golden-examples.md",
    "docs/genui-generation-guidelines.md",
    "docs/genui-rfc-v0.4.md",
  ])("accepts every JSON example in %s", (relativePath) => {
    const examples = readMarkdownJsonExamples(relativePath);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const result = validateRenderUiInput(example);
      expect(result.ok ? [] : result.issues).toEqual([]);
    }
  });
});

describe("validateRenderUiInput derived values", () => {
  it("returns changePercent for reference A", () => {
    const result = validateRenderUiInput(referenceA);
    expect(result).toMatchObject({ ok: true, derived: { changePercent: -85.7 } });
  });

  it("returns zero_baseline when the baseline is zero", () => {
    const input = structuredClone(referenceA);
    input.data.items[0].value = 0;
    expect(validateRenderUiInput(input)).toMatchObject({
      ok: true,
      derived: { unavailableReason: "zero_baseline" },
    });
  });

  it("returns progress percent and pie shares", () => {
    expect(
      validateRenderUiInput({
        type: "progress",
        data: { label: "已完成", current: 46, total: 50 },
      }),
    ).toMatchObject({ ok: true, derived: { percent: 92 } });
    expect(
      validateRenderUiInput({
        type: "chart.pie",
        data: {
          labelField: "name",
          valueField: "count",
          rows: [
            { name: "a", count: 1 },
            { name: "b", count: 3 },
          ],
        },
      }),
    ).toMatchObject({
      ok: true,
      derived: {
        total: 4,
        shares: [
          { label: "a", percent: 25 },
          { label: "b", percent: 75 },
        ],
      },
    });
  });

  it("returns per-child derived values for containers", () => {
    const result = validateRenderUiInput({
      type: "card",
      data: {
        children: [
          { type: "metric", data: { label: "成功", value: 46 } },
          { type: "progress", data: { label: "进度", current: 1, total: 4 } },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, derived: { children: [{}, { percent: 25 }] } });
  });
});

describe("validateRenderUiInput rejections", () => {
  function issuesOf(input: unknown) {
    const result = validateRenderUiInput(input);
    if (result.ok) {
      throw new Error("expected validation to fail");
    }
    return result;
  }

  it("rejects unknown types without guessing one", () => {
    expect(issuesOf({ type: "chart.radar", data: {} }).type).toBeNull();
  });

  it("rejects unknown fields such as styling", () => {
    const result = issuesOf({
      type: "metric",
      data: { label: "x", value: 1, color: "#f00" },
    });
    expect(result.type).toBe("metric");
    expect(result.issues[0].path).toEqual(["data"]);
  });

  it("rejects compare ids that do not match an item", () => {
    const input = structuredClone(referenceA);
    input.data.compare.to = "newer";
    expect(issuesOf(input).issues).toEqual([
      { path: ["data", "compare", "to"], message: '"newer" is not one of the item ids (old, new)' },
    ]);
  });

  it("rejects comparisons across different units", () => {
    const input = structuredClone(referenceA);
    input.data.items[1].unit = "Token";
    expect(issuesOf(input).issues[0].message).toContain("same unit");
  });

  it("rejects chart rows missing a series field and non-numeric series values", () => {
    const result = issuesOf({
      type: "chart.bar",
      data: {
        x: "model",
        series: [{ field: "old", label: "旧" }],
        rows: [{ model: "A" }, { model: "B", old: "7.8" }],
      },
    });
    expect(result.issues.map((issue) => issue.path)).toEqual([
      ["data", "rows", 0, "old"],
      ["data", "rows", 1, "old"],
    ]);
  });

  it("accepts null as a missing chart value", () => {
    const result = validateRenderUiInput({
      type: "chart.line",
      data: {
        x: "run",
        series: [{ field: "latency", label: "耗时" }],
        rows: [
          { run: "1", latency: 2.4 },
          { run: "2", latency: null },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects negative pie values and percent pies far from 100", () => {
    const negative = issuesOf({
      type: "chart.pie",
      data: {
        labelField: "n",
        valueField: "v",
        rows: [
          { n: "a", v: -1 },
          { n: "b", v: 2 },
        ],
      },
    });
    expect(negative.issues[0].path).toEqual(["data", "rows", 0, "v"]);

    const percent = issuesOf({
      type: "chart.pie",
      data: {
        labelField: "n",
        valueField: "v",
        unit: "%",
        rows: [
          { n: "a", v: 40 },
          { n: "b", v: 40 },
        ],
      },
    });
    expect(percent.issues[0].message).toContain("sum to 80");
  });

  it("tolerates whole-number rounding in percent pies", () => {
    const result = validateRenderUiInput({
      type: "chart.pie",
      data: {
        labelField: "n",
        valueField: "v",
        unit: "%",
        rows: [
          { n: "a", v: 33 },
          { n: "b", v: 33 },
          { n: "c", v: 33 },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects table rows that miss a column", () => {
    const result = issuesOf({
      type: "table",
      data: {
        columns: [
          { field: "name", label: "方案" },
          { field: "cost", label: "价格" },
        ],
        rows: [{ name: "A" }],
      },
    });
    expect(result.issues[0].path).toEqual(["data", "rows", 0, "cost"]);
  });

  it("reports semantic issues inside containers with the full path", () => {
    const result = issuesOf({
      type: "grid",
      data: {
        children: [
          { type: "metric", data: { label: "a", value: 1 } },
          {
            type: "card",
            data: {
              children: [
                {
                  type: "table",
                  data: {
                    columns: [
                      { field: "a", label: "A" },
                      { field: "a", label: "A2" },
                    ],
                    rows: [{ a: 1 }],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(result.issues[0].path).toEqual([
      "data",
      "children",
      1,
      "data",
      "children",
      0,
      "data",
      "columns",
    ]);
  });

  it("rejects nesting deeper than two levels", () => {
    const result = issuesOf({
      type: "card",
      data: {
        children: [
          {
            type: "grid",
            data: { children: [{ type: "metric", data: { label: "a", value: 1 } }] },
          },
        ],
      },
    });
    expect(result.type).toBe("card");
  });

  it("rejects fallbackText on nested children", () => {
    issuesOf({
      type: "card",
      data: {
        children: [{ type: "metric", data: { label: "a", value: 1 }, fallbackText: "x" }],
      },
    });
  });
});
