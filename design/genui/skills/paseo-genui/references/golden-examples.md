# A / B / C 黄金参考 — 完整工具输入

> 这三个示例与视觉参考图 A/B/C 对应。根据需求组织“简短引入 → `render_ui` 工具调用 → 有信息增量的解释”。完整数据同时收录在包内 `tests/fixtures/`；本文件在独立安装 Skill 时仍可读取。

## A · 额度对比

**前置文字**：按相同口径折算，新套餐的理论额度显著低于旧套餐。

**调用 `render_ui`（完整 JSON）**：

```json
{
  "type": "metricComparison",
  "title": "按 30 天折算的理论最高额度",
  "data": {
    "items": [
      {
        "id": "old",
        "label": "旧套餐",
        "value": 7500,
        "unit": "HC",
        "detail": "名义推理价值 $375"
      },
      {
        "id": "new",
        "label": "新套餐",
        "value": 1071,
        "unit": "HC",
        "detail": "名义推理价值约 $53.57"
      }
    ],
    "compare": {
      "from": "old",
      "to": "new",
      "metric": "changePercent",
      "precision": 1,
      "changeIntent": "bad"
    }
  },
  "fallbackText": "旧套餐 7,500 HC，新套餐约 1,071 HC；按相同口径，理论额度减少约 85.7%。"
}
```

**后续说明**：这是理论最高额度比较，并不等于实际使用情况。

**`changeIntent`**：额度减少对用户不利，填 `"bad"`，降幅显示为红色，与参考图一致。如果比较的是成本下降，应填 `"good"`。

**避免**：不另外生成完全重复的进度卡或表格。

## B · 分组柱状图

**前置文字**：下图把两种模型在新旧套餐下的理论容量按相同单位并列展示。

**调用 `render_ui`（完整 JSON）**：

```json
{
  "type": "chart.bar",
  "title": "30 天等效理论容量",
  "data": {
    "description": "单位：十亿 Token；假设充分利用所有刷新额度",
    "x": "model",
    "series": [
      {
        "field": "old",
        "label": "旧套餐"
      },
      {
        "field": "new",
        "label": "新套餐"
      }
    ],
    "rows": [
      {
        "model": "DS V4.1 Flash",
        "old": 7.8,
        "new": 1.1
      },
      {
        "model": "GLM-5.3 Flash",
        "old": 9.5,
        "new": 1.4
      }
    ],
    "yUnit": "十亿 Token"
  },
  "fallbackText": "DS 新旧容量分别为 1.1 与 7.8 十亿 Token；GLM 新旧容量分别为 1.4 与 9.5 十亿 Token。"
}
```

**后续说明**：两种模型的新套餐容量均明显下降；GLM 的绝对降幅更大。

**避免**：优先显示图例和单位，不要再逐项重念两列数字。

## C · 分级改稿建议

**前置文字**：修改应先解决阶段衔接的问题，再处理语言与演出细节；其余已起到作用的部分保留。

**调用 `render_ui`（完整 JSON）**：

```json
{
  "type": "priorityList",
  "data": {
    "items": [
      {
        "decision": "change",
        "priority": "high",
        "title": "优先修改",
        "body": "凯因醒来后的绝望表达、局长过早提出「光明终将到来」、最后引出回忆的对话。这三处决定了四个阶段的逻辑是否连贯。"
      },
      {
        "decision": "adjust",
        "priority": "medium",
        "title": "其次调整",
        "body": "公墓的环境细节、双意识切换、治疗邀请与实际接受治疗之间的衔接，以及几处不够自然的语言。"
      },
      {
        "decision": "keep",
        "title": "建议保留",
        "body": "凯因醒来后对局长的讥讽、她察觉两个意识的不同、铃铛随情绪颤抖的演出，以及她对辛德菲尔斯其他人的担忧。"
      }
    ]
  },
  "fallbackText": "优先修改阶段连贯性相关表达；其次调整场景、意识转换与治疗衔接；保留人物讥讽、铃铛演出与对他人的担忧。"
}
```

**后续说明**：如果需要实际改稿，再用正常文字给出最小修改方案。

**避免**：`decision` 和 `priority` 是两个独立字段；禁止写旧 `level`。

## 工具确认与派生数值

工具返回 `{"ok":true,"accepted":true,"type":"metricComparison","derived":{"changePercent":-85.7}}` 表示输入被服务端接受，且派生百分比是共享计算函数的结果。此时可以说“减少 85.7%”；**不能**因此宣称某个离线客户端已经绘制了卡片。若 `derived` 缺失或 `unavailableReason` 表示基线为零，应避免报告百分比。

工具失败时按字段错误修改 1–2 次，最终可以用普通 Markdown 完成回答。
