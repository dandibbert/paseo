import { createHostClient } from "@getpaseo/client/node";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import type { RemoteUpdateHostClient } from "../features/remote-update-host.js";

/** The daemon connection the main process answers remote `paseo host update` requests on. */
export function createRemoteUpdateClient(input: {
  home: string;
  listen: string;
  appVersion: string;
}): RemoteUpdateHostClient {
  const client = createHostClient(input.listen, {
    clientId: "paseo-desktop-update-host",
    clientType: "cli",
    appVersion: input.appVersion,
    localCredential: () => readLocalCredentialForTarget(input.home, input.listen) ?? undefined,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
  });
  return {
    connect: () => client.connect(),
    close: () => client.close(),
    getLastServerInfoMessage: () => client.getLastServerInfoMessage(),
    subscribeConnectionStatus: (listener) => client.subscribeConnectionStatus(listener),
    on: (type, handler) => client.on(type, (message) => handler(message)),
    registerDesktopHost: (registration) => client.registerDesktopHost(registration),
    reportDesktopHostUpdate: (report) => client.reportDesktopHostUpdate(report),
  };
}
