# `render_ui` v1 组件格式与字段约束（按需读取）

> 本参考随 Skill 一起安装；不依赖工作区另存的 `docs/`。完整机器可读结构见项目包内 `schemas/render-ui.v1.schema.json`，并须由服务端实现同等 Zod 校验。示例不是已上线接口：后端与 Skill 应用本包同一版本。调用参数不允许 CSS、JS、HTML 或布局像素值。

通用结构：`{ "type": "...", "title": "可选标题", "data": {...}, "fallbackText": "可独立阅读的描述" }`。`schemaVersion` 可选，省略为 1。`fallbackText` 是回退文案，不是重复展示的正文。

## `metricComparison`

**比较两个同口径数值**，`items` 恰好 2 项，`id` 唯一；`compare.from/to` 是对应 ID；`metric` 目前固定 `changePercent`；`precision` 推荐 1；`changeIntent` 可选，取 `good` / `bad` / `neutral`，表示这个变化对用户是好事、坏事还是中性，App 据此给变化值上色（bad 红、good 绿、neutral 或省略为灰）。按上下文判断，不按数值正负：额度减少是 `bad`，成本下降是 `good`；判断不了就省略。原值为零则不能计算百分比。`data.items[].detail` 为可选辅助说明。

```json
{
  "type": "metricComparison",
  "title": "30 天理论最高额度",
  "data": {
    "items": [
      { "id": "old", "label": "旧套餐", "value": 7500, "unit": "HC" },
      { "id": "new", "label": "新套餐", "value": 1071, "unit": "HC" }
    ],
    "compare": {
      "from": "old",
      "to": "new",
      "metric": "changePercent",
      "precision": 1,
      "changeIntent": "bad"
    }
  },
  "fallbackText": "旧 7,500 HC，新 1,071 HC，按同口径额度减少约 85.7%。"
}
```

## `metric`

**强调一个重要数值**。`data={label,value,unit?,detail?}`。普通聊天里顺便出现的数字不必做卡片。

```json
{
  "type": "metric",
  "data": { "label": "任务完成率", "value": 92.4, "unit": "%", "detail": "过去七天；示例" },
  "fallbackText": "过去七天任务完成率为 92.4%。"
}
```

## `progress`

**已有分子/分母的进度**。`data={label,current,total,unit?,detail?}`；`current>=0`、`total>0`；比例由共享计算函数产生。超过目标时可明确展示超额值，不要把 120% 偷改成 100%；可视轨道单独裁剪。

```json
{
  "type": "progress",
  "data": { "label": "已完成任务", "current": 46, "total": 50, "unit": "项" },
  "fallbackText": "50 项任务已完成 46 项，完成率 92%。"
}
```

## `chart.bar` 和 `chart.line`

**同一数值单位、多类别或有序序列**。`data={description?, x, series:[{field,label}], rows:[{...}], yUnit?}`。

- `x` 指定真实行字段名；`series.field` 指定同一行的数值字段名，必须存在且为数字或 `null`（`null` 是缺失，非 0）。
- `bar` 比较**离散类别**；`line` 表示已按时间或步骤排序的数据点。不能把两个异量纲的数列放在共用纵轴。
- 图表标签、配色、坐标轴与 tooltip 均由客户端生成，模型只给数据与口径。

```json
{
  "type": "chart.bar",
  "title": "模型容量对比",
  "data": {
    "x": "model",
    "series": [
      { "field": "old", "label": "旧套餐" },
      { "field": "new", "label": "新套餐" }
    ],
    "rows": [
      { "model": "DS V4.1 Flash", "old": 7.8, "new": 1.1 },
      { "model": "GLM-5.3 Flash", "old": 9.5, "new": 1.4 }
    ],
    "yUnit": "十亿 Token"
  },
  "fallbackText": "DS 容量由 7.8 降到 1.1，GLM 由 9.5 降到 1.4，单位均为十亿 Token。"
}
```

同结构改用 `"type":"chart.line"` 并将 `x` 改成有序时间/步骤字段，即是折线图。以下给出可直接调用的完整示例：

```json
{
  "type": "chart.line",
  "title": "七次响应测试",
  "data": {
    "description": "按测试先后顺序；单位秒",
    "x": "run",
    "series": [
      {
        "field": "latency",
        "label": "响应耗时"
      }
    ],
    "rows": [
      {
        "run": "1",
        "latency": 2.4
      },
      {
        "run": "2",
        "latency": 2.1
      },
      {
        "run": "3",
        "latency": 2.6
      },
      {
        "run": "4",
        "latency": 1.9
      },
      {
        "run": "5",
        "latency": 1.8
      },
      {
        "run": "6",
        "latency": 1.6
      },
      {
        "run": "7",
        "latency": 1.4
      }
    ],
    "yUnit": "秒"
  },
  "fallbackText": "七次测试耗时依次为 2.4、2.1、2.6、1.9、1.8、1.6、1.4 秒，整体下降。"
}
```

## `chart.pie`（修订版 v1 新增）

**占比构成**，`data={description?,labelField,valueField,rows,unit?}`。`rows` 每行必须有非空名称和非负数字；至少 2 项，合计必须大于零。传入原始数量或真实百分数；由客户端根据合计生成扇区比例和百分比。若 `unit:"%"`，原始数合计应约等于 100（允许小幅舍入差异）。不得虚构“其他”来补足数据，也不得将负数切成扇区。

```json
{
  "type": "chart.pie",
  "title": "任务时间分布",
  "data": {
    "labelField": "stage",
    "valueField": "percent",
    "rows": [
      { "stage": "开发", "percent": 46 },
      { "stage": "测试", "percent": 27 },
      { "stage": "设计", "percent": 17 },
      { "stage": "其他", "percent": 10 }
    ],
    "unit": "%"
  },
  "fallbackText": "开发46%、测试27%、设计17%、其他10%。"
}
```

## `table`

**多个实体与多项精确属性**。`data={columns:[{field,label}],rows:[{...}],description?}`。行键与 `columns.field` 必须匹配。数值用数字类型而非字符串；空值用 `null`，不可将未知当成零。最多 50 行。

```json
{
  "type": "table",
  "data": {
    "columns": [
      { "field": "name", "label": "方案" },
      { "field": "cost", "label": "价格（元）" },
      { "field": "limit", "label": "限制" }
    ],
    "rows": [
      { "name": "A", "cost": 50, "limit": "仅网页" },
      { "name": "B", "cost": 35, "limit": "仅手机" }
    ]
  },
  "fallbackText": "方案 A 50 元，仅网页；方案 B 35 元，仅手机。"
}
```

## `priorityList`（修订后字段）

**行动分层**。`data.items[]` 中：`decision` 只能为 `change`（修改）、`adjust`（调整）、`keep`（保留），用于动作语义及图标；独立的 `priority?: high | medium | low` 表示紧急程度。**不要**写旧字段 `level`，也不要把 `keep` 当作一个优先级。条目原顺序由模型按照重要性安排，客户端不应自行强制排序。

```json
{
  "type": "priorityList",
  "data": {
    "items": [
      {
        "decision": "change",
        "priority": "high",
        "title": "优先修改",
        "body": "修复四阶段叙事衔接。"
      },
      {
        "decision": "adjust",
        "priority": "medium",
        "title": "其次调整",
        "body": "调整公墓场景的环境描述。"
      },
      { "decision": "keep", "title": "建议保留", "body": "保留人物声音与情绪动作。" }
    ]
  },
  "fallbackText": "优先修改阶段衔接，其次调整环境描写，并保留已有效的角色表现。"
}
```

## `card` 与 `grid`（组合容器）

`data.children` 为嵌入式 `{type,title?,data}` 数组，**子组件不需要** `fallbackText`（回退文字由最外层给出）。容器最多嵌套两层：顶层 `card` 可包含叶组件；顶层 `grid` 可包含同级叶组件或一层 `card`。不要在 card 里放 grid、在 grid 里放 grid，也不要复制同一信息多次。

- `card`：语义相关的少量子组件，推荐 1–4 项。
- `grid`：2–4 个**同类、同级**的并列实体；列数由 App 根据宽度决定，模型不能指定 CSS 列宽。

```json
{
  "type": "grid",
  "title": "项目完成率",
  "data": {
    "children": [
      { "type": "metric", "data": { "label": "项目 A", "value": 80, "unit": "%" } },
      { "type": "metric", "data": { "label": "项目 B", "value": 60, "unit": "%" } }
    ]
  },
  "fallbackText": "项目 A 完成率 80%，项目 B 完成率 60%。"
}
```

`card` 同样是一个可独立调用的容器；完整示例如下：

```json
{
  "type": "card",
  "title": "本周项目概览",
  "data": {
    "children": [
      {
        "type": "metric",
        "data": {
          "label": "成功任务",
          "value": 46,
          "unit": "项"
        }
      },
      {
        "type": "progress",
        "data": {
          "label": "任务完成进度",
          "current": 46,
          "total": 50,
          "unit": "项"
        }
      }
    ]
  },
  "fallbackText": "本周完成 46 项任务，目标 50 项，完成率 92%。"
}
```

## 通用限制及错误处理

- 不接受文字以外的远程资源、脚本或链接式动作；数值必须有限（不能 `NaN` / `Infinity`）。
- 参数初始最大 16 KiB，嵌套最多两层；bar/line 至多 200 个数据点，pie 最多 24 类，table 最多 50 行。代码库仍需服务端严格检查动态字段引用与单位一致性；仅验证 JSON Schema 不足以保证这些语义条件。
- `render_ui` **工具返回校验成功只意味着接受数据**，不是客户端已完成绘制；可用 `derived.changePercent` 等共享计算值引用数值事实。
- 若没读到组件格式或工具不支持该类型，正常 Markdown 回答，不试探性提交凭空猜测的 JSON。
