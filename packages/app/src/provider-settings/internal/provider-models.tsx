import { EyeOff, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { ProviderModelEditorSheet } from "@/components/provider-model-editor-sheet";
import {
  createProviderModelMutation,
  type ProviderModelChange,
} from "@/components/provider-model-settings";
import { SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import {
  resolveProviderDiscoveredModels,
  resolveProviderManualModels,
  type ProviderDiscoveredModelsCache,
  type ProviderManualModel,
} from "./discovered-models";
import type { ProviderEntry } from "./provider-config";

const ThemedTrash = withUnistyles(Trash2);
const ThemedPencil = withUnistyles(Pencil);
const ThemedEyeOff = withUnistyles(EyeOff);
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<typeof entry.score> } => entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

/**
 * A provider's models: search, the ones it reports, and the ones added by hand. The caller decides
 * whether it appears and whether the provider's own models are listed.
 */
export function ProviderModels({
  serverId,
  entry,
  discovered,
}: {
  serverId: string;
  entry: ProviderEntry;
  /** List the models the provider reports, with search. Only a running provider reports them. */
  discovered: boolean;
}) {
  const { t } = useTranslation();
  const provider = entry.provider;
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [query, setQuery] = useState("");
  const { refresh } = useProvidersSnapshot(serverId);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<
    ProviderProfileModel | AgentModelDefinition | null
  >(null);
  const [editingOriginalModelId, setEditingOriginalModelId] = useState<string | null>(null);
  const [modelMutation] = useState(createProviderModelMutation);
  const mutationState = useSyncExternalStore(modelMutation.subscribe, modelMutation.getState);
  const savingModelId = mutationState.status === "saving" ? mutationState.modelId : null;
  const mutationDisabled = savingModelId !== null || config === null;

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const loading = entry.status === "loading";
  // A refresh briefly empties the snapshot's models; keep the last list on screen meanwhile.
  const discoveredCacheRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const { models: discoveredModels, cache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    providerConfig: config?.providers?.[provider],
    currentModels: entry.models,
    additionalModels,
    providerSnapshotRefreshing: loading,
    previousCache: discoveredCacheRef.current,
  });
  discoveredCacheRef.current = cache;

  // Search shows only beside the provider's own models; a query typed then must not hide custom ones.
  const q = discovered ? query.trim() : "";
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );
  const filteredCustom = useMemo(
    () =>
      rankModels(resolveProviderManualModels(additionalModels, entry.models), q, ({ model }) => [
        model.label,
        model.id,
      ]),
    [additionalModels, entry.models, q],
  );

  const openEditor = useCallback(
    (model: ProviderProfileModel | AgentModelDefinition | null) => {
      modelMutation.clearError();
      setEditingModel(model);
      setEditingOriginalModelId(model?.id ?? null);
      setEditorOpen(true);
    },
    [modelMutation],
  );
  const handleOpenAddSheet = useCallback(() => openEditor(null), [openEditor]);
  const handleCloseEditor = useCallback(() => setEditorOpen(false), []);
  // A provider's own model is edited through a custom entry with the same id, which overrides it.
  const handleEditDiscovered = useCallback(
    (model: AgentModelDefinition) =>
      openEditor(additionalModels.find((custom) => custom.id === model.id) ?? model),
    [additionalModels, openEditor],
  );
  const applyModelChange = useCallback(
    (change: ProviderModelChange) => {
      if (!config) return;
      void modelMutation.run({
        provider,
        additionalModels,
        change,
        patchConfig,
        refresh,
        fallbackError: t("settings.providers.models.failedToSave"),
        disconnectedError: t("workspace.terminal.hostDisconnected"),
      });
    },
    [additionalModels, config, modelMutation, patchConfig, provider, refresh, t],
  );
  const handleDeleteCustom = useCallback(
    (modelId: string) => applyModelChange({ type: "remove", modelId }),
    [applyModelChange],
  );
  const handleHideDiscovered = useCallback(
    (model: AgentModelDefinition) =>
      applyModelChange({
        type: "save",
        model: { id: model.id, label: model.label, isSelectable: false },
        originalModelId: model.id,
      }),
    [applyModelChange],
  );

  const customTrailing = useMemo(
    () => (
      <View style={styles.headerTrailing}>
        {additionalModels.length > 0 ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{additionalModels.length}</Text>
        ) : null}
        <Button
          variant="ghost"
          leftIcon={Plus}
          onPress={handleOpenAddSheet}
          disabled={mutationDisabled}
          accessibilityLabel={t("settings.providers.models.addModel")}
          testID="provider-add-model"
        />
      </View>
    ),
    [additionalModels.length, handleOpenAddSheet, mutationDisabled, t],
  );

  const discoveredTrailing = useMemo(
    () =>
      discoveredModels.length > 0 ? (
        <Text style={settingsStyles.sectionHeaderTitle}>{discoveredModels.length}</Text>
      ) : null,
    [discoveredModels.length],
  );

  let discoveredBody: React.ReactNode;
  if (discoveredModels.length === 0) {
    discoveredBody = (
      <MutedRow>
        {loading
          ? t("settings.providers.models.loading")
          : t("settings.providers.models.noneDetected")}
      </MutedRow>
    );
  } else if (filteredDiscovered.length === 0) {
    discoveredBody = <MutedRow>{t("settings.providers.models.noSearchMatches")}</MutedRow>;
  } else {
    discoveredBody = filteredDiscovered.map((model, index) => (
      <DiscoveredModelRow
        key={model.id}
        model={model}
        first={index === 0}
        disabled={mutationDisabled}
        saving={savingModelId === model.id}
        onEdit={handleEditDiscovered}
        onHide={handleHideDiscovered}
      />
    ));
  }

  let customBody: React.ReactNode;
  if (additionalModels.length === 0) {
    customBody = <MutedRow>{t("settings.providers.models.noCustom")}</MutedRow>;
  } else if (filteredCustom.length === 0) {
    customBody = <MutedRow>{t("settings.providers.models.noSearchMatches")}</MutedRow>;
  } else {
    customBody = filteredCustom.map(({ model, status }, index) => (
      <CustomModelRow
        key={model.id}
        model={model}
        status={status}
        first={index === 0}
        disabled={mutationDisabled}
        deleting={savingModelId === model.id}
        onEdit={openEditor}
        onDelete={handleDeleteCustom}
      />
    ));
  }

  return (
    <View testID="provider-models">
      {discovered ? (
        <>
          <View style={styles.searchRail}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t("settings.providers.models.searchPlaceholder")}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              testID="provider-settings-search"
            />
          </View>
          <SettingsSection
            title={t("settings.providers.models.discovered")}
            trailing={discoveredTrailing}
          >
            <View style={settingsStyles.card}>{discoveredBody}</View>
          </SettingsSection>
        </>
      ) : null}
      <SettingsSection title={t("settings.providers.models.custom")} trailing={customTrailing}>
        <View style={settingsStyles.card}>{customBody}</View>
      </SettingsSection>
      {mutationState.status === "error" && !editorOpen ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {mutationState.message}
        </Text>
      ) : null}
      <ProviderModelEditorSheet
        provider={provider}
        serverId={serverId}
        visible={editorOpen}
        model={editingModel}
        originalModelId={editingOriginalModelId}
        mutation={modelMutation}
        onClose={handleCloseEditor}
        refresh={refresh}
      />
    </View>
  );
}

function MutedRow({ children }: { children: string }) {
  return (
    <View style={styles.modelRow}>
      <Text style={settingsStyles.sectionHeaderTitle}>{children}</Text>
    </View>
  );
}

function DiscoveredModelRow({
  model,
  first,
  disabled,
  saving,
  onEdit,
  onHide,
}: {
  model: AgentModelDefinition;
  first: boolean;
  disabled: boolean;
  saving: boolean;
  onEdit: (model: AgentModelDefinition) => void;
  onHide: (model: AgentModelDefinition) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const handleEdit = useCallback(() => onEdit(model), [model, onEdit]);
  const handleHide = useCallback(() => onHide(model), [model, onHide]);
  return (
    <View style={[styles.modelRow, !first && settingsStyles.rowBorder]}>
      <Text style={[styles.modelTitle, styles.customModelText]} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={[styles.monoHint, styles.customModelText]}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      {model.description ? (
        <Text style={[styles.descriptionInline, styles.customModelText]} numberOfLines={1}>
          {model.description}
        </Text>
      ) : (
        <View style={styles.modelRowFiller} />
      )}
      <ToolbarButton
        label={t("settings.providers.models.editModel", { id: model.id })}
        onPress={handleEdit}
        disabled={disabled}
        compact={compact}
      >
        <ThemedPencil size={paneContentToolbarIconSize(compact)} uniProps={mutedColorMapping} />
      </ToolbarButton>
      <ToolbarButton
        label={t("settings.providers.models.hideModel", { id: model.id })}
        onPress={handleHide}
        disabled={disabled || saving}
        compact={compact}
      >
        <ThemedEyeOff size={paneContentToolbarIconSize(compact)} uniProps={mutedColorMapping} />
      </ToolbarButton>
    </View>
  );
}

function CustomModelRow({
  model,
  status,
  first,
  disabled,
  deleting,
  onEdit,
  onDelete,
}: {
  model: ProviderProfileModel;
  status: ProviderManualModel["status"];
  first: boolean;
  disabled: boolean;
  deleting: boolean;
  onEdit: (model: ProviderProfileModel) => void;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const handleEdit = useCallback(() => onEdit(model), [model, onEdit]);
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);

  return (
    <View style={[styles.modelRow, !first && settingsStyles.rowBorder]}>
      <Text style={[styles.modelTitle, styles.customModelText]} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={[styles.monoHint, styles.customModelText]}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      {status === "available" ? null : (
        <Text style={styles.statusText} numberOfLines={1}>
          {status === "disabled"
            ? t("settings.providers.statuses.disabled")
            : t("providerSelection.unavailable")}
        </Text>
      )}
      <View style={styles.modelRowFiller} />
      <ToolbarButton
        label={t("settings.providers.models.editModel", { id: model.id })}
        onPress={handleEdit}
        disabled={disabled}
        compact={compact}
      >
        <ThemedPencil size={paneContentToolbarIconSize(compact)} uniProps={mutedColorMapping} />
      </ToolbarButton>
      <ToolbarButton
        label={t("settings.providers.models.removeModel", { id: model.id })}
        onPress={handleDelete}
        disabled={disabled || deleting}
        compact={compact}
      >
        <ThemedTrash
          size={paneContentToolbarIconSize(compact)}
          uniProps={destructiveColorMapping}
        />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  searchRail: {
    flexDirection: "row",
    marginBottom: theme.spacing[3],
  },
  headerTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 0,
  },
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  descriptionInline: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  customModelText: {
    flexShrink: 1,
    minWidth: 0,
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    marginTop: theme.spacing[2],
  },
}));
