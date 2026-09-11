import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type {
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import {
  ProviderProfileModelSchema,
  type ProviderProfileModel,
} from "@getpaseo/protocol/provider-config";

type EditableModel = ProviderProfileModel | AgentModelDefinition;
type OptionalBoolean = boolean | undefined;

interface ProviderModelEditorSheetProps {
  provider: string;
  serverId: string;
  visible: boolean;
  model?: EditableModel | null;
  /** Existing additionalModels id. Omit when adding a new override/model. */
  originalModelId?: string | null;
  onClose: () => void;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}

function parseAliases(value: string): string[] | undefined {
  const aliases = Array.from(
    new Set(
      value
        .split(/[\n,]/u)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
  return aliases.length > 0 ? aliases : undefined;
}

function parseOptionalJson(
  value: string,
  expected: "object" | "array"
): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed: unknown = JSON.parse(trimmed);
  if (expected === "array" && !Array.isArray(parsed)) {
    throw new Error("Thinking options must be a JSON array.");
  }
  if (
    expected === "object" &&
    (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
  ) {
    throw new Error("Metadata must be a JSON object.");
  }
  return parsed;
}

function formatJson(value: unknown): string {
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function OptionalBooleanControl({
  value,
  onChange,
}: {
  value: OptionalBoolean;
  onChange: (value: OptionalBoolean) => void;
}) {
  return (
    <View style={editorStyles.booleanRow}>
      <Button
        variant={value === undefined ? "default" : "secondary"}
        size="sm"
        onPress={() => onChange(undefined)}
      >
        Inherit
      </Button>
      <Button
        variant={value === true ? "default" : "secondary"}
        size="sm"
        onPress={() => onChange(true)}
      >
        Yes
      </Button>
      <Button
        variant={value === false ? "default" : "secondary"}
        size="sm"
        onPress={() => onChange(false)}
      >
        No
      </Button>
    </View>
  );
}

export function ProviderModelEditorSheet({
  provider,
  serverId,
  visible,
  model,
  originalModelId,
  onClose,
  refresh,
}: ProviderModelEditorSheetProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);

  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [aliases, setAliases] = useState("");
  const [isDefault, setIsDefault] = useState<OptionalBoolean>(undefined);
  const [isSelectable, setIsSelectable] = useState<OptionalBoolean>(undefined);
  const [defaultThinkingOptionId, setDefaultThinkingOptionId] = useState("");
  const [thinkingOptionsJson, setThinkingOptionsJson] = useState("");
  const [metadataJson, setMetadataJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider]
  );

  useEffect(() => {
    if (!visible) {
      setError(null);
      setSaving(false);
      return;
    }
    setModelId(model?.id ?? "");
    setLabel(model?.label ?? "");
    setDescription(model?.description ?? "");
    setContextWindow(
      model?.contextWindowMaxTokens != null
        ? String(model.contextWindowMaxTokens)
        : ""
    );
    setAliases(model?.aliases?.join(", ") ?? "");
    setIsDefault(model?.isDefault);
    setIsSelectable(model?.isSelectable);
    setDefaultThinkingOptionId(model?.defaultThinkingOptionId ?? "");
    setThinkingOptionsJson(formatJson(model?.thinkingOptions));
    setMetadataJson(formatJson(model?.metadata));
    setError(null);
  }, [model, visible]);

  const resetKey = `${visible ? "open" : "closed"}:${
    originalModelId ?? "new"
  }:${model?.id ?? ""}`;
  const editingExisting = Boolean(model);

  const buildModel = useCallback((): ProviderProfileModel => {
    const id = modelId.trim();
    if (!id) {
      throw new Error("Model ID is required.");
    }
    const normalizedLabel = label.trim() || id;

    let contextWindowMaxTokens: number | undefined;
    if (contextWindow.trim()) {
      const parsed = Number(contextWindow.trim());
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(
          "Context window must be a positive whole number of tokens."
        );
      }
      contextWindowMaxTokens = parsed;
    }

    const thinkingOptions = parseOptionalJson(thinkingOptionsJson, "array");
    const metadata = parseOptionalJson(metadataJson, "object");
    const defaultThinking = defaultThinkingOptionId.trim() || undefined;

    const candidate = {
      id,
      label: normalizedLabel,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(parseAliases(aliases) ? { aliases: parseAliases(aliases) } : {}),
      ...(contextWindowMaxTokens !== undefined
        ? { contextWindowMaxTokens }
        : {}),
      ...(isDefault !== undefined ? { isDefault } : {}),
      ...(isSelectable !== undefined ? { isSelectable } : {}),
      ...(thinkingOptions !== undefined ? { thinkingOptions } : {}),
      ...(defaultThinking ? { defaultThinkingOptionId: defaultThinking } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };

    const parsed = ProviderProfileModelSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw new Error(
        `${path}${issue?.message ?? "Invalid model configuration."}`
      );
    }

    if (
      parsed.data.defaultThinkingOptionId &&
      parsed.data.thinkingOptions?.length &&
      !parsed.data.thinkingOptions.some(
        (option) => option.id === parsed.data.defaultThinkingOptionId
      )
    ) {
      throw new Error(
        "Default thinking option must match one of the configured thinking option IDs."
      );
    }

    return parsed.data;
  }, [
    aliases,
    contextWindow,
    defaultThinkingOptionId,
    description,
    isDefault,
    isSelectable,
    label,
    metadataJson,
    modelId,
    thinkingOptionsJson,
  ]);

  const handleSave = useCallback(() => {
    if (saving) return;
    setError(null);

    let nextModel: ProviderProfileModel;
    try {
      nextModel = buildModel();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid model configuration."
      );
      return;
    }

    const duplicate = additionalModels.some(
      (entry) => entry.id === nextModel.id && entry.id !== originalModelId
    );
    if (duplicate) {
      setError(
        `A custom model or override with ID “${nextModel.id}” already exists.`
      );
      return;
    }

    const hasOriginalOverride =
      Boolean(originalModelId) &&
      additionalModels.some((entry) => entry.id === originalModelId);
    const nextAdditionalModels = hasOriginalOverride
      ? additionalModels.map((entry) =>
          entry.id === originalModelId ? nextModel : entry
        )
      : [...additionalModels, nextModel];

    setSaving(true);
    void patchConfig({
      providers: {
        [provider]: {
          additionalModels: nextAdditionalModels,
        },
      },
    })
      .then(() => refresh([provider]))
      .then(() => onClose())
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : t("settings.providers.models.failedToSave")
        );
      })
      .finally(() => setSaving(false));
  }, [
    additionalModels,
    buildModel,
    onClose,
    originalModelId,
    patchConfig,
    provider,
    refresh,
    saving,
    t,
  ]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: editingExisting ? "Edit model override" : "Add / override model",
    }),
    [editingExisting]
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={620}
      snapPoints={EDITOR_SNAP_POINTS}
      testID="provider-model-editor-sheet"
    >
      <View style={editorStyles.form}>
        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>
            {t("settings.providers.models.modelId")}
          </Text>
          <AdaptiveTextInput
            initialValue={modelId}
            resetKey={`${resetKey}:id`}
            onChangeText={setModelId}
            editable={!editingExisting}
            placeholder={t("settings.providers.models.modelIdPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              editingExisting && editorStyles.readOnly,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
          <Text style={editorStyles.hint}>
            Use an existing discovered ID to override its metadata, or enter a
            new model ID.
          </Text>
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Display label</Text>
          <AdaptiveTextInput
            initialValue={label}
            resetKey={`${resetKey}:label`}
            onChangeText={setLabel}
            placeholder="Defaults to model ID"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              editorStyles.input,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Description</Text>
          <AdaptiveTextInput
            initialValue={description}
            resetKey={`${resetKey}:description`}
            onChangeText={setDescription}
            placeholder="Optional"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              editorStyles.input,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Context window (tokens)</Text>
          <AdaptiveTextInput
            initialValue={contextWindow}
            resetKey={`${resetKey}:context`}
            onChangeText={setContextWindow}
            placeholder="e.g. 500000"
            placeholderTextColor={theme.colors.foregroundMuted}
            keyboardType="number-pad"
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
          <Text style={editorStyles.hint}>
            For Codex-derived providers this explicit value is also forwarded as
            model_context_window.
          </Text>
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Aliases</Text>
          <AdaptiveTextInput
            initialValue={aliases}
            resetKey={`${resetKey}:aliases`}
            onChangeText={setAliases}
            placeholder="Comma or newline separated"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Default model</Text>
          <OptionalBooleanControl value={isDefault} onChange={setIsDefault} />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Selectable</Text>
          <OptionalBooleanControl
            value={isSelectable}
            onChange={setIsSelectable}
          />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Default thinking option ID</Text>
          <AdaptiveTextInput
            initialValue={defaultThinkingOptionId}
            resetKey={`${resetKey}:default-thinking`}
            onChangeText={setDefaultThinkingOptionId}
            placeholder="e.g. high"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Thinking options (JSON)</Text>
          <AdaptiveTextInput
            initialValue={thinkingOptionsJson}
            resetKey={`${resetKey}:thinking-options`}
            onChangeText={setThinkingOptionsJson}
            multiline
            numberOfLines={8}
            placeholder={
              '[{"id":"low","label":"Low"},{"id":"high","label":"High","isDefault":true}]'
            }
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              editorStyles.codeInput,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
          <Text style={editorStyles.hint}>
            Supports id, label, description, isDefault, and per-option metadata.
          </Text>
        </View>

        <View style={editorStyles.field}>
          <Text style={editorStyles.label}>Model metadata (JSON)</Text>
          <AdaptiveTextInput
            initialValue={metadataJson}
            resetKey={`${resetKey}:metadata`}
            onChangeText={setMetadataJson}
            multiline
            numberOfLines={6}
            placeholder="{}"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              editorStyles.input,
              editorStyles.codeInput,
              isWeb ? ({ outlineStyle: "none" } as never) : undefined,
            ]}
          />
        </View>

        {error ? <Text style={editorStyles.error}>{error}</Text> : null}

        <View style={editorStyles.actions}>
          <Button
            variant="secondary"
            size="sm"
            onPress={onClose}
            disabled={saving}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const editorStyles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  codeInput: {
    minHeight: 112,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    textAlignVertical: "top",
  },
  readOnly: {
    opacity: 0.65,
  },
  booleanRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

const EDITOR_SNAP_POINTS = ["72%", "94%"];
