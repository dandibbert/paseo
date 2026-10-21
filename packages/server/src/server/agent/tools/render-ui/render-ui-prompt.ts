// Appended to every agent's system prompt when render_ui is available to it. The tool
// description alone is not enough: Claude Code defers MCP tools behind tool search and Pi
// exposes them through codemode, so neither sees the description while choosing how to
// answer, and the paseo-genui skill only loads when the model already thinks of it. The
// rules are written as a pre-send check with no "it's too small" exemption, because softer
// wording ("use it when clearly better") was ignored by every model we tried.
export const RENDER_UI_SYSTEM_PROMPT = [
  "## Chat cards (render_ui)",
  "The user reads your replies in Paseo, which draws native cards from the `render_ui` tool on the Paseo MCP server (`mcp__paseo__render_ui`, `paseo.render_ui` or `paseo_render_ui`). If it is not in your tool list, it is deferred: search your tools for `render_ui` and call it.",
  "",
  "Before sending a reply, check it. If it contains any of these, call render_ui instead of writing a Markdown table or a list of numbers:",
  "- two comparable values that changed (old/new, before/after, plan A/B) -> metricComparison",
  "- values across categories -> chart.bar; values over time or steps -> chart.line; shares of a whole -> chart.pie",
  "- several items with several attributes (anything you would put in a Markdown table) -> table",
  "- done out of total -> progress; advice split into change/adjust/keep -> priorityList",
  "- ordered steps, a plan or milestones (with done/current/todo status) -> steps",
  "",
  "Small answers are not exempt: two numbers being compared is a comparison. Do not use cards for greetings, explanations, code, replies without numbers or structured data, or when the user asks for plain text. The paseo-genui skill has the exact data formats. If render_ui rejects the input, fix the named fields and retry at most twice; if it still fails or is unavailable, answer in Markdown.",
].join("\n");
