# 2026-10-20 — 设计包 v0.4

合并 RFC v0.3.1 与上一版修订包，统一为同一套协议。

| 文件                                           | 版本     | 改动                                                                                                                                                                                                                               |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/genui-rfc-v0.4.md`                       | v0.4     | 取代 `genui-rfc-v0.2.1.md` 与 RFC v0.3.1：十组件含饼图、`decision`/`priority`、`changeIntent`、`{ok, accepted, type, derived}` 返回值、`compute.ts`、可选 `schemaVersion`；§5.1 原样引用 Skill 的最简格式表；§5.2 示例取自测试样例 |
| `docs/genui-visual-spec.md`                    | v0.2     | 新增到包内，作为唯一视觉数值来源；补充 `changeIntent` 上色、变化条、饼图、priorityList 图标与 `priority` 规则、窄屏图表高度                                                                                                        |
| `docs/genui-visual-acceptance.md`              | v0.2     | 由 `genui-visual-quality.md` 的验收部分整理而来；对标方式改为以实测规范为准；A 增加 `changeIntent` 验收项；v1 条件增加与参考图并排对比                                                                                             |
| `docs/genui-visual-quality.md`                 | —        | 删除：token 映射和尺寸建议已被实测规范取代，验收部分已移出                                                                                                                                                                         |
| `docs/genui-generation-guidelines.md`          | v0.3     | 引用改为 RFC v0.4；§5.2 改为使用 `changeIntent`；示例 A 填 `bad`；删除 `get_ui_schema` 与薄/厚 Schema 对比计划                                                                                                                     |
| `skills/paseo-genui/SKILL.md` 及 `references/` | v0.3     | 加入 `changeIntent` 的格式和判断规则；示例 A 填 `bad`                                                                                                                                                                              |
| `schemas/render-ui.v1.schema.json`             | 设计草案 | `compare.changeIntent` 枚举，含 `card`/`grid` 内嵌的三份副本                                                                                                                                                                       |
| `tests/fixtures/reference-a.json`              | —        | `changeIntent: "bad"`                                                                                                                                                                                                              |
| `tests/generation-cases.json`                  | v0.4     | T03 要求 `bad`；T14 要求 `good` 或省略、不得填 `bad`                                                                                                                                                                               |
| `tests/verify.py`                              | —        | 改用 RFC v0.4；新增跨文件一致性检查                                                                                                                                                                                                |

---

# 2026-10-20 — 设计包修订记录

| 文件                                               | 版本     | 对应反馈                                                                   |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `docs/genui-rfc-v0.2.1.md`                         | v0.2.1   | 补充结构化派生值、十组件、分离 `priorityList` 决定/优先级、独立工具显示 M0 |
| `docs/genui-generation-guidelines.md`              | v0.2     | 修订 T06/T20、pie 选用逻辑、派生值使用规则与 Skill 分发引用                |
| `docs/genui-visual-quality.md`                     | v0.1.1   | 更新 C 图图标语义、支持饼图及测试夹具、调整十组件验收范围                  |
| `skills/paseo-genui/SKILL.md`                      | v0.2     | 约 4KB 主文件；包含十种组件最小格式；不再依赖开发文档                      |
| `skills/paseo-genui/references/components.md`      | v0.2     | 全部十种组件完整 JSON 输入示例、字段约束与错误注意事项                     |
| `skills/paseo-genui/references/golden-examples.md` | v0.2     | A/B/C 黄金样例 + 正文前后编排与工具 `derived` 用法                         |
| `schemas/render-ui.v1.schema.json`                 | 设计草案 | 标准 JSON Schema，与各例子同步；服务端仍需 Zod 等价实现及语义检查          |
| `tests/generation-cases.json`                      | v0.2     | T06 不再索取已给数据、T12 改为 pie、T20 不再假设附件缺失；ID 1–20 保留     |
| `tests/fixtures/*.json`                            | 固定夹具 | 十种组件各一份；A/B/C 与 pie 单独命名                                      |
| `tests/verify.py`                                  | 静态验证 | JSON Schema、动态引用和跨文件 JSON 示例检查；不冒充真实模型/跨端测试       |

**兼容说明**：`priorityList.level` 是拟定协议里尚未实现的旧字段，修改为 `decision`/`priority` 不构成现有用户数据迁移。若已有外部分支提前实现了旧接口，需要迁移代码与既有消息，而不能直接假设没有兼容风险。
