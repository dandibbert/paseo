import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** The only scopes this provider asks for: read threads and send to them. */
export const T3_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
/** The name T3 lists for this connection under its connected clients. */
export const T3_CLIENT_LABEL = "Paseo";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
// Renew a little early so a turn never starts on a token about to lapse.
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

export class T3AuthError extends Error {
  constructor(
    message: string,
    readonly code: "not_paired" | "pair_failed" | "exchange_failed" | "unreachable",
  ) {
    super(message);
    this.name = "T3AuthError";
  }
}

const credentialsSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().url(),
  accessToken: z.string().min(1),
  expiresAt: z.number(),
});
export type T3Credentials = z.infer<typeof credentialsSchema>;

const tokenResultSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
});

const ticketResultSchema = z.object({ ticket: z.string().min(1) });

export interface PairingGrant {
  baseUrl: string;
  token: string;
}

/** Where the paired session lives, beside the daemon's own state. Only this user can read it. */
export function credentialsPath(env: Readonly<Record<string, string | undefined>> = process.env) {
  const home = env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  return path.join(home, "t3-provider", "credentials.json");
}

/** Reads `https://host/pair#token=…`, the URL `t3 pair` prints. */
export function parsePairingUrl(value: string): PairingGrant {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new T3AuthError("The T3 pairing URL is not a URL.", "pair_failed");
  }
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new T3AuthError("The T3 pairing URL has no token.", "pair_failed");
  return { baseUrl: url.origin, token };
}

/** Reads the origin and token from `t3 pair` output. */
export function parsePairOutput(output: string): PairingGrant {
  const origin = /^Pairing with .* \((https?:\/\/[^)\s]+)\)\.$/m.exec(output)?.[1];
  const token = /^Token: (\S+)$/m.exec(output)?.[1];
  if (origin && token) return { baseUrl: new URL(origin).origin, token };
  const pairingUrl = /^Pairing URL: (\S+)$/m.exec(output)?.[1];
  if (pairingUrl) return parsePairingUrl(pairingUrl);
  throw new T3AuthError(
    "`t3 pair` printed no pairing token. Is the T3 server running?",
    "pair_failed",
  );
}

/**
 * Asks the T3 CLI on this machine for a one-time pairing token, the way a user pairs a new
 * device. It needs the T3 server running for the same user.
 */
export async function pairWithLocalCli(launch: ProviderLaunch): Promise<PairingGrant> {
  const args = [
    ...launch.args,
    "pair",
    "--label",
    T3_CLIENT_LABEL,
    ...T3_SCOPES.flatMap((scope) => ["--scope", scope]),
  ];
  let stdout: string;
  try {
    ({ stdout } = await execCommand(launch.command, args, {
      env: launch.env,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new T3AuthError(`\`t3 pair\` failed: ${detail}`, "pair_failed");
  }
  return parsePairOutput(stdout);
}

/** Trades a pairing token for a session. T3 lists it under its connected clients as "Paseo". */
export async function exchangePairingToken(
  grant: PairingGrant,
  fetchImpl: typeof fetch = fetch,
): Promise<T3Credentials> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: grant.token,
    subject_token_type: BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    scope: T3_SCOPES.join(" "),
    client_label: T3_CLIENT_LABEL,
    client_device_type: "desktop",
    client_os: process.platform,
  });
  let response: Response;
  try {
    response = await fetchImpl(new URL("/oauth/token", grant.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new T3AuthError(`Could not reach T3 at ${grant.baseUrl}.`, "unreachable");
  }
  if (!response.ok) {
    throw new T3AuthError(
      `T3 refused the pairing token (HTTP ${response.status}). Pair again.`,
      "exchange_failed",
    );
  }
  const result = tokenResultSchema.parse(await response.json());
  return {
    version: 1,
    baseUrl: grant.baseUrl,
    accessToken: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

/** A short-lived ticket for one WebSocket upgrade, as T3's own clients use. */
export async function issueWebSocketUrl(
  credentials: T3Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const headers = { authorization: `Bearer ${credentials.accessToken}` };
  const post = (pathname: string) =>
    fetchImpl(new URL(pathname, credentials.baseUrl), { method: "POST", headers });
  let response: Response;
  try {
    response = await post("/api/auth/websocket-ticket/rpc");
    // A server older than ticket audiences has only the bare route.
    if (response.status === 404) response = await post("/api/auth/websocket-ticket");
  } catch {
    throw new T3AuthError(`Could not reach T3 at ${credentials.baseUrl}.`, "unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new T3AuthError("T3 no longer accepts this connection. Pair again.", "not_paired");
  }
  if (!response.ok) {
    throw new T3AuthError(
      `T3 refused a connection ticket (HTTP ${response.status}).`,
      "unreachable",
    );
  }
  const { ticket } = ticketResultSchema.parse(await response.json());
  const url = rpcSocketUrl(credentials.baseUrl);
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * The orchestration protocol this client speaks. T3 refuses the socket (HTTP 426) when it does
 * not match its own, so a T3 release that moves to a new protocol fails here, before any RPC.
 */
export const T3_ORCHESTRATION_PROTOCOL = 2;

function rpcSocketUrl(baseUrl: string): URL {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", String(T3_ORCHESTRATION_PROTOCOL));
  return url;
}

/**
 * Why T3 refused the RPC socket. A WebSocket handshake failure carries no status, so this asks
 * the same route over plain HTTP, without a ticket, and reads T3's own message.
 */
export async function explainSocketRefusal(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = rpcSocketUrl(baseUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  try {
    const response = await fetchImpl(url, { method: "GET" });
    if (response.status === 426) {
      const body = (await response.json().catch(() => ({}))) as { message?: unknown };
      return typeof body.message === "string"
        ? `T3 uses a different protocol than this Paseo: ${body.message}`
        : "T3 uses a different protocol than this Paseo.";
    }
    return undefined;
  } catch {
    return `Could not reach T3 at ${baseUrl}.`;
  }
}

export class CredentialStore {
  constructor(private readonly file: string) {}

  async read(): Promise<T3Credentials | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return undefined;
    }
    const parsed = credentialsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    return parsed.data.expiresAt - EXPIRY_MARGIN_MS > Date.now() ? parsed.data : undefined;
  }

  async write(credentials: T3Credentials): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
