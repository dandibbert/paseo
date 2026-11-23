import { execCommand } from "@getpaseo/plugin/server";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { T3AuthError } from "./auth.js";
import { buildCatalog } from "./catalog.js";
import { T3Environment, type T3EnvironmentOptions } from "./environment.js";
import { T3RpcError } from "./rpc.js";
import { T3Session, T3SessionError } from "./session.js";

export const T3_PROVIDER_ID = "antigravity-t3";

const SUPPORTED = [
  "prompt.message",
  "prompt.image",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "session.can_stop_runtime",
  "permission",
] as const;

function providerError(error: unknown): ProviderError {
  if (error instanceof T3AuthError || error instanceof T3SessionError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof T3RpcError) return { message: error.message, code: `t3_${error.code}` };
  return { message: error instanceof Error ? error.message : String(error) };
}

export interface T3ProviderOptions {
  /** Test seams; production uses the real filesystem, fetch and WebSocket. */
  environment?: Omit<T3EnvironmentOptions, "launch">;
}

function connect(
  launch: ProviderLaunch | undefined,
  capabilities: readonly string[],
  options: T3ProviderOptions,
): ProviderConnection {
  const environment = new T3Environment({ ...options.environment, launch });
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, T3Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };

  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog") {
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: buildCatalog(await environment.instances()),
      });
      return;
    }
    if (input.type === "session.open") {
      if (sessions.has(input.sessionId)) {
        throw new T3SessionError("This session is already open.", "duplicateSession");
      }
      const session = new T3Session({ id: input.sessionId, environment, emit, capabilities });
      sessions.set(input.sessionId, session);
      try {
        await session.open(input);
      } catch (error) {
        sessions.delete(input.sessionId);
        await session.close();
        throw error;
      }
      return;
    }
    if (!("sessionId" in input)) {
      throw new T3SessionError(`Antigravity via T3 does not support ${input.type}.`, "unsupported");
    }
    const session = sessions.get(input.sessionId);
    if (!session) throw new T3SessionError("This session is not open.", "unknownSession");
    switch (input.type) {
      case "session.prompt":
        await session.prompt(input.prompt);
        return;
      case "session.permission":
        await session.answer(input.permissionId, input.response);
        return;
      case "session.configure":
        await session.configure(input.changes);
        break;
      case "session.interrupt":
        await session.interrupt();
        break;
      case "session.can_stop_runtime":
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: session.canStopRuntime(),
        });
        return;
      case "session.close":
        await session.close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      default:
        throw new T3SessionError(
          `Antigravity via T3 does not support ${input.type}.`,
          "unsupported",
        );
    }
    if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, failure: unknown): void {
    const error = providerError(failure);
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error });
    } else if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
    }
  }

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities,
    async send(input) {
      if (closed) throw new T3SessionError("The T3 connection is closed.", "closed");
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (!closed) void dispatch(input).catch((error: unknown) => failed(input, error));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      listeners.clear();
      environment.close();
    },
  };
}

/**
 * Antigravity through a T3 Code server on this machine. T3 runs Antigravity with its own
 * integration; Paseo is one more T3 client, like T3's web and mobile apps, and never starts
 * `agy` itself.
 */
export function createT3Provider(options: T3ProviderOptions = {}): ProviderRegistration {
  return {
    id: T3_PROVIDER_ID,
    label: "Antigravity (via T3)",
    description: "Antigravity run by your T3 Code server",
    icon: "icon.svg",
    command: ["t3"],
    installation: {
      installUrl: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md",
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
          env: launch.env,
          timeout: 10_000,
          maxBuffer: 8192,
          signal,
        });
        const version = /\b\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
        return version ? { status: "installed", version } : { status: "installed" };
      },
    },
    async status({ launch }) {
      const environment = new T3Environment({ ...options.environment, launch });
      try {
        const instances = await environment.instances();
        if (!instances.some((instance) => instance.enabled && instance.models.length > 0)) {
          return {
            available: false,
            diagnostic: "T3 has no Antigravity account ready. Sign in to Antigravity in T3.",
          };
        }
        return { available: true };
      } catch (error) {
        return { available: false, diagnostic: providerError(error).message };
      } finally {
        environment.close();
      }
    },
    async connect(request) {
      return connect(
        request.launch,
        negotiateProviderCapabilities(request.capabilities, SUPPORTED),
        options,
      );
    },
  };
}
