import { describe, expect, it } from "vitest";
import { resolveCodexConfiguredModelConfig } from "./codex-app-server-agent.js";
import {
  augmentCodexModelCatalog,
  buildCodexAppServerArgs,
} from "./codex/model-catalog-override.js";

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

describe("augmentCodexModelCatalog", () => {
  const bundledTemplate = {
    slug: "gpt-bundled",
    display_name: "Bundled GPT",
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    model_messages: { instructions_template: "base instructions" },
    context_window: 272000,
    max_context_window: 272000,
    auto_compact_token_limit: 200000,
    effective_context_window_percent: 95,
    preserved_marker: "keep-me",
  };

  it("adds an unknown configured model without replacing the bundled catalog", () => {
    const result = augmentCodexModelCatalog(
      { etag: "bundled-etag", models: [bundledTemplate] },
      [
        {
          id: "grok-4.6",
          aliases: ["grok"],
          label: "Grok 4.6",
          contextWindowMaxTokens: 500000,
        },
      ],
    );

    expect(result?.etag).toBe("bundled-etag");
    const models = result?.models as Array<Record<string, unknown>>;
    expect(models.find((model) => model.slug === "gpt-bundled")).toMatchObject({
      context_window: 272000,
      max_context_window: 272000,
      effective_context_window_percent: 95,
      preserved_marker: "keep-me",
    });
    expect(models.find((model) => model.slug === "grok-4.6")).toMatchObject({
      slug: "grok-4.6",
      display_name: "Grok 4.6",
      context_window: 500000,
      max_context_window: 500000,
      auto_compact_token_limit: null,
      effective_context_window_percent: 100,
      visibility: "none",
      preserved_marker: "keep-me",
    });
    expect(models.find((model) => model.slug === "grok")).toMatchObject({
      slug: "grok",
      context_window: 500000,
      max_context_window: 500000,
      effective_context_window_percent: 100,
    });
  });

  it("raises an existing catalog model max instead of letting Codex clamp it", () => {
    const result = augmentCodexModelCatalog(
      { models: [bundledTemplate] },
      [
        {
          id: "gpt-bundled",
          label: "Bundled GPT",
          contextWindowMaxTokens: 500000,
        },
      ],
    );
    const models = result?.models as Array<Record<string, unknown>>;
    expect(models[0]).toMatchObject({
      preserved_marker: "keep-me",
      context_window: 500000,
      max_context_window: 500000,
      auto_compact_token_limit: null,
      effective_context_window_percent: 100,
    });
  });

  it("does nothing when no model has an explicit context window", () => {
    expect(
      augmentCodexModelCatalog(
        { models: [bundledTemplate] },
        [{ id: "grok-4.6", label: "Grok 4.6" }],
      ),
    ).toBeNull();
  });
});

describe("buildCodexAppServerArgs", () => {
  it("injects the generated catalog as a global config override before app-server", () => {
    expect(
      buildCodexAppServerArgs(
        ["--profile", "custom"],
        'model_catalog_json="/tmp/paseo models.json"',
        true,
      ),
    ).toEqual([
      "--profile",
      "custom",
      "-c",
      'model_catalog_json="/tmp/paseo models.json"',
      "app-server",
      "--enable",
      "goals",
    ]);
  });
});
