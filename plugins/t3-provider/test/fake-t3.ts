import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A stand-in for a T3 Code server: its pairing and ticket HTTP routes, and its WebSocket RPC in
 * Effect RPC's JSON framing. It records what the client sends so tests can check the requests.
 */

export interface RecordedRequest {
  tag: string;
  payload: Record<string, unknown>;
}

export interface FakeT3Options {
  providers?: unknown[];
  projects?: Array<{ id: string; workspaceRoot: string }>;
  /** The orchestration protocol this server speaks; T3 refuses sockets for any other. */
  orchestrationProtocol?: number;
  /** Called for every orchestration.dispatchCommand; returning an error string fails it. */
  onCommand?: (command: Record<string, unknown>, server: FakeT3) => string | void;
}

const NOW = "2026-11-22T00:00:00.000Z";

export const ANTIGRAVITY_PROVIDERS = [
  {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    installed: true,
    status: "ready",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    models: [
      {
        slug: "gemini-4-pro",
        name: "Gemini 4 Pro",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    instanceId: "antigravity-work",
    driver: "antigravity",
    displayName: "Work account",
    enabled: true,
    installed: true,
    status: "ready",
    supportedRuntimeModes: ["approval-required", "full-access"],
    models: [{ slug: "gemini-4-pro", name: "Gemini 4 Pro", isCustom: false, capabilities: null }],
  },
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
  },
];

export function turnItem(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

export function run(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "run-1",
    threadId: "thread-1",
    ordinal: 1,
    providerInstanceId: "antigravity",
    modelSelection: { instanceId: "antigravity", model: "gemini-4-pro" },
    providerThreadId: null,
    userMessageId: "message-1",
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued",
    requestedAt: NOW,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...fields,
  };
}

export function projection(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread: { id: "thread-1" },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
    ...fields,
  };
}

export class FakeT3 {
  readonly requests: RecordedRequest[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly pairingToken = "pair-token-1";
  readonly accessToken = "access-token-1";
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private sequence = 10;
  private threadStreams: Array<{ socket: WebSocket; requestId: string; threadId: string }> = [];
  private threadProjection: Record<string, unknown> = projection();
  baseUrl = "";

  private get protocol(): number {
    return this.options.orchestrationProtocol ?? 2;
  }

  constructor(private readonly options: FakeT3Options = {}) {
    this.http = createServer((request, response) => void this.handleHttp(request, response));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (
        url.pathname !== "/ws" ||
        url.searchParams.get("orchestrationProtocol") !== String(this.protocol) ||
        url.searchParams.get("wsTicket") !== "ticket-1"
      ) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    const { port } = this.http.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this;
  }

  get pairingUrl(): string {
    return `${this.baseUrl}/pair#token=${this.pairingToken}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Drops every connection, as a restarting server would. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  commands(type?: string): Array<Record<string, unknown>> {
    return this.requests
      .filter((request) => request.tag === "orchestration.dispatchCommand")
      .map((request) => request.payload)
      .filter((command) => type === undefined || command.type === type);
  }

  setProjection(value: Record<string, unknown>): void {
    this.threadProjection = value;
  }

  /** Pushes a domain event to every subscriber of the thread. */
  emit(type: string, payload: unknown): void {
    this.sequence += 1;
    for (const stream of this.threadStreams) {
      this.chunk(stream.socket, stream.requestId, [
        { kind: "event", sequence: this.sequence, event: { type, payload } },
      ]);
    }
  }

  private async handleHttp(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = await new Promise<string>((resolve) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => resolve(text));
    });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      if (form.get("subject_token") !== this.pairingToken) return json(401, { error: "invalid" });
      return json(200, {
        access_token: this.accessToken,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 30 * 24 * 3600,
        scope: form.get("scope"),
      });
    }
    if (url.pathname === "/ws" && request.method === "GET") {
      // As T3 does, the protocol check comes before authentication.
      if (url.searchParams.get("orchestrationProtocol") !== String(this.protocol)) {
        return json(426, {
          code: "orchestration_protocol_incompatible",
          message: `Update this client to one that supports orchestration protocol ${this.protocol}.`,
          orchestrationProtocolVersion: this.protocol,
        });
      }
      return json(401, { error: "unauthorized" });
    }
    if (url.pathname === "/api/auth/websocket-ticket/rpc" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${this.accessToken}`) {
        return json(401, { error: "unauthorized" });
      }
      return json(200, { ticket: "ticket-1", expiresAt: NOW });
    }
    json(404, {});
  }

  private attach(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.threadStreams = this.threadStreams.filter((stream) => stream.socket !== socket);
    });
    socket.on("message", (data) => {
      const frames = JSON.parse(String(data)) as unknown;
      for (const frame of Array.isArray(frames) ? frames : [frames]) {
        this.handleFrame(socket, frame as Record<string, unknown>);
      }
    });
  }

  private send(socket: WebSocket, frame: unknown): void {
    socket.send(JSON.stringify(frame));
  }

  private chunk(socket: WebSocket, requestId: string, values: unknown[]): void {
    this.send(socket, { _tag: "Chunk", requestId, values });
  }

  private succeed(socket: WebSocket, requestId: string, value: unknown): void {
    this.send(socket, { _tag: "Exit", requestId, exit: { _tag: "Success", value } });
  }

  private fail(socket: WebSocket, requestId: string, message: string): void {
    this.send(socket, {
      _tag: "Exit",
      requestId,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "Refused", message } }] },
    });
  }

  private handleFrame(socket: WebSocket, frame: Record<string, unknown>): void {
    if (frame._tag === "Ping") {
      this.send(socket, { _tag: "Pong" });
      return;
    }
    if (frame._tag === "Interrupt") {
      const id = String(frame.requestId);
      this.threadStreams = this.threadStreams.filter((stream) => stream.requestId !== id);
      this.send(socket, {
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: null }] },
      });
      return;
    }
    if (frame._tag !== "Request") return;
    const id = String(frame.id);
    const tag = String(frame.tag);
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (!Array.isArray(frame.headers)) throw new Error("Request without headers");
    this.requests.push({ tag, payload });
    switch (tag) {
      case "server.getConfig":
        this.succeed(socket, id, { providers: this.options.providers ?? ANTIGRAVITY_PROVIDERS });
        return;
      case "orchestration.subscribeShell":
        this.chunk(socket, id, [
          { kind: "snapshot", snapshot: { projects: this.options.projects ?? [] } },
        ]);
        return;
      case "projects.mutate":
        this.succeed(socket, id, { id: payload.projectId, workspaceRoot: payload.workspaceRoot });
        return;
      case "orchestration.launchThread":
        this.threadProjection = projection({
          runs: [
            run({ userMessageId: (payload.initialMessage as { messageId: string }).messageId }),
          ],
        });
        this.succeed(socket, id, {
          threadId: "thread-1",
          projection: this.threadProjection,
          resumed: false,
        });
        return;
      case "orchestration.subscribeThread":
        this.threadStreams.push({ socket, requestId: id, threadId: String(payload.threadId) });
        this.chunk(socket, id, [
          { kind: "snapshot", snapshotSequence: this.sequence, projection: this.threadProjection },
        ]);
        return;
      case "orchestration.dispatchCommand": {
        const error = this.options.onCommand?.(payload, this);
        if (error) this.fail(socket, id, error);
        else this.succeed(socket, id, { sequence: this.sequence });
        return;
      }
      case "secrets.answerRequest":
        this.succeed(socket, id, null);
        return;
      default:
        this.fail(socket, id, `Unknown method ${tag}`);
    }
  }
}
