import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CredentialStore,
  T3AuthError,
  credentialsPath,
  exchangePairingToken,
  explainSocketRefusal,
  issueWebSocketUrl,
  pairWithLocalCli,
  parsePairingUrl,
  type T3Credentials,
} from "./auth.js";
import { T3RpcConnection, T3RpcError, type SocketFactory, defaultSocketFactory } from "./rpc.js";

/** T3's driver id for Antigravity. This provider shows only those instances. */
export const ANTIGRAVITY_DRIVER = "antigravity";

/**
 * T3 records each message's source as one of its own clients. Its web and desktop apps send
 * "web" for a message a person typed, which is what a Paseo message is.
 */
export const CREATION_SOURCE = "web";

export interface T3ProviderOptionChoice {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export type T3OptionDescriptor =
  | {
      type: "select";
      id: string;
      label: string;
      description?: string;
      options: T3ProviderOptionChoice[];
      currentValue?: string;
      role?: "reasoning";
    }
  | { type: "boolean"; id: string; label: string; description?: string; currentValue?: boolean };

export interface T3Model {
  slug: string;
  name: string;
  isDefault?: boolean;
  optionDescriptors: T3OptionDescriptor[];
}

/** One Antigravity provider instance in T3: one Google account and its models. */
export interface T3Instance {
  instanceId: string;
  displayName: string;
  enabled: boolean;
  ready: boolean;
  message?: string;
  runtimeModes: string[];
  models: T3Model[];
  usageLimits?: unknown;
}

export interface T3EnvironmentOptions {
  launch?: ProviderLaunch;
  credentialsFile?: string;
  fetchImpl?: typeof fetch;
  createSocket?: SocketFactory;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDescriptor(value: unknown): T3OptionDescriptor | undefined {
  const raw = record(value);
  const id = text(raw.id);
  const label = text(raw.label);
  if (!id || !label) return undefined;
  if (raw.type === "boolean") {
    return {
      type: "boolean",
      id,
      label,
      description: text(raw.description),
      currentValue: typeof raw.currentValue === "boolean" ? raw.currentValue : undefined,
    };
  }
  if (raw.type !== "select" || !Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((option) => {
    const choice = record(option);
    const choiceId = text(choice.id);
    const choiceLabel = text(choice.label);
    return choiceId && choiceLabel
      ? [
          {
            id: choiceId,
            label: choiceLabel,
            description: text(choice.description),
            isDefault: choice.isDefault === true ? true : undefined,
          },
        ]
      : [];
  });
  return {
    type: "select",
    id,
    label,
    description: text(raw.description),
    options,
    currentValue: text(raw.currentValue),
    role: raw.role === "reasoning" ? "reasoning" : undefined,
  };
}

export function readInstances(config: unknown): T3Instance[] {
  const providers = record(config).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((value) => {
    const provider = record(value);
    if (provider.driver !== ANTIGRAVITY_DRIVER) return [];
    const instanceId = text(provider.instanceId);
    if (!instanceId) return [];
    const models = (Array.isArray(provider.models) ? provider.models : []).flatMap((entry) => {
      const model = record(entry);
      const slug = text(model.slug);
      if (!slug) return [];
      const descriptors = record(model.capabilities).optionDescriptors;
      return [
        {
          slug,
          name: text(model.name) ?? slug,
          isDefault: model.isDefault === true ? true : undefined,
          optionDescriptors: (Array.isArray(descriptors) ? descriptors : []).flatMap(
            (descriptor) => readDescriptor(descriptor) ?? [],
          ),
        },
      ];
    });
    return [
      {
        instanceId,
        displayName: text(provider.displayName) ?? "Antigravity",
        enabled: provider.enabled !== false,
        ready: provider.status === "ready" && provider.installed !== false,
        message: text(provider.message) ?? text(provider.unavailableReason),
        runtimeModes: Array.isArray(provider.supportedRuntimeModes)
          ? provider.supportedRuntimeModes.filter(
              (mode): mode is string => typeof mode === "string",
            )
          : [],
        models,
        usageLimits: provider.usageLimits,
      },
    ];
  });
}

/**
 * The paired T3 server, shared by every Paseo session. It pairs on first use, keeps one
 * WebSocket, and opens a new one when it drops.
 */
export class T3Environment {
  private readonly store: CredentialStore;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: SocketFactory;
  private connection: Promise<T3RpcConnection> | undefined;
  private credentials: T3Credentials | undefined;
  private readonly reconnectListeners = new Set<() => void>();

  constructor(private readonly options: T3EnvironmentOptions = {}) {
    this.store = new CredentialStore(
      options.credentialsFile ?? credentialsPath(options.launch?.env ?? process.env),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
  }

  get baseUrl(): string | undefined {
    return this.credentials?.baseUrl;
  }

  /** Whether Paseo already holds a T3 session; reading this never pairs. */
  async isPaired(): Promise<boolean> {
    return (await this.store.read()) !== undefined;
  }

  /** Runs after a dropped socket is replaced, so open thread subscriptions can resume. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  async connect(): Promise<T3RpcConnection> {
    if (!this.connection) {
      this.connection = this.open().catch((error: unknown) => {
        this.connection = undefined;
        throw error;
      });
    }
    return this.connection;
  }

  close(): void {
    const pending = this.connection;
    this.connection = undefined;
    void pending?.then((connection) => connection.close()).catch(() => undefined);
  }

  async request<T = unknown>(tag: string, payload: unknown, timeoutMs?: number): Promise<T> {
    const connection = await this.connect();
    return connection.request<T>(tag, payload, timeoutMs);
  }

  async instances(): Promise<T3Instance[]> {
    return readInstances(await this.request("server.getConfig", {}));
  }

  /** The T3 project rooted at `cwd`, created the way T3's "Add project" does when missing. */
  async projectFor(cwd: string): Promise<string> {
    const root = path.resolve(cwd);
    const projects = await this.listProjects();
    const existing = projects.find((project) => path.resolve(project.workspaceRoot) === root);
    if (existing) return existing.id;
    const projectId = randomUUID();
    await this.request("projects.mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: path.basename(root) || root,
      workspaceRoot: root,
    });
    return projectId;
  }

  dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.request("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  }

  private async listProjects(): Promise<Array<{ id: string; workspaceRoot: string }>> {
    const connection = await this.connect();
    let snapshot: unknown;
    const subscription = connection.stream("orchestration.subscribeShell", {}, (item) => {
      if (record(item).kind === "snapshot" && snapshot === undefined) {
        snapshot = record(item).snapshot;
        subscription.cancel();
      }
    });
    await subscription.done;
    const projects = record(snapshot).projects;
    return (Array.isArray(projects) ? projects : []).flatMap((value) => {
      const project = record(value);
      const id = text(project.id);
      const workspaceRoot = text(project.workspaceRoot);
      return id && workspaceRoot && !project.archivedAt ? [{ id, workspaceRoot }] : [];
    });
  }

  private async open(): Promise<T3RpcConnection> {
    let credentials = await this.ensureCredentials();
    let url: string;
    try {
      url = await issueWebSocketUrl(credentials, this.fetchImpl);
    } catch (error) {
      if (!(error instanceof T3AuthError) || error.code !== "not_paired") throw error;
      // T3 revoked or forgot this session: pair once more.
      await this.store.clear();
      this.credentials = undefined;
      credentials = await this.ensureCredentials();
      url = await issueWebSocketUrl(credentials, this.fetchImpl);
    }
    let connection: T3RpcConnection;
    try {
      connection = await T3RpcConnection.open(url, this.createSocket);
    } catch (error) {
      const reason = await explainSocketRefusal(credentials.baseUrl, this.fetchImpl);
      if (reason) throw new T3RpcError(reason, "closed");
      throw error;
    }
    connection.onClose(() => {
      if (this.connection === undefined) return;
      this.connection = undefined;
      // Reconnect lazily: the next request or a resuming subscription opens a new socket.
      for (const listener of this.reconnectListeners) listener();
    });
    return connection;
  }

  private async ensureCredentials(): Promise<T3Credentials> {
    if (this.credentials && this.credentials.expiresAt > Date.now()) return this.credentials;
    const stored = await this.store.read();
    if (stored) {
      this.credentials = stored;
      return stored;
    }
    const grant = await this.pairingGrant();
    const credentials = await exchangePairingToken(grant, this.fetchImpl);
    await this.store.write(credentials);
    this.credentials = credentials;
    return credentials;
  }

  private async pairingGrant() {
    const pairingUrl = this.options.launch?.env.T3_PAIRING_URL;
    if (pairingUrl) return parsePairingUrl(pairingUrl);
    if (!this.options.launch) {
      throw new T3AuthError(
        "Install the T3 Code CLI (`t3`) and start its server, or set T3_PAIRING_URL.",
        "not_paired",
      );
    }
    return pairWithLocalCli(this.options.launch);
  }
}
