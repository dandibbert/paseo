import { describe, expect, it } from "vitest";
import { ProviderProfileModelSchema } from "./provider-config.js";

describe("ProviderProfileModelSchema", () => {
  it("preserves the full editable model profile", () => {
    const parsed = ProviderProfileModelSchema.parse({
      id: "grok-4-fast",
      label: "Grok 4 Fast",
      aliases: ["grok"],
      isSelectable: true,
      description: "Custom OpenAI-compatible model",
      isDefault: true,
      contextWindowMaxTokens: 500000,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "low", label: "Low" },
        {
          id: "high",
          label: "High",
          isDefault: true,
          metadata: { budget: "high" },
        },
      ],
      metadata: { family: "grok" },
    });

    expect(parsed.contextWindowMaxTokens).toBe(500000);
    expect(parsed.aliases).toEqual(["grok"]);
    expect(parsed.defaultThinkingOptionId).toBe("high");
    expect(parsed.thinkingOptions?.[1]?.metadata).toEqual({ budget: "high" });
    expect(parsed.metadata).toEqual({ family: "grok" });
  });

  it("rejects invalid context windows", () => {
    expect(() =>
      ProviderProfileModelSchema.parse({
        id: "bad",
        label: "Bad",
        contextWindowMaxTokens: 0,
      })
    ).toThrow();
    expect(() =>
      ProviderProfileModelSchema.parse({
        id: "bad",
        label: "Bad",
        contextWindowMaxTokens: 1.5,
      })
    ).toThrow();
  });
});
