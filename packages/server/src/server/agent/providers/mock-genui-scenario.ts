import { RENDER_UI_TYPES, type RenderUiType } from "@getpaseo/protocol/genui/render-ui-schema";
import { RENDER_UI_FORMATS } from "../tools/render-ui/render-ui-formats.js";

// Scripted render_ui turns for the mock provider: e2e tests and visual QA drive GenUI
// cards through the real timeline without a model. "emit synthetic genui cards" plays
// every component with text between them; "emit synthetic genui card chart.bar" plays one.

export const MOCK_GENUI_TOOL_NAME = "mcp__paseo__render_ui";
// Long enough for a screenshot of the generating skeleton.
export const MOCK_GENUI_GENERATING_MS = 600;

export type MockGenuiStep =
  | { kind: "text"; text: string }
  | { kind: "render_ui_running"; callId: string; input: unknown }
  | { kind: "render_ui_completed"; callId: string; input: unknown }
  | { kind: "render_ui_failed"; callId: string; input: unknown; message: string };

export interface MockGenuiScenario {
  steps: MockGenuiStep[];
  finalText: string;
}

const REFERENCE_INPUTS: Partial<Record<RenderUiType, unknown>> = {
  "chart.bar": {
    type: "chart.bar",
    title: "模型容量对比",
    data: {
      description: "30 天等效理论容量；假设充分利用所有刷新额度",
      x: "model",
      series: [
        { field: "old", label: "旧套餐" },
        { field: "new", label: "新套餐" },
      ],
      rows: [
        { model: "DS V4.1 Flash", old: 7.8, new: 1.1 },
        { model: "GLM-5.3 Flash", old: 9.5, new: 1.4 },
      ],
      yUnit: "十亿 Token",
    },
    fallbackText: "DS 由 7.8 降到 1.1，GLM 由 9.5 降到 1.4，单位十亿 Token。",
  },
  priorityList: {
    type: "priorityList",
    data: {
      items: [
        {
          decision: "change",
          priority: "high",
          title: "优先修改",
          body: "凯因醒来后的绝望表达、局长过早提出「光明终将到来」、最后引出回忆的对话。这三处决定了四个阶段的逻辑是否连贯。",
        },
        {
          decision: "adjust",
          priority: "medium",
          title: "其次调整",
          body: "公墓的环境细节、双意识切换、治疗邀请与实际接受治疗之间的衔接，以及几处不够自然的语言。",
        },
        {
          decision: "keep",
          title: "建议保留",
          body: "凯因醒来后对局长的讥讽、她察觉两个意识的不同、铃铛随情绪颤抖的演出。这些都有助于建立人物辨识度。",
        },
      ],
    },
    fallbackText: "优先修改阶段衔接，其次调整环境与衔接细节，保留已有效的人物表现。",
  },
};

function inputFor(type: RenderUiType): unknown {
  return REFERENCE_INPUTS[type] ?? RENDER_UI_FORMATS[type].example;
}

function cardSteps(turnId: string, type: RenderUiType): MockGenuiStep[] {
  const callId = `${turnId}:render-ui:${type}`;
  const input = inputFor(type);
  const record = typeof input === "object" && input !== null ? input : {};
  const title = "title" in record ? record.title : undefined;
  return [
    { kind: "render_ui_running", callId, input: { type, ...(title ? { title } : {}) } },
    { kind: "render_ui_completed", callId, input },
  ];
}

export function parseMockGenuiPrompt(text: string): RenderUiType[] | null {
  if (/emit\s+synthetic\s+genui\s+cards/i.test(text)) {
    return [...RENDER_UI_TYPES];
  }
  const single = /emit\s+synthetic\s+genui\s+card\s+([A-Za-z.]+)/i.exec(text);
  const type = RENDER_UI_TYPES.find((candidate) => candidate === single?.[1]);
  return type ? [type] : null;
}

export function buildMockGenuiScenario(
  turnId: string,
  types: readonly RenderUiType[],
): MockGenuiScenario {
  const steps: MockGenuiStep[] = [{ kind: "text", text: "Here is the summary.\n\n" }];
  if (types.length > 1) {
    steps.push({
      kind: "render_ui_running",
      callId: `${turnId}:render-ui:rejected`,
      input: { type: "metric" },
    });
    steps.push({
      kind: "render_ui_failed",
      callId: `${turnId}:render-ui:rejected`,
      input: { type: "metric", data: { label: "rejected" } },
      message: "render_ui rejected the input.",
    });
  }
  types.forEach((type, index) => {
    steps.push(...cardSteps(turnId, type));
    steps.push({
      kind: "text",
      text:
        index === types.length - 1
          ? "That covers it."
          : `Card ${index + 1} of ${types.length}.\n\n`,
    });
  });
  return { steps, finalText: "Synthetic GenUI turn complete" };
}
