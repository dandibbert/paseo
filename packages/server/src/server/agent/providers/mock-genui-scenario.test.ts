import { describe, expect, it } from "vitest";
import { RENDER_UI_TYPES } from "@getpaseo/protocol/genui/render-ui-schema";
import { validateRenderUiInput } from "@getpaseo/protocol/genui/render-ui-validate";
import { buildMockGenuiScenario, parseMockGenuiPrompt } from "./mock-genui-scenario.js";

describe("mock GenUI scenario", () => {
  it("parses the all-cards and single-card prompts", () => {
    expect(parseMockGenuiPrompt("Please emit synthetic genui cards")).toEqual([...RENDER_UI_TYPES]);
    expect(parseMockGenuiPrompt("emit synthetic genui card chart.pie")).toEqual(["chart.pie"]);
    expect(parseMockGenuiPrompt("emit synthetic genui card chart.radar")).toBeNull();
    expect(parseMockGenuiPrompt("hello")).toBeNull();
  });

  it("plays every component with valid data, interleaved with text", () => {
    const { steps } = buildMockGenuiScenario("turn-1", RENDER_UI_TYPES);
    const completed = steps.filter((step) => step.kind === "render_ui_completed");
    expect(completed.map((step) => validateRenderUiInput(step.input).ok)).toEqual(
      RENDER_UI_TYPES.map(() => true),
    );
    const kinds = steps.map((step) => step.kind);
    expect(kinds.slice(0, 3)).toEqual(["text", "render_ui_running", "render_ui_failed"]);
    expect(kinds.slice(3, 6)).toEqual(["render_ui_running", "render_ui_completed", "text"]);
  });
});
