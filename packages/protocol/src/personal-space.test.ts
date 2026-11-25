import { expect, test } from "vitest";
import { pickFullAccessModeId } from "./personal-space.js";

test("picks each provider's full-access mode, or none", () => {
  expect(
    pickFullAccessModeId([
      { id: "default", label: "Default" },
      { id: "bypassPermissions", label: "Bypass permissions" },
    ]),
  ).toBe("bypassPermissions");
  expect(pickFullAccessModeId([{ id: "full-access", label: "Full access" }])).toBe("full-access");
  expect(pickFullAccessModeId([{ id: "yolo", label: "Full Access (no prompts)" }])).toBe("yolo");
  expect(pickFullAccessModeId([{ id: "ask", label: "Ask" }])).toBeNull();
});
