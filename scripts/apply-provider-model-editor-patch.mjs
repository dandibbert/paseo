import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      throw new Error(`Patch anchor not found in ${path}: ${from.slice(0, 120)}`);
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

patch("packages/app/src/components/provider-model-editor-sheet.tsx", [
  [
    "  const editingExisting = Boolean(originalModelId);",
    "  const editingExisting = Boolean(model);",
  ],
  [
    `    const nextAdditionalModels = originalModelId\n      ? additionalModels.map((entry) => (entry.id === originalModelId ? nextModel : entry))\n      : [...additionalModels, nextModel];`,
    `    const hasOriginalOverride =\n      Boolean(originalModelId) && additionalModels.some((entry) => entry.id === originalModelId);\n    const nextAdditionalModels = hasOriginalOverride\n      ? additionalModels.map((entry) => (entry.id === originalModelId ? nextModel : entry))\n      : [...additionalModels, nextModel];`,
  ],
]);

patch("packages/app/src/components/provider-diagnostic-sheet.tsx", [
  [
    'import { AlertTriangle, Copy, FileText, Plus, RotateCw, Trash2 } from "lucide-react-native";',
    'import { AlertTriangle, Copy, FileText, Pencil, Plus, RotateCw, Trash2 } from "lucide-react-native";',
  ],
  [
    `  AdaptiveModalSheet,\n  AdaptiveTextInput,\n  type SheetHeader,`,
    `  AdaptiveModalSheet,\n  type SheetHeader,`,
  ],
  [
    'import { isWeb } from "@/constants/platform";\n',
    "",
  ],
  [
    `import {\n  resolveProviderDiscoveredModels,\n  type ProviderDiscoveredModelsCache,\n} from "./provider-diagnostic-models";`,
    `import {\n  resolveProviderDiscoveredModels,\n  type ProviderDiscoveredModelsCache,\n} from "./provider-diagnostic-models";\nimport { ProviderModelEditorSheet } from "./provider-model-editor-sheet";`,
  ],
  [
    `function DiscoveredModelRow({ model }: { model: AgentModelDefinition }) {\n  return (\n    <View style={sheetStyles.modelRow}>\n      <Text style={sheetStyles.modelTitle} numberOfLines={1}>\n        {model.label}\n      </Text>\n      <Text\n        style={sheetStyles.monoHint}\n        numberOfLines={1}\n        selectable\n        dataSet={CODE_SURFACE_DATASET}\n      >\n        {model.id}\n      </Text>\n      {model.description ? (\n        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>\n          {model.description}\n        </Text>\n      ) : null}\n    </View>\n  );\n}`,
    `function DiscoveredModelRow({\n  model,\n  onEdit,\n}: {\n  model: AgentModelDefinition;\n  onEdit: (model: AgentModelDefinition) => void;\n}) {\n  const { theme } = useUnistyles();\n  return (\n    <View style={sheetStyles.modelRow}>\n      <Text style={sheetStyles.modelTitle} numberOfLines={1}>\n        {model.label}\n      </Text>\n      <Text\n        style={sheetStyles.monoHint}\n        numberOfLines={1}\n        selectable\n        dataSet={CODE_SURFACE_DATASET}\n      >\n        {model.id}\n      </Text>\n      {model.contextWindowMaxTokens ? (\n        <Text style={sheetStyles.modelMeta} numberOfLines={1}>\n          {Math.round(model.contextWindowMaxTokens / 1000)}k ctx\n        </Text>\n      ) : null}\n      {model.description ? (\n        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>\n          {model.description}\n        </Text>\n      ) : (\n        <View style={sheetStyles.modelRowFiller} />\n      )}\n      <Pressable\n        onPress={() => onEdit(model)}\n        hitSlop={8}\n        style={({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [\n          sheetStyles.iconButton,\n          (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,\n        ]}\n        accessibilityRole="button"\n        accessibilityLabel={\`Edit model ${model.id}\`}\n      >\n        <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />\n      </Pressable>\n    </View>\n  );\n}`,
  ],
  [
    `function CustomModelRow({\n  model,\n  deleting,\n  onDelete,\n}: {\n  model: ProviderProfileModel;\n  deleting: boolean;\n  onDelete: (modelId: string) => void;\n}) {`,
    `function CustomModelRow({\n  model,\n  deleting,\n  onEdit,\n  onDelete,\n}: {\n  model: ProviderProfileModel;\n  deleting: boolean;\n  onEdit: (model: ProviderProfileModel) => void;\n  onDelete: (modelId: string) => void;\n}) {`,
  ],
  [
    `      <View style={sheetStyles.modelRowFiller} />\n      <Pressable\n        onPress={handleDelete}`,
    `      {model.contextWindowMaxTokens ? (\n        <Text style={sheetStyles.modelMeta} numberOfLines={1}>\n          {Math.round(model.contextWindowMaxTokens / 1000)}k ctx\n        </Text>\n      ) : null}\n      <View style={sheetStyles.modelRowFiller} />\n      <Pressable\n        onPress={() => onEdit(model)}\n        hitSlop={8}\n        style={({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [\n          sheetStyles.iconButton,\n          (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,\n        ]}\n        accessibilityRole="button"\n        accessibilityLabel={\`Edit model ${model.id}\`}\n      >\n        <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />\n      </Pressable>\n      <Pressable\n        onPress={handleDelete}`,
  ],
  [
    `function AddCustomModelSubSheet({\n  provider,\n  serverId,\n  visible,\n  onClose,\n  refresh,\n}: {\n  provider: string;\n  serverId: string;\n  visible: boolean;\n  onClose: () => void;\n  refresh: (providers?: AgentProvider[]) => Promise<void>;\n}) {\n  const { t } = useTranslation();\n  const { theme } = useUnistyles();\n  const { config, patchConfig } = useDaemonConfig(serverId);\n  const [input, setInput] = useState(\"\");\n  const [error, setError] = useState<string | null>(null);\n  const [saving, setSaving] = useState(false);\n\n  const additionalModels = useMemo(\n    () => config?.providers?.[provider]?.additionalModels ?? [],\n    [config?.providers, provider],\n  );\n  const trimmed = input.trim();\n  const canAdd = trimmed.length > 0 && !additionalModels.some((model) => model.id === trimmed);\n\n  useEffect(() => {\n    if (!visible) {\n      setInput(\"\");\n      setError(null);\n    }\n  }, [visible]);\n\n  const handleAdd = useCallback(() => {\n    if (!canAdd) return;\n    setError(null);\n    setSaving(true);\n    void patchConfig({\n      providers: {\n        [provider]: {\n          additionalModels: [...additionalModels, { id: trimmed, label: trimmed }],\n        },\n      },\n    })\n      .then(() => refresh([provider]))\n      .then(() => onClose())\n      .catch((err) => {\n        setError(err instanceof Error ? err.message : t(\"settings.providers.models.failedToSave\"));\n      })\n      .finally(() => setSaving(false));\n  }, [additionalModels, canAdd, onClose, patchConfig, provider, refresh, t, trimmed]);\n\n  const header = useMemo<SheetHeader>(\n    () => ({ title: t(\"settings.providers.models.addCustomTitle\") }),\n    [t],\n  );\n\n  return (\n    <AdaptiveModalSheet\n      header={header}\n      visible={visible}\n      onClose={onClose}\n      desktopMaxWidth={420}\n      snapPoints={ADD_SNAP_POINTS}\n      testID=\"add-custom-model-sheet\"\n    >\n      <View style={sheetStyles.formGroup}>\n        <Text style={sheetStyles.formLabel}>{t(\"settings.providers.models.modelId\")}</Text>\n        <AdaptiveTextInput\n          initialValue={input}\n          resetKey={\`add-custom-${visible}\`}\n          onChangeText={setInput}\n          onSubmitEditing={handleAdd}\n          placeholder={t(\"settings.providers.models.modelIdPlaceholder\")}\n          placeholderTextColor={theme.colors.foregroundMuted}\n          autoCapitalize=\"none\"\n          autoCorrect={false}\n          returnKeyType=\"done\"\n          // @ts-expect-error - outlineStyle is web-only\n          style={[sheetStyles.formInput, isWeb && { outlineStyle: \"none\" }]}\n        />\n        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}\n        <View style={sheetStyles.formActions}>\n          <Button variant=\"secondary\" size=\"sm\" onPress={onClose} disabled={saving}>\n            {t(\"common.actions.cancel\")}\n          </Button>\n          <Button variant=\"default\" size=\"sm\" onPress={handleAdd} disabled={!canAdd || saving}>\n            {saving ? t(\"settings.providers.models.adding\") : t(\"settings.providers.models.add\")}\n          </Button>\n        </View>\n      </View>\n    </AdaptiveModalSheet>\n  );\n}`,
    `function AddCustomModelSubSheet({\n  provider,\n  serverId,\n  visible,\n  onClose,\n  refresh,\n}: {\n  provider: string;\n  serverId: string;\n  visible: boolean;\n  onClose: () => void;\n  refresh: (providers?: AgentProvider[]) => Promise<void>;\n}) {\n  return (\n    <ProviderModelEditorSheet\n      provider={provider}\n      serverId={serverId}\n      visible={visible}\n      model={null}\n      originalModelId={null}\n      onClose={onClose}\n      refresh={refresh}\n    />\n  );\n}`,
  ],
  [
    `  onRefresh: () => void;\n  onDeleteCustom: (modelId: string) => void;`,
    `  onRefresh: () => void;\n  onEditDiscovered: (model: AgentModelDefinition) => void;\n  onEditCustom: (model: ProviderProfileModel) => void;\n  onDeleteCustom: (modelId: string) => void;`,
  ],
  [
    `    onRefresh,\n    onDeleteCustom,\n    theme,`,
    `    onRefresh,\n    onEditDiscovered,\n    onEditCustom,\n    onDeleteCustom,\n    theme,`,
  ],
  [
    `<DiscoveredModelRow key={model.id} model={model} />`,
    `<DiscoveredModelRow key={model.id} model={model} onEdit={onEditDiscovered} />`,
  ],
  [
    `                deleting={deletingModelId === model.id}\n                onDelete={onDeleteCustom}`,
    `                deleting={deletingModelId === model.id}\n                onEdit={onEditCustom}\n                onDelete={onDeleteCustom}`,
  ],
  [
    `  const [addSheetOpen, setAddSheetOpen] = useState(false);\n  const [diagSheetOpen, setDiagSheetOpen] = useState(false);`,
    `  const [addSheetOpen, setAddSheetOpen] = useState(false);\n  const [editSheetOpen, setEditSheetOpen] = useState(false);\n  const [editingModel, setEditingModel] = useState<AgentModelDefinition | ProviderProfileModel | null>(null);\n  const [editingOriginalModelId, setEditingOriginalModelId] = useState<string | null>(null);\n  const [diagSheetOpen, setDiagSheetOpen] = useState(false);`,
  ],
  [
    `      setAddSheetOpen(false);\n      setDiagSheetOpen(false);`,
    `      setAddSheetOpen(false);\n      setEditSheetOpen(false);\n      setEditingModel(null);\n      setEditingOriginalModelId(null);\n      setDiagSheetOpen(false);`,
  ],
  [
    `  const filteredCustom = useMemo(\n    () => rankModels(additionalModels, q, (m) => [m.label, m.id]),`,
    `  const filteredCustom = useMemo(\n    () =>\n      rankModels(additionalModels, q, (m) => [\n        m.label,\n        m.id,\n        m.description ?? \"\",\n        ...(m.aliases ?? []),\n      ]),`,
  ],
  [
    `  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);\n  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);`,
    `  const handleEditDiscovered = useCallback(\n    (model: AgentModelDefinition) => {\n      const override = additionalModels.find((entry) => entry.id === model.id);\n      setEditingModel(override ?? model);\n      setEditingOriginalModelId(model.id);\n      setEditSheetOpen(true);\n    },\n    [additionalModels],\n  );\n  const handleEditCustom = useCallback((model: ProviderProfileModel) => {\n    setEditingModel(model);\n    setEditingOriginalModelId(model.id);\n    setEditSheetOpen(true);\n  }, []);\n  const handleCloseEditSheet = useCallback(() => setEditSheetOpen(false), []);\n  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);\n  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);`,
  ],
  [
    `          onRefresh={handleRefreshModels}\n          onDeleteCustom={handleDeleteCustom}`,
    `          onRefresh={handleRefreshModels}\n          onEditDiscovered={handleEditDiscovered}\n          onEditCustom={handleEditCustom}\n          onDeleteCustom={handleDeleteCustom}`,
  ],
  [
    `      <DiagnosticSubSheet\n        provider={provider}`,
    `      <ProviderModelEditorSheet\n        provider={provider}\n        serverId={serverId}\n        visible={editSheetOpen}\n        model={editingModel}\n        originalModelId={editingOriginalModelId}\n        onClose={handleCloseEditSheet}\n        refresh={refresh}\n      />\n      <DiagnosticSubSheet\n        provider={provider}`,
  ],
  [
    `  descriptionInline: {\n    flex: 1,\n    fontSize: theme.fontSize.sm,\n    color: theme.colors.foregroundMuted,\n  },`,
    `  descriptionInline: {\n    flex: 1,\n    fontSize: theme.fontSize.sm,\n    color: theme.colors.foregroundMuted,\n  },\n  modelMeta: {\n    flexShrink: 0,\n    fontSize: theme.fontSize.sm,\n    color: theme.colors.foregroundMuted,\n  },`,
  ],
  [
    `const ADD_SNAP_POINTS = ["40%"];\n`,
    "",
  ],
]);

patch("packages/server/src/server/agent/provider-registry.ts", [
  [
    `  providerParams?: unknown;\n  customProvider?: {`,
    `  providerParams?: unknown;\n  configuredModels?: ProviderProfileModel[];\n  customProvider?: {`,
  ],
  [
    `      workspaceGitService: options?.workspaceGitService,\n      customProvider: options?.customProvider,`,
    `      workspaceGitService: options?.workspaceGitService,\n      customProvider: options?.customProvider,\n      configuredModels: options?.configuredModels,`,
  ],
  [
    `          providerParams: override?.params,\n        }),`,
    `          providerParams: override?.params,\n          configuredModels: [...(override?.models ?? []), ...(override?.additionalModels ?? [])],\n        }),`,
  ],
  [
    `          providerParams,\n          customProvider: {`,
    `          providerParams,\n          configuredModels: [...(override.models ?? []), ...(override.additionalModels ?? [])],\n          customProvider: {`,
  ],
]);

patch("packages/server/src/server/agent/providers/codex-app-server-agent.ts", [
  [
    `  type ProviderRuntimeSettings,\n  type ResolvedProviderLaunch,`,
    `  type ProviderProfileModel,\n  type ProviderRuntimeSettings,\n  type ResolvedProviderLaunch,`,
  ],
  [
    `  customCodexConfig?: Record<string, unknown> | null;\n  _createCodexClient?: (`,
    `  customCodexConfig?: Record<string, unknown> | null;\n  configuredModels?: ProviderProfileModel[];\n  _createCodexClient?: (`,
  ],
  [
    `function normalizeCodexModelLabel(displayName: string): string {\n  return displayName.replace(/\\bgpt\\b/gi, "GPT");\n}\n`,
    `function normalizeCodexModelLabel(displayName: string): string {\n  return displayName.replace(/\\bgpt\\b/gi, "GPT");\n}\n\nexport function resolveCodexConfiguredModelConfig(\n  modelId: string | null | undefined,\n  configuredModels: readonly ProviderProfileModel[] | undefined,\n): Record<string, unknown> | null {\n  const normalizedModelId = normalizeCodexModelId(modelId);\n  if (!normalizedModelId || !configuredModels?.length) {\n    return null;\n  }\n  const model = configuredModels.find(\n    (candidate) =>\n      candidate.id === normalizedModelId || candidate.aliases?.includes(normalizedModelId) === true,\n  );\n  if (!model?.contextWindowMaxTokens) {\n    return null;\n  }\n  return { model_context_window: model.contextWindowMaxTokens };\n}\n`,
  ],
  [
    `    if (this.deps.customCodexConfig) {\n      Object.assign(innerConfig, this.deps.customCodexConfig);\n    }\n    if (this.config.mcpServers) {`,
    `    if (this.deps.customCodexConfig) {\n      Object.assign(innerConfig, this.deps.customCodexConfig);\n    }\n    const configuredModelConfig = resolveCodexConfiguredModelConfig(\n      this.config.model,\n      this.deps.configuredModels,\n    );\n    if (configuredModelConfig) {\n      Object.assign(innerConfig, configuredModelConfig);\n    }\n    if (this.config.mcpServers) {`,
  ],
]);

fs.writeFileSync(
  "packages/protocol/src/provider-config.model-profile.test.ts",
  `import { describe, expect, it } from "vitest";\nimport { ProviderProfileModelSchema } from "./provider-config.js";\n\ndescribe("ProviderProfileModelSchema", () => {\n  it("preserves the full editable model profile", () => {\n    const parsed = ProviderProfileModelSchema.parse({\n      id: "grok-4-fast",\n      label: "Grok 4 Fast",\n      aliases: ["grok"],\n      isSelectable: true,\n      description: "Custom OpenAI-compatible model",\n      isDefault: true,\n      contextWindowMaxTokens: 500000,\n      defaultThinkingOptionId: "high",\n      thinkingOptions: [\n        { id: "low", label: "Low" },\n        {\n          id: "high",\n          label: "High",\n          isDefault: true,\n          metadata: { budget: "high" },\n        },\n      ],\n      metadata: { family: "grok" },\n    });\n\n    expect(parsed.contextWindowMaxTokens).toBe(500000);\n    expect(parsed.aliases).toEqual(["grok"]);\n    expect(parsed.defaultThinkingOptionId).toBe("high");\n    expect(parsed.thinkingOptions?.[1]?.metadata).toEqual({ budget: "high" });\n    expect(parsed.metadata).toEqual({ family: "grok" });\n  });\n\n  it("rejects invalid context windows", () => {\n    expect(() =>\n      ProviderProfileModelSchema.parse({ id: "bad", label: "Bad", contextWindowMaxTokens: 0 }),\n    ).toThrow();\n    expect(() =>\n      ProviderProfileModelSchema.parse({ id: "bad", label: "Bad", contextWindowMaxTokens: 1.5 }),\n    ).toThrow();\n  });\n});\n`,
);

fs.writeFileSync(
  "packages/server/src/server/agent/providers/codex-configured-model.test.ts",
  `import { describe, expect, it } from "vitest";\nimport { resolveCodexConfiguredModelConfig } from "./codex-app-server-agent.js";\n\ndescribe("resolveCodexConfiguredModelConfig", () => {\n  it("forwards an explicit context window to Codex", () => {\n    expect(\n      resolveCodexConfiguredModelConfig("grok-4-fast", [\n        { id: "grok-4-fast", label: "Grok 4 Fast", contextWindowMaxTokens: 500000 },\n      ]),\n    ).toEqual({ model_context_window: 500000 });\n  });\n\n  it("resolves aliases and leaves unspecified models alone", () => {\n    const models = [\n      {\n        id: "grok-4-fast",\n        label: "Grok 4 Fast",\n        aliases: ["grok"],\n        contextWindowMaxTokens: 500000,\n      },\n    ];\n    expect(resolveCodexConfiguredModelConfig("grok", models)).toEqual({\n      model_context_window: 500000,\n    });\n    expect(resolveCodexConfiguredModelConfig("other", models)).toBeNull();\n  });\n});\n`,
);

patch("docs/custom-providers.md", [
  [
    `- \`models\` / \`additionalModels\` — model overrides or additions.`,
    `- \`models\` / \`additionalModels\` — model overrides or additions. Model profiles can configure \`id\`, \`label\`, \`description\`, \`aliases\`, \`isSelectable\`, \`isDefault\`, \`contextWindowMaxTokens\`, \`thinkingOptions\`, \`defaultThinkingOptionId\`, and arbitrary \`metadata\`. The Provider UI exposes these fields; for Codex-derived providers an explicit \`contextWindowMaxTokens\` is forwarded to Codex as \`model_context_window\`.` ,`,
  ],
]);
