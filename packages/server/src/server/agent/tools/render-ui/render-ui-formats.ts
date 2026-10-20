import type { RenderUiType } from "@getpaseo/protocol/genui/render-ui-schema";

interface RenderUiFormat {
  // Minimal `data` shape. Must match the table in skills/paseo-genui/SKILL.md word for word.
  minimal: string;
  example: unknown;
}

export const RENDER_UI_FORMATS: Record<RenderUiType, RenderUiFormat> = {
  metricComparison: {
    minimal:
      '`{items:[{id,label,value,unit?},…],compare:{from,to,metric:"changePercent",precision?,changeIntent?:"good"|"bad"|"neutral"}}`',
    example: {
      type: "metricComparison",
      title: "30 天理论最高额度",
      data: {
        items: [
          { id: "old", label: "旧套餐", value: 7500, unit: "HC" },
          { id: "new", label: "新套餐", value: 1071, unit: "HC" },
        ],
        compare: {
          from: "old",
          to: "new",
          metric: "changePercent",
          precision: 1,
          changeIntent: "bad",
        },
      },
      fallbackText: "旧 7,500 HC，新 1,071 HC，额度减少约 85.7%。",
    },
  },
  metric: {
    minimal: "`{label,value,unit?,detail?}`",
    example: {
      type: "metric",
      data: { label: "任务完成率", value: 92.4, unit: "%", detail: "过去七天" },
      fallbackText: "过去七天任务完成率为 92.4%。",
    },
  },
  progress: {
    minimal: "`{label,current,total,unit?}`，`total>0`",
    example: {
      type: "progress",
      data: { label: "已完成任务", current: 46, total: 50, unit: "项" },
      fallbackText: "50 项任务已完成 46 项。",
    },
  },
  "chart.bar": {
    minimal: "`{x,series:[{field,label}],rows:[{[x]:类别,[field]:数值}],yUnit?}`",
    example: {
      type: "chart.bar",
      title: "模型容量对比",
      data: {
        x: "model",
        series: [
          { field: "old", label: "旧套餐" },
          { field: "new", label: "新套餐" },
        ],
        rows: [
          { model: "Model A", old: 7.8, new: 1.1 },
          { model: "Model B", old: 9.5, new: 1.4 },
        ],
        yUnit: "十亿 Token",
      },
      fallbackText: "Model A 由 7.8 降到 1.1，Model B 由 9.5 降到 1.4，单位十亿 Token。",
    },
  },
  "chart.line": {
    minimal: "与 `chart.bar` 相同；`rows` 必须已经按时间/步骤排序",
    example: {
      type: "chart.line",
      title: "响应耗时",
      data: {
        x: "run",
        series: [{ field: "latency", label: "耗时" }],
        rows: [
          { run: "1", latency: 2.4 },
          { run: "2", latency: 2.1 },
          { run: "3", latency: null },
          { run: "4", latency: 1.9 },
        ],
        yUnit: "秒",
      },
      fallbackText: "四次测试耗时 2.4、2.1、缺失、1.9 秒。",
    },
  },
  "chart.pie": {
    minimal: "`{labelField,valueField,rows:[{[labelField]:名称,[valueField]:非负数}],unit?}`",
    example: {
      type: "chart.pie",
      title: "任务时间分布",
      data: {
        labelField: "stage",
        valueField: "percent",
        rows: [
          { stage: "开发", percent: 46 },
          { stage: "测试", percent: 27 },
          { stage: "设计", percent: 17 },
          { stage: "其他", percent: 10 },
        ],
        unit: "%",
      },
      fallbackText: "开发 46%、测试 27%、设计 17%、其他 10%。",
    },
  },
  table: {
    minimal: "`{columns:[{field,label}],rows:[{[field]:值}]}`",
    example: {
      type: "table",
      data: {
        columns: [
          { field: "name", label: "方案" },
          { field: "cost", label: "价格（元）" },
        ],
        rows: [
          { name: "A", cost: 50 },
          { name: "B", cost: null },
        ],
      },
      fallbackText: "方案 A 50 元，方案 B 价格未知。",
    },
  },
  priorityList: {
    minimal:
      '`{items:[{decision:"change"|"adjust"|"keep",priority?:"high"|"medium"|"low",title,body}]}`',
    example: {
      type: "priorityList",
      data: {
        items: [
          { decision: "change", priority: "high", title: "优先修改", body: "修复阶段衔接。" },
          { decision: "adjust", title: "其次调整", body: "调整环境描写。" },
          { decision: "keep", title: "建议保留", body: "保留人物声音。" },
        ],
      },
      fallbackText: "优先修改阶段衔接，其次调整环境描写，保留人物声音。",
    },
  },
  card: {
    minimal: "`{children:[{type,title?,data},…]}`，语义相关的少量子组件",
    example: {
      type: "card",
      title: "本周项目概览",
      data: {
        children: [
          { type: "metric", data: { label: "成功任务", value: 46, unit: "项" } },
          { type: "progress", data: { label: "任务完成进度", current: 46, total: 50 } },
        ],
      },
      fallbackText: "本周完成 46 项任务，目标 50 项。",
    },
  },
  grid: {
    minimal: "`{children:[{type,title?,data},…]}`，同类并列实体，自动响应式",
    example: {
      type: "grid",
      title: "项目完成率",
      data: {
        children: [
          { type: "metric", data: { label: "项目 A", value: 80, unit: "%" } },
          { type: "metric", data: { label: "项目 B", value: 60, unit: "%" } },
        ],
      },
      fallbackText: "项目 A 完成率 80%，项目 B 完成率 60%。",
    },
  },
};

function escapeTableCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

export function renderMinimalFormatTable(): string {
  const rows = Object.entries(RENDER_UI_FORMATS).map(
    ([type, format]) => `| \`${type}\` | ${escapeTableCell(format.minimal)} |`,
  );
  return ["| type | `data` 的最小结构（省略可选字段） |", "| --- | --- |", ...rows].join("\n");
}
