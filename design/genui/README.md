# Paseo GenUI — 设计包 v0.4

**日期**：2026-10-20
**状态**：设计文档、Skill 与测试样例；尚未实现，不能当作可用功能。

本包把 RFC v0.3.1 与上一版修订包（RFC v0.2.1、生成规范 v0.2、视觉规范 v0.1.1、Skill v0.2）合并为同一套协议。所有文件之间的一致性由 `tests/verify.py` 交叉校验。

## 文件与版本

| 文件                                  | 版本          | 用途                                                                        |
| ------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `docs/genui-rfc-v0.4.md`              | RFC v0.4      | 主设计：架构、协议、流式、范围与里程碑、验收                                |
| `docs/genui-visual-spec.md`           | 视觉规范 v0.2 | 尺寸、字号、圆角、间距、配色的唯一数值来源（ChatGPT 网页版实测，亮/暗两套） |
| `docs/genui-visual-acceptance.md`     | 视觉验收 v0.2 | 达标标准、红线、截图矩阵、评分、逐项验收清单                                |
| `docs/genui-generation-guidelines.md` | 生成规范 v0.3 | Skill 的完整依据与评测说明，给开发者看，不注入模型                          |
| `skills/paseo-genui/SKILL.md`         | Skill v0.3    | 模型运行时加载的简短规则与最简格式表                                        |
| `skills/paseo-genui/references/`      | v0.3          | 十个组件的完整格式；A/B/C 完整回答示例                                      |
| `schemas/render-ui.v1.schema.json`    | 设计草案      | 机器可读的参数结构，实现时转为服务端 Zod                                    |
| `tests/fixtures/`                     | —             | 十个组件各一份固定输入，用于静态预览页和截图                                |
| `tests/generation-cases.json`         | v0.4          | 20 个跨模型行为用例（期望，不是实测结果）                                   |
| `tests/verify.py`                     | —             | 静态校验：Schema、语义、跨文件一致性                                        |
| `docs/assets/genui/`                  | —             | 参考图 A、B、C                                                              |

## 给开发 Agent 的阅读顺序

1. `docs/genui-rfc-v0.4.md`
2. `docs/genui-visual-spec.md`，再看 `docs/genui-visual-acceptance.md`
3. `skills/paseo-genui/`（整个目录）
4. `schemas/render-ui.v1.schema.json` 与 `tests/fixtures/`
5. 需要时再看 `docs/genui-generation-guidelines.md` 与 `tests/generation-cases.json`

## v0.4 已定的决定

- v1 十个组件，含 `chart.pie`。
- `priorityList` 用 `decision`（change / adjust / keep）加可选的 `priority`（high / medium / low）。
- `metricComparison.compare.changeIntent`（good / bad / neutral）决定变化值颜色，不按数值正负。
- 工具成功返回 `{ok, accepted, type, derived}`；`accepted` 只表示参数被接受。
- 视觉数值全部以实测规范为准，实现为独立的 GenUI 设计变量，不混用 Paseo 主题颜色。

## 本地静态校验

```bash
python tests/verify.py
```

需要 `jsonschema>=4.18`。脚本检查：

- 十份样例通过 Schema 与语义检查（重复 ID、单位、空值、饼图合计等）。
- Skill 参考、生成规范和 RFC 里的完整 JSON 示例都通过 Schema。
- RFC §5.1 的最简格式表与 `SKILL.md` 逐字一致，且恰好列出十个组件。
- 参考 A 声明 `changeIntent: "bad"`；T03、T14 的断言与 `changeIntent` 规则一致。
- 文档中没有指向旧版 RFC v0.2.1 或旧视觉文档的引用。

它**不调用模型**，不能代替跨模型通过率统计和视觉截图验收。

## 安装 Skill（`render_ui` 实现之后）

把 `skills/paseo-genui/` 整个目录（含 `references/`）放进仓库的 `skills/`，由现有的内置 Skill 同步分发；同步会递归复制子目录。只复制 `SKILL.md` 会让模型拿不到完整格式。
