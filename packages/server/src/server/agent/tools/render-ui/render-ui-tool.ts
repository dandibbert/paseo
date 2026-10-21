import { z } from "zod";
import {
  RENDER_UI_MAX_INPUT_BYTES,
  RENDER_UI_SCHEMA_VERSION,
  RENDER_UI_TYPES,
  type RenderUiType,
} from "@getpaseo/protocol/genui/render-ui-schema";
import {
  validateRenderUiInput,
  type RenderUiDerived,
  type RenderUiIssue,
} from "@getpaseo/protocol/genui/render-ui-validate";
import { PaseoToolInputError } from "../types.js";
import { RENDER_UI_FORMATS, renderMinimalFormatTable } from "./render-ui-formats.js";

const MAX_REPORTED_ISSUES = 8;

export const RENDER_UI_TITLE = "Render UI";

export const RENDER_UI_DESCRIPTION = [
  "Show a native card in the chat. Decide this when you choose how to answer: whenever the answer contains one of these data shapes, call render_ui instead of writing a Markdown table, a list of numbers or an HTML file. Two comparable values that changed (old/new, before/after, A/B) -> metricComparison. One key number -> metric. Done out of total -> progress. Values across categories -> chart.bar. Values over time or steps -> chart.line. Shares of a whole -> chart.pie. Several items with several attributes (anything you would put in a Markdown table) -> table. Recommendations split into change/adjust/keep -> priorityList. Several of these together -> card or grid.",
  "",
  "Do not call it for greetings, explanations, code fixes or code snippets, narrative, answers without numbers or structured data, or when the user asks for plain text. One answer usually needs one or two cards. Write one lead-in sentence before the call and the interpretation after it; do not repeat every number from the card in the text.",
  "",
  "Parameters: {type, title?, data, fallbackText?, schemaVersion?}. Always pass fallbackText: 1-3 sentences that stand alone with the key entities, numbers and units. Give raw numbers only; percentages and changes are computed by Paseo and returned in `derived`, which you may quote. Never invent values; use null for unknown. Colors, CSS, HTML and pixel sizes are not accepted. `changeIntent` says whether the change is good, bad or neutral for the user; omit it when unsure.",
  "",
  "Minimal `data` per type ([x] and [field] stand for the field names you chose, not literal keys):",
  "",
  renderMinimalFormatTable(),
  "",
  "card children are leaf types; grid children are leaf types or one level of card. Children take {type,title?,data} with no fallbackText.",
  "",
  "On a validation error, fix the named fields and call again, at most two more times; then answer in Markdown. Success means the data was accepted, not that a client has displayed it.",
].join("\n");

// Kept loose on purpose: the MCP layer only checks the envelope. Full per-type
// validation happens in the handler so errors can carry the correct format.
export const RENDER_UI_INPUT_SHAPE = {
  type: z.enum(RENDER_UI_TYPES).describe("Component type."),
  title: z.string().optional().describe("Optional card title."),
  data: z
    .record(z.string(), z.unknown())
    .describe("Component data in the minimal format for this type."),
  fallbackText: z
    .string()
    .optional()
    .describe("Standalone plain-text summary for notifications and older clients."),
  schemaVersion: z
    .literal(RENDER_UI_SCHEMA_VERSION)
    .optional()
    .describe("Protocol version; omit for 1."),
};

export const RENDER_UI_OUTPUT_SHAPE = {
  ok: z.literal(true),
  accepted: z.literal(true),
  type: z.enum(RENDER_UI_TYPES),
  derived: z.record(z.string(), z.unknown()),
};

export interface RenderUiToolResult {
  ok: true;
  accepted: true;
  type: RenderUiType;
  derived: RenderUiDerived;
}

export function measureJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export function acceptRenderUiInput(input: unknown): RenderUiToolResult {
  const bytes = measureJsonBytes(input);
  if (bytes > RENDER_UI_MAX_INPUT_BYTES) {
    throw new PaseoToolInputError(
      `render_ui input is ${bytes} bytes; the limit is ${RENDER_UI_MAX_INPUT_BYTES}. Summarize or aggregate the data (fewer rows, shorter labels) and call again.`,
    );
  }
  const result = validateRenderUiInput(input);
  if (!result.ok) {
    throw new PaseoToolInputError(formatRenderUiValidationError(result));
  }
  return { ok: true, accepted: true, type: result.input.type, derived: result.derived };
}

function formatIssuePath(path: RenderUiIssue["path"]): string {
  if (path.length === 0) {
    return "(input)";
  }
  return path.reduce<string>((text, segment) => {
    if (typeof segment === "number") {
      return `${text}[${segment}]`;
    }
    return text.length === 0 ? segment : `${text}.${segment}`;
  }, "");
}

export function formatRenderUiValidationError(input: {
  type: RenderUiType | null;
  issues: RenderUiIssue[];
}): string {
  const lines = ["render_ui rejected the input. Fix these fields and call again:"];
  for (const issue of input.issues.slice(0, MAX_REPORTED_ISSUES)) {
    lines.push(`- ${formatIssuePath(issue.path)}: ${issue.message}`);
  }
  if (input.issues.length > MAX_REPORTED_ISSUES) {
    lines.push(`- …and ${input.issues.length - MAX_REPORTED_ISSUES} more`);
  }
  lines.push("");
  if (input.type === null) {
    lines.push(`type must be one of: ${RENDER_UI_TYPES.join(", ")}.`);
    return lines.join("\n");
  }
  const format = RENDER_UI_FORMATS[input.type];
  lines.push(`Minimal data for ${input.type}: ${format.minimal}`);
  lines.push("Example:");
  lines.push(JSON.stringify(format.example));
  return lines.join("\n");
}
