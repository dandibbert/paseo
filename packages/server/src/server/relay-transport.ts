/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  type Transport as RelayTransport,
  type KeyPair,
} from "@getpaseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { ExternalSocketMetadata } from "./websocket-server.js";
import { createEncryptedRelaySocket } from "./websocket/encrypted-relay-socket.js";

export interface RelayTransportOptions {
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;
  relayEndpoint: string; // "host:port"
  relayUseTls: boolean;
  serverId: string;
  daemonKeyPair?: KeyPair;
  createWebSocket?: RelayWebSocketFactory;
}

export interface RelayTransportController {
  stop: () => Promise<void>;
}

export interface RelaySocketLike {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface RelayWebSocketLike extends RelaySocketLike {
  terminate: () => void;
  ping: () => void;
  on: (
    event: "open" | "message" | "close" | "error" | "pong",
    listener: (...args: unknown[]) => void,
  ) => void;
}

type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong" };

const CONTROL_PING_INTERVAL_MS = 10_000;
const CONTROL_STALE_TIMEOUT_MS = 30_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
// Protocol pongs can be answered by an intermediary. A sparse application probe
// also checks that the relay's control handler is still processing messages.
const CONTROL_APPLICATION_PROBE_INTERVAL_MS = 30_000;
const CONTROL_APPLICATION_PROBE_TIMEOUT_MS = 15_000;
const DATA_APPLICATION_STALE_MS = 45_000;
const RELAY_WEBSOCKET_OPTIONS = { handshakeTimeout: 10_000, perMessageDeflate: false } as const;

function createDefaultRelayWebSocket(url: string): RelayWebSocketLike {
  return new WebSocket(url, RELAY_WEBSOCKET_OPTIONS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseControlMessage(raw: unknown): ControlMessage | null {
  try {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else {
      text = String(raw);
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type === "ping") return { type: "ping" };
    if (parsed.type === "pong") return { type: "pong" };
    if (parsed.type === "sync" && Array.isArray(parsed.connectionIds)) {
      const connectionIds = parsed.connectionIds
        .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim());
      return { type: "sync", connectionIds };
    }
    if (
      parsed.type === "connected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "connected", connectionId: parsed.connectionId.trim() };
    }
    if (
      parsed.type === "disconnected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "disconnected", connectionId: parsed.connectionId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  relayUseTls,
  serverId,
  daemonKeyPair,
  createWebSocket = createDefaultRelayWebSocket,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let controlWs: RelayWebSocketLike | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, RelayWebSocketLike>(); // connectionId -> ws
  let controlKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let controlReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  let controlLastSeenAt = 0;
  let controlConnectionSeq = 0;
  const wantedConnections = new Set<string>();
  const dataRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const dataRetryAttempts = new Map<string, number>();
  const dataCleanups = new Map<RelayWebSocketLike, () => void>();

  const cancelDataRetry = (id: string): void => {
    const timer = dataRetries.get(id);
    if (timer) clearTimeout(timer);
    dataRetries.delete(id);
  };

  const dropDataSocket = (id: string): void => {
    const socket = dataSockets.get(id);
    if (!socket) return;
    // Retire ownership before close callbacks (which can arrive synchronously).
    dataSockets.delete(id);
    dataCleanups.get(socket)?.();
    try {
      socket.terminate();
    } catch (error) {
      relayLogger.warn({ err: error, connectionId: id }, "relay_data_terminate_failed");
    }
  };

  const retryDataSocket = (id: string): void => {
    if (stopped || !wantedConnections.has(id) || dataRetries.has(id)) return;
    const attempt = (dataRetryAttempts.get(id) ?? 0) + 1;
    dataRetryAttempts.set(id, attempt);
    dataRetries.set(
      id,
      setTimeout(
        () => {
          dataRetries.delete(id);
          if (controlWs?.readyState === WebSocket.OPEN) ensureClientDataSocket(id);
        },
        Math.min(30_000, 1_000 * attempt),
      ),
    );
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    wantedConnections.clear();
    for (const id of dataRetries.keys()) cancelDataRetry(id);
    dataRetryAttempts.clear();
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (controlKeepaliveInterval) {
      clearInterval(controlKeepaliveInterval);
      controlKeepaliveInterval = null;
    }
    if (controlReadyTimeout) {
      clearTimeout(controlReadyTimeout);
      controlReadyTimeout = null;
    }
    if (controlWs) {
      try {
        controlWs.terminate();
      } catch {
        // ignore
      }
      controlWs = null;
    }
    for (const id of dataSockets.keys()) dropDataSocket(id);
  };

  const connectControl = (): void => {
    if (stopped) return;

    const connectionId = ++controlConnectionSeq;
    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
    });
    let socket: RelayWebSocketLike;
    try {
      socket = createWebSocket(url);
    } catch (error) {
      relayLogger.warn({ err: error, connectionId }, "relay_control_create_failed");
      scheduleReconnect();
      return;
    }
    controlWs = socket;
    let controlConnected = false;
    let applicationLastSeenAt = Date.now();
    let applicationProbeAt: number | null = null;

    const markControlReady = () => {
      if (controlWs !== socket) return;
      if (controlConnected) return;
      controlConnected = true;
      reconnectAttempt = 0;
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      relayLogger.info({ connectionId }, "relay_control_connected");
    };

    socket.on("open", () => {
      if (controlWs !== socket) return;

      controlLastSeenAt = Date.now();
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      controlReadyTimeout = setTimeout(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (controlConnected) return;
        relayLogger.warn(
          { url, connectionId, waitedMs: CONTROL_READY_TIMEOUT_MS },
          "relay_control_ready_timeout_terminating",
        );
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }, CONTROL_READY_TIMEOUT_MS);
      controlKeepaliveInterval = setInterval(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (socket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const staleForMs = now - controlLastSeenAt;
        // If the control socket is half-open or silently dropped, ws may never emit "close".
        // Use a WebSocket protocol ping to detect staleness and force a reconnect.
        // This checks the network leg; the less frequent application probe below
        // separately checks the relay handler, even when an edge answers pings.
        if (staleForMs > CONTROL_STALE_TIMEOUT_MS) {
          relayLogger.warn(
            { url, staleForMs, connectionId, staleTimeoutMs: CONTROL_STALE_TIMEOUT_MS },
            "relay_control_stale_terminating",
          );
          try {
            socket.terminate();
          } catch {
            // ignore
          }
          return;
        }

        if (
          applicationProbeAt !== null &&
          now - applicationProbeAt >= CONTROL_APPLICATION_PROBE_TIMEOUT_MS
        ) {
          relayLogger.warn({ connectionId }, "relay_control_application_timeout_terminating");
          socket.terminate();
          return;
        }
        try {
          if (
            controlConnected &&
            applicationProbeAt === null &&
            now - applicationLastSeenAt >= CONTROL_APPLICATION_PROBE_INTERVAL_MS
          ) {
            applicationProbeAt = now;
            socket.send(JSON.stringify({ type: "ping" }));
          }
          socket.ping();
        } catch (error) {
          relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
          try {
            socket.terminate();
          } catch {
            // ignore
          }
        }
      }, CONTROL_PING_INTERVAL_MS);
      try {
        socket.ping();
      } catch (error) {
        relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      relayLogger.debug({ connectionId }, "relay_control_open_waiting_for_ready");
    });

    socket.on("close", (code, reason) => {
      if (controlWs !== socket) return;
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_control_disconnected",
      );
      controlWs = null;
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (controlWs !== socket) return;
      relayLogger.warn({ err, connectionId }, "relay_error");
      // close event will schedule reconnect
    });

    socket.on("pong", () => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      relayLogger.debug({ connectionId }, "relay_control_pong_received");
    });

    socket.on("message", (data) => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      const msg = tryParseControlMessage(data);
      if (msg) {
        applicationLastSeenAt = Date.now();
        applicationProbeAt = null;
        markControlReady();
      }
      if (!msg) return;
      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "sync") {
        const wanted = new Set(msg.connectionIds);
        for (const id of wantedConnections) {
          if (wanted.has(id)) continue;
          wantedConnections.delete(id);
          cancelDataRetry(id);
          dataRetryAttempts.delete(id);
          dropDataSocket(id);
        }
        for (const id of wanted) {
          wantedConnections.add(id);
          ensureClientDataSocket(id);
        }
        return;
      }
      if (msg.type === "connected") {
        wantedConnections.add(msg.connectionId);
        ensureClientDataSocket(msg.connectionId);
        return;
      }
      if (msg.type === "disconnected") {
        wantedConnections.delete(msg.connectionId);
        cancelDataRetry(msg.connectionId);
        dataRetryAttempts.delete(msg.connectionId);
        dropDataSocket(msg.connectionId);
      }
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimeout) return;

    reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * reconnectAttempt);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connectControl();
    }, delayMs);
  };

  const ensureClientDataSocket = (connectionId: string): void => {
    if (stopped) return;
    if (!connectionId) return;
    const existing = dataSockets.get(connectionId);
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING)
      return;
    if (existing) dropDataSocket(connectionId);
    cancelDataRetry(connectionId);

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
      connectionId,
    });
    let socket: RelayWebSocketLike;
    try {
      socket = createWebSocket(url);
    } catch (error) {
      relayLogger.warn({ err: error, connectionId }, "relay_data_create_failed");
      retryDataSocket(connectionId);
      return;
    }
    dataSockets.set(connectionId, socket);
    const isCurrent = () => !stopped && dataSockets.get(connectionId) === socket;
    let attached = false;
    let lastMessageAt = Date.now();
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const openTimeout = setTimeout(() => {
      if (!isCurrent()) return;
      relayLogger.warn({ connectionId }, "relay_data_open_timeout_terminating");
      dropDataSocket(connectionId);
      retryDataSocket(connectionId);
    }, 15_000);
    const cleanup = () => {
      clearTimeout(openTimeout);
      if (keepalive) clearInterval(keepalive);
      dataCleanups.delete(socket);
    };
    dataCleanups.set(socket, cleanup);
    socket.on("message", () => {
      lastMessageAt = Date.now();
    });

    socket.on("open", () => {
      if (!isCurrent()) {
        socket.terminate();
        return;
      }
      keepalive = setInterval(() => {
        if (!isCurrent()) return;
        // Count data/application traffic, not edge-generated protocol pongs.
        if (
          socket.readyState !== WebSocket.OPEN ||
          Date.now() - lastMessageAt > DATA_APPLICATION_STALE_MS
        ) {
          relayLogger.warn({ connectionId }, "relay_data_stale_terminating");
          dropDataSocket(connectionId);
          retryDataSocket(connectionId);
        }
      }, CONTROL_PING_INTERVAL_MS);
      relayLogger.info({ connectionId }, "relay_data_connected");
      if (attached) return;
      attached = true;
      const externalMetadata: ExternalSocketMetadata = {
        transport: "relay",
        externalSessionKey: `session:${connectionId}`,
        relayConnectionId: connectionId,
      };
      const attach = daemonKeyPair
        ? attachEncryptedSocket(
            socket,
            daemonKeyPair,
            relayLogger.child({ connectionId }),
            attachSocket,
            externalMetadata,
            isCurrent,
          )
        : attachSocket(socket, externalMetadata);
      void attach
        .then(() => {
          if (!isCurrent()) return undefined;
          clearTimeout(openTimeout);
          dataRetryAttempts.delete(connectionId);
          return undefined;
        })
        .catch((error) => {
          relayLogger.warn({ err: error, connectionId }, "relay_data_attach_failed");
          if (!isCurrent()) return;
          dropDataSocket(connectionId);
          retryDataSocket(connectionId);
        });
    });

    socket.on("close", (code, reason) => {
      cleanup();
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_data_disconnected",
      );
      if (dataSockets.get(connectionId) === socket) {
        dataSockets.delete(connectionId);
        retryDataSocket(connectionId);
      }
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, connectionId }, "relay_data_error");
    });
  };

  connectControl();

  return { stop };
}

async function attachEncryptedSocket(
  socket: RelayWebSocketLike,
  daemonKeyPair: KeyPair,
  logger: pino.Logger,
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>,
  metadata?: ExternalSocketMetadata,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    const relayTransport = createRelayTransportAdapter(socket, logger);
    const emitter = new EventEmitter();
    const pendingMessages: Array<string | ArrayBuffer> = [];
    let attached = false;
    const emitMessage = (data: string | ArrayBuffer) => {
      if (attached) {
        emitter.emit("message", data);
        return;
      }
      pendingMessages.push(data);
    };
    const channel = await createDaemonChannel(relayTransport, daemonKeyPair, {
      onmessage: emitMessage,
      onclose: (code, reason) => emitter.emit("close", code, reason),
      onerror: (error) => {
        logger.warn({ err: error }, "relay_e2ee_error");
        if (emitter.listenerCount("error") > 0) emitter.emit("error", error);
      },
    });
    if (!isCurrent() || socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      return;
    }
    const encryptedSocket = createEncryptedRelaySocket({
      channel,
      emitter,
      getTransportBufferedAmount: () => socket.bufferedAmount,
      terminateTransport: () => socket.terminate(),
    });
    await attachSocket(encryptedSocket, metadata);
    if (!isCurrent()) {
      encryptedSocket.terminate();
      return;
    }
    attached = true;
    for (const message of pendingMessages) {
      emitter.emit("message", message);
    }
    pendingMessages.length = 0;
  } catch (error) {
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.terminate();
    } catch {
      // ignore
    }
  }
}

function createRelayTransportAdapter(
  socket: RelayWebSocketLike,
  logger: pino.Logger,
): RelayTransport {
  const relayTransport: RelayTransport = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        try {
          socket.send(data, (error) => {
            if (!error) {
              resolve();
              return;
            }
            logger.warn({ err: error }, "relay_socket_send_failed");
            reject(error);
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn({ err }, "relay_socket_send_failed");
          reject(err);
        }
      }),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  socket.on("message", (data, isBinary) => {
    const binary = isBinary === true;
    relayTransport.onmessage?.({ data: normalizeMessageData(data, binary), isBinary: binary });
  });
  socket.on("close", (code, reason) => {
    const closeCode = typeof code === "number" ? code : 1006;
    relayTransport.onclose?.(closeCode, String(reason ?? ""));
  });
  socket.on("error", (err) => {
    relayTransport.onerror?.(err instanceof Error ? err : new Error(String(err)));
  });

  return relayTransport;
}

function normalizeMessageData(data: unknown, isBinary: boolean): string | ArrayBuffer {
  if (!isBinary) {
    if (typeof data === "string") return data;
    const buffer = bufferFromWsData(data);
    if (buffer) return buffer.toString("utf8");
    return String(data);
  }

  if (data instanceof ArrayBuffer) return data;

  const buffer = bufferFromWsData(data);
  if (buffer) {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }

  return String(data);
}

function bufferFromWsData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      } else if (typeof part === "string") {
        buffers.push(Buffer.from(part, "utf8"));
      } else {
        return null;
      }
    }
    return Buffer.concat(buffers);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}
