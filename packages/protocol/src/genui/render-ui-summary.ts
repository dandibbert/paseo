// One-line text for a render_ui call wherever the card itself is not drawn: push
// notifications, `paseo logs`, and handoff context. Reads the raw tool input without
// validating it, so it also works for calls that were rejected or are still streaming.
// Returns null when the input carries nothing readable.
export function summarizeRenderUiInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const parts = [record.title, record.fallbackText]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
  if (parts.length === 0) {
    return typeof record.type === "string" && record.type.length > 0 ? record.type : null;
  }
  return parts.join(" — ");
}
