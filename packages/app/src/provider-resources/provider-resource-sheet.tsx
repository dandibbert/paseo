import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProviderPlugin,
  ProviderSkill,
  ProviderSkillVisibility,
} from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";

export type ProviderResourceKind = "skills" | "plugins";
type ProviderPluginAction = "install" | "enable" | "disable" | "update" | "uninstall";
type ProviderSkillToggle = (
  skill: ProviderSkill,
  enabled: boolean,
  visibility?: ProviderSkillVisibility,
) => void | Promise<void>;
type ProviderPluginActionHandler = (
  plugin: ProviderPlugin,
  action: ProviderPluginAction,
) => void | Promise<void>;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const CLAUDE_SKILL_VISIBILITY_ORDER: readonly ProviderSkillVisibility[] = [
  "on",
  "name-only",
  "user-invocable-only",
  "off",
];

function nextSkillVisibility(
  current: ProviderSkillVisibility | undefined,
): ProviderSkillVisibility {
  const index = CLAUDE_SKILL_VISIBILITY_ORDER.indexOf(current ?? "on");
  return CLAUDE_SKILL_VISIBILITY_ORDER[(index + 1) % CLAUDE_SKILL_VISIBILITY_ORDER.length]!;
}

function skillVisibilityLabel(visibility: ProviderSkillVisibility | undefined): string {
  switch (visibility ?? "on") {
    case "name-only":
      return "name-only";
    case "user-invocable-only":
      return "user-only";
    case "off":
      return "off";
    default:
      return "on";
  }
}

function pluginStatusLabel(plugin: ProviderPlugin): string {
  if (!plugin.installed) return "未安装";
  return plugin.enabled ? "已启用" : "已禁用";
}

function ProviderSkillAction({
  skill,
  working,
  onToggle,
  onOpenPlugins,
}: {
  skill: ProviderSkill;
  working: boolean;
  onToggle: ProviderSkillToggle;
  onOpenPlugins?: () => void;
}): ReactNode {
  const handleVisibilityPress = useCallback(() => {
    const visibility = nextSkillVisibility(skill.visibility);
    void onToggle(skill, visibility !== "off", visibility);
  }, [onToggle, skill]);
  const handleToggle = useCallback(
    (value: boolean) => {
      void onToggle(skill, value);
    },
    [onToggle, skill],
  );

  if (skill.visibilityCycleSupported) {
    return (
      <Button size="sm" variant="secondary" loading={working} onPress={handleVisibilityPress}>
        {skillVisibilityLabel(skill.visibility)}
      </Button>
    );
  }
  if (skill.toggleSupported) {
    return (
      <Switch
        value={skill.enabled}
        disabled={working}
        onValueChange={handleToggle}
        accessibilityLabel={`${skill.enabled ? "禁用" : "启用"} ${skill.name}`}
      />
    );
  }
  if (skill.pluginId) {
    return (
      <Button size="sm" variant="secondary" onPress={onOpenPlugins} disabled={!onOpenPlugins}>
        管理 Plugin
      </Button>
    );
  }
  return <Text style={styles.meta}>由来源管理</Text>;
}

function ProviderSkillRow({
  skill,
  withBorder,
  working,
  onToggle,
  onOpenPlugins,
}: {
  skill: ProviderSkill;
  withBorder: boolean;
  working: boolean;
  onToggle: ProviderSkillToggle;
  onOpenPlugins?: () => void;
}) {
  return (
    <View style={[settingsStyles.row, withBorder ? settingsStyles.rowBorder : null]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>/{skill.name}</Text>
        {skill.description ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {skill.description}
          </Text>
        ) : null}
        <Text style={styles.meta} numberOfLines={1}>
          {[skill.scope, skill.source, skill.pluginId ? `plugin: ${skill.pluginId}` : null]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <ProviderSkillAction
        skill={skill}
        working={working}
        onToggle={onToggle}
        onOpenPlugins={onOpenPlugins}
      />
    </View>
  );
}

function ProviderPluginRow({
  plugin,
  withBorder,
  working,
  onAction,
}: {
  plugin: ProviderPlugin;
  withBorder: boolean;
  working: boolean;
  onAction: ProviderPluginActionHandler;
}) {
  const handleInstall = useCallback(() => void onAction(plugin, "install"), [onAction, plugin]);
  const handleEnable = useCallback(() => void onAction(plugin, "enable"), [onAction, plugin]);
  const handleDisable = useCallback(() => void onAction(plugin, "disable"), [onAction, plugin]);
  const handleUpdate = useCallback(() => void onAction(plugin, "update"), [onAction, plugin]);
  const handleUninstall = useCallback(() => void onAction(plugin, "uninstall"), [onAction, plugin]);

  return (
    <View style={[settingsStyles.row, withBorder ? settingsStyles.rowBorder : null]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{plugin.name}</Text>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {plugin.id}
          {plugin.description ? ` · ${plugin.description}` : ""}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[pluginStatusLabel(plugin), plugin.version, plugin.scope, plugin.marketplace]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <View style={styles.actions}>
        {plugin.canInstall ? (
          <Button size="sm" variant="secondary" loading={working} onPress={handleInstall}>
            安装
          </Button>
        ) : null}
        {plugin.canEnable ? (
          <Button size="sm" variant="secondary" loading={working} onPress={handleEnable}>
            启用
          </Button>
        ) : null}
        {plugin.canDisable ? (
          <Button size="sm" variant="secondary" loading={working} onPress={handleDisable}>
            禁用
          </Button>
        ) : null}
        {plugin.canUpdate ? (
          <Button size="sm" variant="secondary" disabled={working} onPress={handleUpdate}>
            更新
          </Button>
        ) : null}
        {plugin.canUninstall ? (
          <Button size="sm" variant="secondary" disabled={working} onPress={handleUninstall}>
            卸载
          </Button>
        ) : null}
      </View>
    </View>
  );
}

interface ProviderResourceSheetProps {
  visible: boolean;
  kind: ProviderResourceKind;
  serverId: string;
  agentId: string;
  provider: string | undefined;
  forceReloadKey: number;
  onClose: () => void;
  onOpenPlugins?: () => void;
}

function providerLabel(provider: string | undefined): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "pi") return "Pi";
  if (provider === "omp") return "OMP";
  return provider?.trim() || "Provider";
}

export function ProviderResourceSheet({
  visible,
  kind,
  serverId,
  agentId,
  provider,
  forceReloadKey,
  onClose,
  onOpenPlugins,
}: ProviderResourceSheetProps) {
  const client = useHostRuntimeClient(serverId);
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const [plugins, setPlugins] = useState<ProviderPlugin[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const label = providerLabel(provider);

  const load = useCallback(
    async (forceReload: boolean) => {
      if (!client || !visible) return;
      setLoading(true);
      setError(null);
      try {
        if (kind === "skills") {
          const result = await client.listProviderSkills(agentId, { forceReload });
          setSupported(result.supported);
          setSkills(result.skills);
          if (result.error) setError(result.error);
        } else {
          const result = await client.listProviderPlugins(agentId, {
            includeAvailable: true,
            forceReload,
          });
          setSupported(result.supported);
          setPlugins(result.plugins);
          if (result.error) setError(result.error);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [agentId, client, kind, visible],
  );

  useEffect(() => {
    if (!visible) return;
    setSearch("");
    void load(forceReloadKey > 0);
  }, [forceReloadKey, load, visible]);

  const handleSkillToggle = useCallback(
    async (skill: ProviderSkill, enabled: boolean, visibility?: ProviderSkillVisibility) => {
      if (!client || !skill.toggleSupported) return;
      setWorkingId(skill.path ?? skill.name);
      setError(null);
      try {
        const result = await client.setProviderSkillEnabled({
          agentId,
          name: skill.name,
          path: skill.path,
          enabled,
          ...(visibility ? { visibility } : {}),
        });
        if (result.error) throw new Error(result.error);
        setSkills(result.skills);
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setWorkingId(null);
      }
    },
    [agentId, client],
  );

  const handlePluginAction = useCallback(
    async (plugin: ProviderPlugin, action: ProviderPluginAction) => {
      if (!client) return;
      if (action === "uninstall") {
        const confirmed = await confirmDialog({
          title: `卸载 ${plugin.name}?`,
          message: `这会通过 ${label} 自己的插件管理机制卸载 ${plugin.id}。`,
          confirmLabel: "卸载",
          destructive: true,
        });
        if (!confirmed) return;
      }
      setWorkingId(plugin.id);
      setError(null);
      try {
        const result = await client.manageProviderPlugin({ agentId, pluginId: plugin.id, action });
        if (result.error) throw new Error(result.error);
        setPlugins(result.plugins);
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      } finally {
        setWorkingId(null);
      }
    },
    [agentId, client, label],
  );

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query),
    );
  }, [search, skills]);

  const filteredPlugins = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return plugins;
    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(query) ||
        plugin.id.toLowerCase().includes(query) ||
        plugin.description.toLowerCase().includes(query),
    );
  }, [plugins, search]);

  const handleRefresh = useCallback(() => {
    void load(true);
  }, [load]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: `${label} ${kind === "skills" ? "Skills" : "Plugins"}`,
      subtitle: (
        <Text style={styles.subtitle}>
          当前 Agent 的 provider 原生{kind === "skills" ? "技能" : "插件"}管理
        </Text>
      ),
      search: {
        onChange: setSearch,
        placeholder: kind === "skills" ? "搜索 skills" : "搜索 plugins",
        resetKey: `${kind}:${forceReloadKey}:${visible}`,
      },
      actions: (
        <Button size="sm" variant="secondary" onPress={handleRefresh} disabled={loading}>
          刷新
        </Button>
      ),
    }),
    [forceReloadKey, handleRefresh, kind, label, loading, visible],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="provider-resource-sheet"
    >
      {loading ? (
        <View style={styles.centerState}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
          <Text style={settingsStyles.rowHint}>正在读取 {label}…</Text>
        </View>
      ) : null}

      {!loading && !supported ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>当前 provider 暂不支持此管理界面</Text>
              <Text style={settingsStyles.rowHint}>
                这里只显示 provider 自己的资源，不会跳到 Paseo 编排 skills / plugins。
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}

      {!loading && supported && kind === "skills" ? (
        <View style={settingsStyles.card} testID="provider-skills-list">
          {filteredSkills.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>没有发现可管理的 skills。</Text>
            </View>
          ) : (
            filteredSkills.map((skill, index) => (
              <ProviderSkillRow
                key={`${skill.path ?? skill.name}:${skill.scope ?? ""}`}
                skill={skill}
                withBorder={index > 0}
                working={workingId === (skill.path ?? skill.name)}
                onToggle={handleSkillToggle}
                onOpenPlugins={onOpenPlugins}
              />
            ))
          )}
        </View>
      ) : null}

      {!loading && supported && kind === "plugins" ? (
        <View style={settingsStyles.card} testID="provider-plugins-list">
          {filteredPlugins.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>没有发现 plugins。</Text>
            </View>
          ) : (
            filteredPlugins.map((plugin, index) => (
              <ProviderPluginRow
                key={plugin.id}
                plugin={plugin}
                withBorder={index > 0}
                working={workingId === plugin.id}
                onAction={handlePluginAction}
              />
            ))
          )}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  centerState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[8],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    maxWidth: 260,
  },
}));
