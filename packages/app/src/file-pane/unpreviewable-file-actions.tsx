import * as Clipboard from "expo-clipboard";
import { Copy, Download, FolderOpen } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { useToast } from "@/contexts/toast-api-context";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import type { Theme } from "@/styles/theme";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

const iconProps = (theme: Theme) => ({ size: theme.iconSize.sm, color: theme.colors.foreground });
const ThemedDownload = withUnistyles(Download);
const ThemedCopy = withUnistyles(Copy);
const ThemedFolder = withUnistyles(FolderOpen);
const downloadIcon = <ThemedDownload uniProps={iconProps} />;
const copyIcon = <ThemedCopy uniProps={iconProps} />;
const folderIcon = <ThemedFolder uniProps={iconProps} />;

/**
 * What a file Paseo cannot show still offers: download it over the host connection (relay
 * included), copy its path, or, for this computer's own host, show it in the file manager.
 */
export function UnpreviewableFileActions({
  serverId,
  workspaceRoot,
  path,
  absolutePath,
}: {
  serverId: string;
  workspaceRoot: string;
  /** Workspace-relative path. */
  path: string;
  absolutePath: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { workspaceId } = usePaneContext();
  const download = useFileDownload({ serverId, workspaceId, workspaceRoot });
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocalDaemon });
  const fileManager = targets.find((target) => target.kind === "file-manager");

  const handleDownload = useCallback(() => {
    download({ fileName: path.split("/").pop() ?? path, path });
  }, [download, path]);
  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(absolutePath).then(() => toast.copied());
  }, [absolutePath, toast]);
  const handleReveal = useCallback(() => {
    if (!fileManager) return;
    void openDesktopTarget({
      editorId: fileManager.id,
      workspacePath: workspaceRoot,
      filePath: absolutePath,
    }).catch((cause: unknown) =>
      toast.error(
        cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
      ),
    );
  }, [absolutePath, fileManager, t, toast, workspaceRoot]);

  return (
    <View style={styles.actions}>
      <Button
        variant="default"
        leftIcon={downloadIcon}
        onPress={handleDownload}
        testID="file-pane-download"
      >
        {t("workspace.fileActions.download")}
      </Button>
      <Button variant="outline" leftIcon={copyIcon} onPress={handleCopy}>
        {t("workspace.fileActions.copyPath")}
      </Button>
      {fileManager ? (
        <Button variant="outline" leftIcon={folderIcon} onPress={handleReveal}>
          {t("workspace.fileActions.revealIn", { target: fileManager.label })}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
}));
