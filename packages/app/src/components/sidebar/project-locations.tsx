import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuRoot, MenuTrigger, MenuSurface, MenuLabel } from "@/components/ui/menu";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useHosts } from "@/runtime/host-runtime";

/** Source details stay available on touch screens as well as desktop. */
export function SidebarProjectLocations({
  project,
  summary,
}: {
  project: SidebarProjectEntry;
  summary: string;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const label =
    project.hosts.length > 1
      ? t("sidebar.projectSources.hosts", { count: project.hosts.length })
      : summary;
  const explanation =
    project.hosts.length > 1
      ? t("sidebar.projectSources.shared")
      : t("sidebar.projectSources.distinct");
  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        accessibilityLabel={t("sidebar.projectSources.label")}
        testID={`sidebar-project-sources-${project.viewKey}`}
      >
        <Text style={styles.summary} numberOfLines={1}>
          {label}
        </Text>
      </MenuTrigger>
      <MenuSurface width={300} sheetTitle={t("sidebar.projectSources.label")}>
        <MenuLabel>{t("sidebar.projectSources.label")}</MenuLabel>
        <View style={styles.details}>
          <Text style={styles.explanation}>{explanation}</Text>
          {project.hosts.map((host) => (
            <View key={`${host.serverId}:${host.projectId}`} style={styles.location}>
              <Text style={styles.host}>
                {hosts.find((item) => item.serverId === host.serverId)?.label || host.serverId}
              </Text>
              <Text style={styles.summary} selectable>
                {host.iconWorkingDir}
              </Text>
            </View>
          ))}
        </View>
      </MenuSurface>
    </MenuRoot>
  );
}
const styles = StyleSheet.create((theme) => ({
  summary: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  details: { padding: theme.spacing[3], gap: theme.spacing[3] },
  explanation: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  location: { gap: theme.spacing[1] },
  host: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
