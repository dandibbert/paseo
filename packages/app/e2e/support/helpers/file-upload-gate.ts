import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

function isFileUploadResponse(message: WebSocketMessage): boolean {
  if (typeof message !== "string") return false;
  try {
    const envelope = JSON.parse(message) as { type?: unknown; message?: { type?: unknown } };
    return (envelope.message ?? envelope).type === "file.upload.response";
  } catch {
    return false;
  }
}

function subscribedTerminalId(message: WebSocketMessage): string | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as {
      type?: string;
      payload?: { terminalId?: string; error?: string | null };
      message?: {
        type?: string;
        payload?: { terminalId?: string; error?: string | null };
      };
    };
    const response = envelope.message ?? envelope;
    if (response.type !== "subscribe_terminal_response" || response.payload?.error !== null)
      return null;
    return response.payload.terminalId ?? null;
  } catch {
    return null;
  }
}

/**
 * Holds the daemon's first `file.upload.response`, so the upload is stored on
 * the host but the app still sees it in flight.
 */
export async function holdFileUploadResponse(page: Page) {
  let held: { browser: WebSocketRoute; message: WebSocketMessage } | null = null;
  let disconnected = false;
  const restoredTerminals = new Set<string>();
  let resolveHeld: (() => void) | null = null;
  const heldResponse = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const terminalId = subscribedTerminalId(message);
      const restoredOnNewConnection = disconnected && browser !== held?.browser;
      if (restoredOnNewConnection && terminalId) restoredTerminals.add(terminalId);
      if (held || !isFileUploadResponse(message)) {
        browser.send(message);
        return;
      }
      held = { browser, message };
      resolveHeld?.();
    });
  });
  return {
    waitUntilHeld: () => heldResponse,
    release: () => held?.browser.send(held.message),
    isTerminalRestored: (terminalId: string) => restoredTerminals.has(terminalId),
    /** Drops the app's connection while the upload is in flight. */
    disconnect: () => {
      disconnected = true;
      return held?.browser.close({ code: 1001, reason: "Upload gate disconnect" });
    },
  };
}
