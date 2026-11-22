/**
 * A client for the WebSocket RPC that T3 Code's own web and desktop clients use. T3 builds it with
 * Effect RPC and its JSON serialization, so every frame is one JSON object tagged by `_tag`. This
 * client speaks that framing directly and leaves payloads as plain JSON: it reads only the fields
 * it maps and ignores the rest, so a newer T3 that adds fields or event kinds keeps working.
 */

export class T3RpcError extends Error {
  constructor(
    message: string,
    readonly code: "closed" | "failure" | "defect" | "interrupted" | "timeout",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "T3RpcError";
  }
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onChunk?: (value: unknown) => void;
}

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const PING_INTERVAL_MS = 5_000;
// T3's client allows 15 seconds without a frame before it drops the socket.
const SILENCE_LIMIT_MS = 15_000;

export function defaultSocketFactory(url: string): SocketLike {
  const Socket = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Socket) throw new Error("This runtime has no WebSocket client.");
  return new Socket(url);
}

/** Reads the reason out of an Effect `Exit` failure as sent by T3. */
function describeFailure(exit: Record<string, unknown>): T3RpcError {
  const causes = Array.isArray(exit.cause) ? (exit.cause as Array<Record<string, unknown>>) : [];
  for (const cause of causes) {
    if (cause._tag === "Fail") {
      const error = cause.error as Record<string, unknown> | undefined;
      const message =
        (typeof error?.message === "string" && error.message) ||
        (typeof error?._tag === "string" && error._tag) ||
        "T3 refused the request.";
      return new T3RpcError(message, "failure", error);
    }
    if (cause._tag === "Die") {
      return new T3RpcError("T3 failed while handling the request.", "defect", cause.defect);
    }
  }
  return new T3RpcError("T3 interrupted the request.", "interrupted");
}

export class T3RpcConnection {
  private nextId = 1;
  private readonly calls = new Map<string, PendingCall>();
  private readonly closeListeners = new Set<(error: T3RpcError) => void>();
  private lastFrameAt = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closedError: T3RpcError | undefined;

  private constructor(private readonly socket: SocketLike) {}

  static async open(url: string, createSocket: SocketFactory = defaultSocketFactory) {
    const socket = createSocket(url);
    const connection = new T3RpcConnection(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new T3RpcError("Could not connect to T3.", "closed")),
      );
      socket.addEventListener("close", (event) =>
        reject(new T3RpcError(`T3 closed the connection (${event.code}).`, "closed")),
      );
    });
    connection.attach();
    return connection;
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  onClose(listener: (error: T3RpcError) => void): () => void {
    if (this.closedError) {
      listener(this.closedError);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** One request, one result. */
  request<T = unknown>(tag: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.send(tag, payload);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        this.write({ _tag: "Interrupt", requestId: id, interruptors: [] });
        reject(new T3RpcError(`T3 did not answer ${tag} in time.`, "timeout"));
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /**
   * A streaming request. `onChunk` receives every value; the returned promise settles when the
   * stream ends. Call `cancel` to interrupt it.
   */
  stream(
    tag: string,
    payload: unknown,
    onChunk: (value: unknown) => void,
  ): { done: Promise<void>; cancel(): void } {
    const id = this.send(tag, payload);
    let cancel = () => {};
    const done = new Promise<void>((resolve, reject) => {
      this.calls.set(id, { resolve: () => resolve(), reject, onChunk });
      cancel = () => {
        if (!this.calls.delete(id)) return;
        this.write({ _tag: "Interrupt", requestId: id, interruptors: [] });
        resolve();
      };
    });
    return { done, cancel: () => cancel() };
  }

  close(): void {
    this.shutdown(new T3RpcError("The T3 connection was closed.", "closed"));
    try {
      this.socket.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  private send(tag: string, payload: unknown): string {
    if (this.closedError) throw this.closedError;
    const id = String(this.nextId++);
    this.write({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  private write(frame: Record<string, unknown>): void {
    if (this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private attach(): void {
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("close", (event) =>
      this.shutdown(new T3RpcError(`T3 closed the connection (${event.code}).`, "closed")),
    );
    this.socket.addEventListener("error", () =>
      this.shutdown(new T3RpcError("The T3 connection failed.", "closed")),
    );
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) {
        this.close();
        return;
      }
      this.write({ _tag: "Ping" });
    }, PING_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private receive(data: unknown): void {
    this.lastFrameAt = Date.now();
    const text =
      typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    let frames: unknown;
    try {
      frames = JSON.parse(text);
    } catch {
      return;
    }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      this.handleFrame(frame as Record<string, unknown>);
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    switch (frame._tag) {
      case "Ping":
        this.write({ _tag: "Pong" });
        return;
      case "Chunk": {
        const id = String(frame.requestId);
        const call = this.calls.get(id);
        if (!call) return;
        for (const value of Array.isArray(frame.values) ? frame.values : []) call.onChunk?.(value);
        // Streams are pulled: the server sends the next chunk after this acknowledgement.
        this.write({ _tag: "Ack", requestId: id });
        return;
      }
      case "Exit": {
        const id = String(frame.requestId);
        const call = this.calls.get(id);
        if (!call) return;
        this.calls.delete(id);
        const exit = (frame.exit ?? {}) as Record<string, unknown>;
        if (exit._tag === "Success") call.resolve(exit.value);
        else call.reject(describeFailure(exit));
        return;
      }
      case "Defect":
        this.shutdown(new T3RpcError("T3 reported a protocol error.", "defect", frame.defect));
        return;
      default:
        return;
    }
  }

  private shutdown(error: T3RpcError): void {
    if (this.closedError) return;
    this.closedError = error;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}
