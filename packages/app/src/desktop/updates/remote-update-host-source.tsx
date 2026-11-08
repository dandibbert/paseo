import { useEffect, useRef } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import {
  checkDesktopAppUpdate,
  installDesktopAppUpdate,
  shouldShowDesktopUpdateSection,
} from "@/desktop/updates/desktop-updates";
import { runDesktopHostUpdateCommand } from "@/desktop/updates/remote-update-host";
import { resolveAppVersion } from "@/utils/app-version";

/**
 * Registers this desktop window with its own daemon so `paseo host update` from another machine
 * can install Paseo Desktop here. Renders nothing.
 */
export function RemoteUpdateHostSource(): null {
  const isDesktopApp = shouldShowDesktopUpdateSection();
  const serverId = useLocalDaemonServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { settings } = useDesktopSettings();
  const releaseChannel = settings.releaseChannel;
  const channelRef = useRef(releaseChannel);
  channelRef.current = releaseChannel;

  useEffect(() => {
    if (!isDesktopApp || !serverId || !client || !isConnected) return;
    if (client.getLastServerInfoMessage()?.features?.installUpdate !== true) return;
    const unsubscribe = client.on("daemon.desktop_host.update.command", (message) => {
      void runDesktopHostUpdateCommand(message.payload, {
        defaultChannel: channelRef.current,
        check: (channel) => checkDesktopAppUpdate({ releaseChannel: channel, intent: "manual" }),
        install: (channel) => installDesktopAppUpdate({ releaseChannel: channel }),
        report: (report) => client.reportDesktopHostUpdate(report),
      }).catch((error: unknown) => console.error("Remote desktop update failed", error));
    });
    void client
      .registerDesktopHost({ releaseChannel, appVersion: resolveAppVersion() })
      .catch((error: unknown) => console.error("Desktop host registration failed", error));
    return unsubscribe;
  }, [client, isConnected, isDesktopApp, releaseChannel, serverId]);

  return null;
}
