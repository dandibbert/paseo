import { useMutation } from "@tanstack/react-query";
import { ArrowUpToLine } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { describeInstallUpdate } from "./host-install-update";

const ThemedUpdate = withUnistyles(ArrowUpToLine);
const iconProps = (theme: Theme) => ({ size: theme.iconSize.sm, color: theme.colors.foreground });
const updateIcon = <ThemedUpdate uniProps={iconProps} />;

type Request = { action: "check" } | { action: "install"; force: boolean };

/**
 * Checks for and installs a Paseo update on a connected host: Paseo Desktop installs its app
 * update, a headless Linux release its latest release, an npm install its package.
 */
export function HostInstallUpdateCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const mutation = useMutation({
    mutationFn: async (request: Request) => {
      if (!client) throw new Error(t("settings.host.daemon.update.unavailableMessage"));
      return client.installUpdate(
        request.action === "check" ? { checkOnly: true } : { force: request.force },
      );
    },
  });

  const check = useCallback(() => mutation.mutate({ action: "check" }), [mutation]);
  const install = useCallback(
    (force: boolean, version: string) => {
      void confirmDialog({
        title: t("settings.host.daemon.installUpdate.confirmTitle", { name: host.label }),
        message: t(
          force
            ? "settings.host.daemon.installUpdate.forceConfirmMessage"
            : "settings.host.daemon.installUpdate.confirmMessage",
          { name: host.label, version },
        ),
        confirmLabel: t("settings.host.daemon.installUpdate.install"),
        cancelLabel: t("common.actions.cancel"),
        destructive: force,
      }).then((confirmed) => {
        if (confirmed) mutation.mutate({ action: "install", force });
        return undefined;
      });
    },
    [host.label, mutation, t],
  );

  const outcome = mutation.data ? describeInstallUpdate(mutation.data) : null;
  const targetVersion = mutation.data?.targetVersion ?? "";
  const handleInstall = useCallback(
    () => install(outcome?.next === "force", targetVersion),
    [install, outcome?.next, targetVersion],
  );

  const busy = mutation.isPending;
  const busyLabel =
    mutation.variables?.action === "install"
      ? t("settings.host.daemon.installUpdate.installing")
      : t("settings.host.daemon.installUpdate.checking");

  return (
    <View style={settingsStyles.card} testID="host-install-update-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.daemon.installUpdate.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.daemon.installUpdate.hint")}</Text>
        </View>
        {outcome?.next ? (
          <Button
            variant={outcome.next === "force" ? "destructive" : "default"}
            leftIcon={updateIcon}
            onPress={handleInstall}
            disabled={busy || !isConnected}
            loading={busy}
            testID="host-install-update-install"
          >
            {busy
              ? busyLabel
              : t(
                  outcome.next === "force"
                    ? "settings.host.daemon.installUpdate.forceInstall"
                    : "settings.host.daemon.installUpdate.install",
                )}
          </Button>
        ) : (
          <Button
            variant="outline"
            leftIcon={updateIcon}
            onPress={check}
            disabled={busy || !isConnected || !client}
            loading={busy}
            testID="host-install-update-check"
          >
            {busy ? busyLabel : t("settings.host.daemon.installUpdate.check")}
          </Button>
        )}
      </View>
      {outcome ? (
        <View style={styles.alert}>
          <InlineAlert
            size="sm"
            variant={outcome.tone}
            title={t(`settings.host.daemon.installUpdate.${outcome.messageKey}`, outcome.params)}
            testID="host-install-update-result"
          />
        </View>
      ) : null}
      {mutation.error ? (
        <View style={styles.alert}>
          <InlineAlert
            size="sm"
            variant="error"
            title={t("settings.host.daemon.installUpdate.failed", {
              error:
                mutation.error instanceof Error ? mutation.error.message : String(mutation.error),
            })}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Whether the host can take install updates from this app; older hosts keep the npm card. */
// COMPAT(installUpdate): added in v0.15.2-personal, remove gate after 2027-05-01.
export function useHostSupportsInstallUpdate(serverId: string): boolean {
  return useHostFeature(serverId, "installUpdate");
}

const styles = StyleSheet.create((theme) => ({
  alert: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[4],
  },
}));
