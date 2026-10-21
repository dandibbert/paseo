# GenUI cards

Agents call the `render_ui` Paseo tool to put a native card in the chat: a comparison, metric, progress bar, bar/line/pie chart, table, prioritized list, or a `card`/`grid` of those. The design record, measured visual spec and acceptance checklist live in `design/genui/`. The `paseo-genui` skill in `skills/paseo-genui/` tells models when to use it.

## One schema, two validators

The v1 schemas, cross-field checks and derived values live in `packages/protocol/src/genui/`. The daemon validates the tool input with them (`packages/server/src/server/agent/tools/render-ui/`) and the app re-validates before drawing (`packages/app/src/genui/render-ui-call.ts`). Change them in one place; both sides must agree on what a valid card is and on every number a card shows.

- Derived numbers (`changePercent`, progress, pie shares) come only from `compute.ts`. The tool returns them as `derived` so the model quotes the same value the card draws.
- The tool description carries the minimal-format table. `render-ui-tool.test.ts` fails if it drifts from `skills/paseo-genui/SKILL.md`; edit both together.
- Rejections name the failing path and include the correct format and an example, so the model can fix the call in one retry.
- Agents that can call `render_ui` get a short pre-send check appended to their system prompt (`render-ui-prompt.ts`, wired in `AgentManager.applyDaemonAppendSystemPrompt`). The tool description is not enough on its own: Claude Code defers MCP tools behind tool search and Pi exposes them through codemode, so neither sees the description while deciding how to answer. Internal agents and providers with `render_ui` in `disabledTools` do not get it.
- `render_ui` never asks for permission: it only displays content. Claude gets it in `allowedTools` and Codex gets `approval_mode = "approve"` for it whenever the Paseo MCP server is attached (`AUTO_APPROVED_PASEO_TOOLS` in `packages/server/src/server/agent/runtime-mcp-config.ts`). Add a tool there only if it has no side effects.
- Wire compatibility: provider parsers already map `render_ui` to `ToolCallDetail { type: "unknown" }`, so no protocol type changed. A client that cannot validate a completed call (for example a newer daemon added a type) shows the call's `fallbackText` instead of a card.

## Card states

| Tool call status     | Card                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| running              | Skeleton by type, plus only the fields that are already complete and valid |
| completed, valid     | The card, from validated data only                                         |
| completed, not valid | `fallbackText` as plain text, or nothing                                   |
| failed or canceled   | Nothing; the model's retry draws the card                                  |

The card's minimum height starts at a per-type estimate and only grows, so the list does not jump when the skeleton turns into the card. A failed call is the only case that shrinks.

`render_ui` calls are excluded from tool-call grouping (`tool-calls/detail-level/grouping.ts`) so a card stays between the sentences around it in both detail levels. The Chat setting "Show chat cards" turns cards off and shows the call as a normal tool call.

## Palette

Cards read `theme.genui`, set per scheme in `styles/theme.ts` from `genui/tokens.ts`. Do not branch on `theme.colorScheme` inside `StyleSheet.create`: on web Unistyles turns theme strings into CSS variables, so the branch always takes the light path. SVG fills are props, not styles, so charts get colors through one `withUnistyles` wrapper in `render-ui-card.tsx`. The palette is an exception to the design system; see [design.md](design.md) §13.

## Trying it without a model

The mock provider plays scripted calls. Send `emit synthetic genui cards` to a mock agent for every component, a rejected call and text between them, or `emit synthetic genui card chart.pie` for one. `packages/app/e2e/browser/genui-cards.spec.ts` uses this to screenshot every card in light and dark at wide and narrow widths.
