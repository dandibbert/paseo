import { describe, expect, it } from "vitest";
import { resolveCodexConfiguredModelConfig } from "./codex-app-server-agent.js";

describe("resolveCodexConfiguredModelConfig", () => {
  it("forwards an explicit context window to Codex", () => {
    expect(
      resolveCodexConfiguredModelConfig("grok-4-fast", [
        {
          id: "grok-4-fast",
          label: "Grok 4 Fast",
          contextWindowMaxTokens: 500000,
        },
      ]),
    ).toEqual({ model_context_window: 500000 });
  });

  it("resolves aliases and leaves unspecified models alone", () => {
    const models = [
      {
        id: "grok-4-fast",
        label: "Grok 4 Fast",
        aliases: ["grok"],
        contextWindowMaxTokens: 500000,
      },
    ];
    expect(resolveCodexConfiguredModelConfig("grok", models)).toEqual({
      model_context_window: 500000,
    });
    expect(resolveCodexConfiguredModelConfig("other", models)).toBeNull();
  });
});
