import { useCallback, useMemo, useState } from "react";
import { useMutation, useIsMutating } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import type {
  ProviderCliUpdatePlan,
  ProviderCliUpdateResult,
} from "@getpaseo/protocol/provider-cli-update";

interface Props {
  provider: string;
  serverId: string;
}

export function ProviderCliUpdate({ provider, serverId }: Props) {
  const { t } = useTranslation();
  // COMPAT(providerCliUpdate): added after v0.13.2, remove after 2027-04-27 once the host floor supports CLI updates.
  const supported = useHostFeature(serverId, "providerCliUpdate");
  const [open, setOpen] = useState(false);
  const pending = useIsMutating({ mutationKey: ["provider-cli-update", serverId, provider] }) > 0;
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => {
    if (!pending) setOpen(false);
  }, [pending]);
  const header = useMemo(() => ({ title: t("settings.providers.cliUpdate.title") }), [t]);
  return (
    <View style={styles.section}>
      <Button variant="secondary" size="sm" onPress={handleOpen} testID="provider-cli-update-open">
        {t("settings.providers.cliUpdate.title")}
      </Button>
      {open ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="provider-cli-update-sheet"
        >
          {supported ? (
            <CliUpdateBody provider={provider} serverId={serverId} />
          ) : (
            <Alert variant="info" description={t("settings.providers.cliUpdate.hostUnsupported")} />
          )}
        </AdaptiveModalSheet>
      ) : null}
    </View>
  );
}

function CliUpdateBody({ provider, serverId }: Props) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryKey = ["provider-cli-update", serverId, provider];
  const inspection = useFetchQuery({
    queryKey,
    enabled: connected,
    dataShape: "value",
    staleTimeMs: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.inspectProviderCliUpdate(provider);
    },
  });
  const update = useMutation({
    mutationKey: queryKey,
    mutationFn: async (plan: ProviderCliUpdatePlan) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.updateProviderCli(provider, plan.token);
      return result;
    },
  });
  const result = update.data;
  const pending = update.isPending;

  const confirmUpdate = useCallback(
    async (plan: ProviderCliUpdatePlan) => {
      const confirmed = await confirmDialog({
        title: t("settings.providers.cliUpdate.confirmTitle"),
        message: t("settings.providers.cliUpdate.confirmMessage", {
          host: plan.hostname,
          binary: plan.binaryPath,
          command: plan.command.map((argument) => JSON.stringify(argument)).join(" "),
        }),
        confirmLabel: t("settings.providers.cliUpdate.update"),
        cancelLabel: t("common.cancel"),
      });
      if (confirmed) update.mutate(plan);
    },
    [t, update],
  );

  const checkAgain = useCallback(() => {
    update.reset();
    void inspection.refetch();
  }, [update, inspection]);
  const handleUpdate = useCallback(() => {
    if (inspection.data?.status === "available") void confirmUpdate(inspection.data.plan);
  }, [inspection.data, confirmUpdate]);

  const plan = inspection.data?.status === "available" ? inspection.data.plan : null;
  const showPlan = plan && !result && !update.isError;
  return (
    <View style={styles.body}>
      <Text style={styles.hint}>{t("settings.providers.cliUpdate.description")}</Text>
      {!connected ? (
        <Alert variant="error" description={t("workspace.terminal.hostDisconnected")} />
      ) : null}
      {inspection.isFetching && !pending ? (
        <Text style={styles.hint}>{t("settings.providers.cliUpdate.checking")}</Text>
      ) : null}
      {inspection.isError ? <Alert variant="error" description={inspection.error.message} /> : null}
      {inspection.data?.status === "unavailable" ? (
        <Alert variant="info" description={inspection.data.reason} />
      ) : null}
      {showPlan ? (
        <UpdatePlan
          plan={plan}
          onUpdate={handleUpdate}
          disabled={!connected || pending || inspection.isFetching}
          pending={pending}
        />
      ) : null}
      {pending ? (
        <Alert variant="info" description={t("settings.providers.cliUpdate.updatingHint")} />
      ) : null}
      {update.isError ? (
        <Alert
          variant="error"
          description={`${update.error.message}\n${t("settings.providers.cliUpdate.connectionWarning")}`}
          testID="provider-cli-update-error"
        />
      ) : null}
      {result ? <UpdateResult result={result} /> : null}
      <Button
        variant="secondary"
        size="sm"
        onPress={checkAgain}
        disabled={!connected || pending || inspection.isFetching}
      >
        {t("settings.providers.cliUpdate.check")}
      </Button>
    </View>
  );
}

interface UpdatePlanProps {
  plan: ProviderCliUpdatePlan;
  onUpdate: () => void;
  disabled: boolean;
  pending: boolean;
}

function UpdatePlan({ plan, onUpdate, disabled, pending }: UpdatePlanProps) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.label}>
        {t("settings.providers.cliUpdate.host", { host: plan.hostname })}
      </Text>
      <Text style={styles.hint} selectable>
        {plan.binaryPath}
      </Text>
      <Text style={styles.label}>
        {t("settings.providers.cliUpdate.current", { version: plan.currentVersion })}
      </Text>
      <Text style={styles.label}>
        {plan.latestVersion === "unknown"
          ? t("settings.providers.cliUpdate.nativeTarget")
          : t("settings.providers.cliUpdate.latest", { version: plan.latestVersion })}
      </Text>
      <ScrollableCodeSurface maxHeight={160}>
        {plan.command.map((argument) => JSON.stringify(argument)).join(" ")}
      </ScrollableCodeSurface>
      {plan.updatedCommand ? (
        <View style={styles.body}>
          <Text style={styles.hint}>{t("settings.providers.cliUpdate.updatedCommand")}</Text>
          <ScrollableCodeSurface maxHeight={160}>
            {plan.updatedCommand.map((argument) => JSON.stringify(argument)).join(" ")}
          </ScrollableCodeSurface>
        </View>
      ) : null}
      <Button
        onPress={onUpdate}
        disabled={disabled}
        loading={pending}
        testID="provider-cli-update-confirm"
      >
        {pending
          ? t("settings.providers.cliUpdate.updating")
          : t("settings.providers.cliUpdate.update")}
      </Button>
    </>
  );
}

function UpdateResult({ result }: { result: ProviderCliUpdateResult }) {
  const { t } = useTranslation();
  return (
    <>
      <Alert
        variant={result.success ? "success" : "error"}
        description={
          result.success
            ? t("settings.providers.cliUpdate.success", { version: result.version })
            : result.error
        }
        testID={result.success ? "provider-cli-update-success" : "provider-cli-update-error"}
      />
      {result.output ? (
        <ScrollableCodeSurface maxHeight={240}>{result.output}</ScrollableCodeSurface>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { marginBottom: theme.spacing[4], alignItems: "flex-start" },
  body: { gap: theme.spacing[3] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
