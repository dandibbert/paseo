import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateRenderUiInput } from "@getpaseo/protocol/genui/render-ui-validate";
import { RENDER_UI_TYPES } from "@getpaseo/protocol/genui/render-ui-schema";
import { PaseoToolInputError } from "../types.js";
import { RENDER_UI_FORMATS } from "./render-ui-formats.js";
import { acceptRenderUiInput, RENDER_UI_DESCRIPTION } from "./render-ui-tool.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../..");

function readMinimalFormatTable(text: string): string[][] {
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => /^\|\s*type\s*\|/.test(line));
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) {
      break;
    }
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^[-: ]+$/.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

function rejectionMessage(input: unknown): string {
  try {
    acceptRenderUiInput(input);
  } catch (error) {
    if (error instanceof PaseoToolInputError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected render_ui to reject the input");
}

describe("render_ui tool description", () => {
  it("carries the same minimal-format table as the paseo-genui skill", () => {
    const skill = readFileSync(join(repoRoot, "skills/paseo-genui/SKILL.md"), "utf8");
    const skillTable = readMinimalFormatTable(skill);
    expect(skillTable.length).toBe(RENDER_UI_TYPES.length + 1);
    expect(readMinimalFormatTable(RENDER_UI_DESCRIPTION)).toEqual(skillTable);
  });

  it.each(RENDER_UI_TYPES)("has a valid error-message example for %s", (type) => {
    const result = validateRenderUiInput(RENDER_UI_FORMATS[type].example);
    expect(result.ok ? result.input.type : result.issues).toBe(type);
  });
});

describe("acceptRenderUiInput", () => {
  it("returns ok, accepted, type and derived values", () => {
    expect(acceptRenderUiInput(RENDER_UI_FORMATS.metricComparison.example)).toEqual({
      ok: true,
      accepted: true,
      type: "metricComparison",
      derived: { changePercent: -85.7 },
    });
  });

  it("tells the model which field is wrong and shows the correct format", () => {
    const message = rejectionMessage({
      type: "chart.bar",
      data: { x: "model", series: [{ field: "old", label: "旧" }], rows: [{ model: "A" }] },
    });
    expect(message).toContain('- data.rows[0].old: row is missing series field "old"');
    expect(message).toContain(
      `Minimal data for chart.bar: ${RENDER_UI_FORMATS["chart.bar"].minimal}`,
    );
    expect(message).toContain(JSON.stringify(RENDER_UI_FORMATS["chart.bar"].example));
  });

  it("lists the supported types when the type is unknown", () => {
    expect(rejectionMessage({ type: "slider", data: {} })).toContain(
      "type must be one of: metricComparison, metric, progress",
    );
  });

  it("rejects input over 16 KiB before validating it", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      name: `row ${index} ${"x".repeat(400)}`,
      cost: index,
    }));
    const message = rejectionMessage({
      type: "table",
      data: {
        columns: [
          { field: "name", label: "名称" },
          { field: "cost", label: "价格" },
        ],
        rows,
      },
    });
    expect(message).toMatch(/^render_ui input is \d+ bytes; the limit is 16384\./);
  });
});
