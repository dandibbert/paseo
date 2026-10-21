---
name: paseo-genui
description: 回答里出现数值对比、时间趋势、分类数值、占比构成、多实体多属性（原本要写 Markdown 表格）、完成进度或分级修改建议时使用：用 render_ui 在 Paseo 聊天里画原生卡片，代替 Markdown 表格和数字列表。
---

# Paseo GenUI — 生成与编排

你是**信息编辑者**，不是 HTML/CSS 设计师。先准确回答问题，再决定是否使用 UI。

## 何时调用

写回答之前先检查：答案里有没有下表中的数据形态。**命中就调用 `render_ui`，不要改写成 Markdown 表格、数字列表或 HTML 文件。** 这一步在决定回答形式时做，不要等用户追问。

| 答案里出现                                    | 用                 |
| --------------------------------------------- | ------------------ |
| 两个同口径数值的变化（新旧、前后、方案 A/B）  | `metricComparison` |
| 一个需要突出的关键数值                        | `metric`           |
| 已完成 / 总量                                 | `progress`         |
| 几个类别各自的数值                            | `chart.bar`        |
| 按时间或步骤排列的一组数值                    | `chart.line`       |
| 各部分占整体的比例                            | `chart.pie`        |
| 多个对象 × 多个属性（本来会写 Markdown 表格） | `table`            |
| 分成修改 / 调整 / 保留的建议                  | `priorityList`     |
| 以上几种需要并排或成组展示                    | `card` / `grid`    |

不调用的情况：问候、概念解释、代码修复与代码片段、叙事、答案里没有数值或结构化数据、用户要求纯文本或不要图。不得虚构值、补零、凭空补日期；不能把单位不同的数值画在同一根纵轴上。

数量：通常一次回答 1–2 个各有用途的组件。结构是“一句结论 → 组件 → 口径 / 解释 / 下一步”。正文不要重复卡片里的每个数字，也不要为每段话单独加框。

## `render_ui` 最小契约

工具参数为 `{type, title?, data, fallbackText?, schemaVersion?}`，其中 `schemaVersion` 省略时按 `1` 处理；**`data` 的准确完整格式见相邻 `references/components.md`**。调用工具，不要只输出 JSON 代码围栏。

| type               | `data` 的最小结构（省略可选字段）                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `metricComparison` | `{items:[{id,label,value,unit?},…],compare:{from,to,metric:"changePercent",precision?,changeIntent?:"good"\|"bad"\|"neutral"}}` |
| `metric`           | `{label,value,unit?,detail?}`                                                                                                   |
| `progress`         | `{label,current,total,unit?}`，`total>0`                                                                                        |
| `chart.bar`        | `{x,series:[{field,label}],rows:[{[x]:类别,[field]:数值}],yUnit?}`                                                              |
| `chart.line`       | 与 `chart.bar` 相同；`rows` 必须已经按时间/步骤排序                                                                             |
| `chart.pie`        | `{labelField,valueField,rows:[{[labelField]:名称,[valueField]:非负数}],unit?}`                                                  |
| `table`            | `{columns:[{field,label}],rows:[{[field]:值}]}`                                                                                 |
| `priorityList`     | `{items:[{decision:"change"\|"adjust"\|"keep",priority?:"high"\|"medium"\|"low",title,body}]}`                                  |
| `card`             | `{children:[{type,title?,data},…]}`，语义相关的少量子组件                                                                       |
| `grid`             | `{children:[{type,title?,data},…]}`，同类并列实体，自动响应式                                                                   |

> 动态字段标记（如 `[x]`）是**说明用记法，不是实际 JSON 键名**。复制 `references/components.md` 中对应真实样例再填写。`chart.pie` 已纳入修订版 v1；其他交互类组件（slider、map、carousel、form 等）仍不支持。

## 输出质量

- 只给有来源的**原始数值**；用户没有提供的数字，不因图表需要而补造。图表标清单位、口径、时间范围。`null`/未知和数值 `0` 不能混同。
- 百分比、降幅由 Paseo 的共享计算规则得出。**工具返回 `ok:true` 且 `derived` 包含该字段时，正文可引用它**；否则只描述方向，或自行计算并说明来源及精度，不声称已得到 UI 确认。
- `compare.changeIntent` 表示这个变化**对用户**是好事、坏事还是中性，App 据此给变化值上色（bad 红、good 绿、neutral 或省略为灰）。按上下文判断，不按数值正负：额度、收入减少通常是 `bad`；成本、报错、延迟减少通常是 `good`；判断不了就省略。
- `priorityList.decision` 表示**修改 / 调整 / 保留**；`priority` 独立表示紧急程度，绝不使用旧的 `level:high/medium/keep`。
- 不输出颜色、CSS、像素、脚本；样式、图例、响应式由 Paseo 负责。内容自然，长中文建议不得削成不通顺的短语。
- 每次推荐附可独立阅读的 `fallbackText`（通常 1–3 句；含关键实体、单位和事实；不是“请查看上图”）。

## 工具可靠性

- **工具接受 ≠ 客户端一定已显示**。调用流式阶段仅是草稿预览；以完成并通过校验的数据为准。
- 字段不确定时按需读取 `references/components.md` 对应节；三个原图复现用 `references/golden-examples.md`。不要将整个设计文档自动加载到上下文。
- 校验失败按字段错误局部修正，最多额外重试 2 次；仍失败就用 Markdown 完整回答。工具关闭/不可用也正常回答，不擅自生成 HTML 文件。
- `render_ui` 只负责**展示**，不执行写文件、付款、发送消息等副作用。
