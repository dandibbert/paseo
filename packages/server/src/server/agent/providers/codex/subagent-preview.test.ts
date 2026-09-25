import { expect, test } from "vitest";
import { CodexSubagentPreview, SUBAGENT_PREVIEW_MAX_BYTES } from "./subagent-preview.js";

test("keeps parent preview bounded through 20,000 child updates", () => {
  const preview = new CodexSubagentPreview();
  for (let i = 0; i < 20_000; i++) {
    preview.upsert(String(i), { type: "assistant_message", text: `${i}: ${"验证".repeat(1000)}` });
    expect(Buffer.byteLength(preview.render())).toBeLessThanOrEqual(SUBAGENT_PREVIEW_MAX_BYTES);
  }
  expect(preview.render()).toContain("open the subagent for full history");
  expect(preview.render()).not.toContain("0: ");
});

test("updates an existing item without duplicating it", () => {
  const preview = new CodexSubagentPreview();
  preview.upsert("item", { type: "assistant_message", text: "partial" });
  preview.upsert("item", { type: "assistant_message", text: "complete" });
  expect(preview.render()).toBe("[Assistant] complete");
});
