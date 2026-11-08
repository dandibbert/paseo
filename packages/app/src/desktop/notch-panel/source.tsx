import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, isElectronRuntimeMac } from "@/desktop/host";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  buildNotchPanelState,
  permissionResponse,
  type NotchPanelHost,
  type NotchPanelLabels,
  type NotchPanelText,
} from "./model";

const PUBLISH_DELAY_MS = 150;

interface RespondAction {
  serverId?: unknown;
  agentId?: unknown;
  requestId?: unknown;
  buttonKey?: unknown;
}

/** Answers a button pressed in the notch panel, against the permission as it is now. */
function respondFromPanel(action: RespondAction): void {
  const { serverId, agentId, requestId, buttonKey } = action;
  if (
    typeof serverId !== "string" ||
    typeof agentId !== "string" ||
    typeof requestId !== "string" ||
    typeof buttonKey !== "string"
  ) {
    return;
  }
  const agent = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
  const request = agent?.pendingPermissions.find((candidate) => candidate.id === requestId);
  const response = request ? permissionResponse(request, buttonKey) : null;
  const client = getHostRuntimeStore().getClient(serverId);
  if (!response || !client) return;
  void client.respondToPermission(agentId, requestId, response).catch((error: unknown) => {
    console.error("[NotchPanel] Failed to answer a permission", error);
  });
}

function NotchPanelPublisher(): null {
  const { t } = useTranslation();
  const { settings } = useDesktopSettings();
  const enabled = settings.notifications.notchPanel;
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);

  const labels = useMemo<NotchPanelLabels>(
    () => ({
      needsYou: t("notchPanel.needsYou"),
      running: t("notchPanel.running"),
      finished: t("notchPanel.finished"),
      recent: t("notchPanel.recent"),
      columnEmpty: t("notchPanel.columnEmpty"),
      empty: t("notchPanel.empty"),
      offline: t("notchPanel.offline"),
      open: t("notchPanel.open"),
      states: {
        permission: t("notchPanel.states.permission"),
        question: t("notchPanel.states.question"),
        error: t("notchPanel.states.error"),
        running: t("notchPanel.running"),
        finished: t("notchPanel.finished"),
        recent: t("notchPanel.recent"),
      },
    }),
    [t],
  );
  const text = useMemo<NotchPanelText>(
    () => ({
      untitled: t("notchPanel.untitled"),
      allow: t("notchPanel.allow"),
      deny: t("notchPanel.deny"),
      answer: t("notchPanel.answer"),
      translateAction: (label) =>
        t(`notchPanel.actions.${label.toLowerCase()}`, { defaultValue: label }),
    }),
    [t],
  );

  const inputs = useRef({ enabled, hosts, statuses, labels, text });
  inputs.current = { enabled, hosts, statuses, labels, text };

  useEffect(() => {
    const publish = getDesktopHost()?.notchPanel?.publish;
    if (typeof publish !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const send = () => {
      timer = undefined;
      const current = inputs.current;
      const sessions = useSessionStore.getState().sessions;
      const panelHosts: NotchPanelHost[] = current.hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label ?? host.serverId,
        online: current.statuses.get(host.serverId) === "online",
        agents: sessions[host.serverId]?.agents.values() ?? [],
      }));
      const state = buildNotchPanelState({
        enabled: current.enabled,
        hosts: panelHosts,
        labels: current.labels,
        text: current.text,
      });
      const serialized = JSON.stringify(state);
      if (serialized === last) return;
      last = serialized;
      void publish(state).catch(() => undefined);
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(send, PUBLISH_DELAY_MS);
    };
    schedule();
    const unsubscribe = useSessionStore.subscribe(schedule);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [enabled, hosts, statuses, labels, text]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenToDesktopEvent<RespondAction>("notch-panel-respond", respondFromPanel)
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}

/** Feeds the macOS notch panel from this window. Renders nothing; inert outside the Mac app. */
export function NotchPanelSource(): React.ReactElement | null {
  if (!isElectronRuntimeMac() || typeof getDesktopHost()?.notchPanel?.publish !== "function") {
    return null;
  }
  return <NotchPanelPublisher />;
}
