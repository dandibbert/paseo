import { createHash } from "node:crypto";
import path from "node:path";
import type { RunIdentity } from "./types.js";

const SAFE_SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_WITH_TZ_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export const SEND_LATER_PAST_GRACE_MS = 60_000;
export const SEND_LATER_MIN_DELAY_MS = 10_000;
export const SEND_LATER_MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SEND_LATER_MIN_SECONDS = 10;
export const SEND_LATER_MAX_SECONDS = 2_592_000;
export const SEND_LATER_MIN_MINUTES = 1;
export const SEND_LATER_MAX_MINUTES = 43_200;
export const MAX_PROMPT_BYTES = 16 * 1024;

export class InvalidManagedIdError extends Error {
  readonly code = "INVALID_MANAGED_ID";
}

export class SendLaterTimeError extends Error {
  constructor(
    readonly code:
      | "WAKE_TIME_INVALID"
      | "WAKE_TIME_MISSING_TIMEZONE"
      | "WAKE_TIME_IN_PAST"
      | "WAKE_TIME_TOO_FAR"
      | "WAKE_SCHEDULE_SPEC_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "SendLaterTimeError";
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Server-generated identifiers (`taskId`, `wakeId`, `leaseId`, `batchId`) must match
 * `^[A-Za-z0-9_-]{1,64}$`. Rejects path traversal, colons, slashes, and Unicode lookalikes.
 */
export function assertSafeServerId(id: string, label: string): string {
  if (typeof id !== "string" || !SAFE_SERVER_ID_RE.test(id)) {
    throw new InvalidManagedIdError(
      `Invalid ${label}: must match ^[A-Za-z0-9_-]{1,64}$ (received ${JSON.stringify(id)})`,
    );
  }
  return id;
}

/**
 * Validates that an `agentId` is a non-empty bounded string without control characters.
 * Because `agentId` is never used directly as a filename, it is always mapped via `sha256(agentId)`
 * and reverse-checked against the stored JSON body on load.
 */
export function assertValidAgentId(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.length === 0 ||
    agentId.length > 256 ||
    /[\0\r\n]/.test(agentId)
  ) {
    throw new InvalidManagedIdError(`Invalid agentId: ${JSON.stringify(agentId)}`);
  }
  return agentId;
}

/**
 * Validates logical `eventId` (may contain colons such as `task:abc:terminal`,
 * but NEVER used directly as a filename).
 */
export function assertValidLogicalEventId(eventId: string): string {
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    eventId.length > 256 ||
    /[\0\r\n\\]/.test(eventId) ||
    eventId.includes("..")
  ) {
    throw new InvalidManagedIdError(`Invalid eventId: ${JSON.stringify(eventId)}`);
  }
  return eventId;
}

export function computeFenceId(origin: RunIdentity): string {
  if (!origin.daemonInstanceId || !origin.runToken) {
    throw new InvalidManagedIdError("RunIdentity requires non-empty daemonInstanceId and runToken");
  }
  return sha256Hex(`${origin.daemonInstanceId}:${origin.runToken}`);
}

export function fenceFilename(fenceId: string): string {
  if (!/^[a-f0-9]{64}$/.test(fenceId)) {
    throw new InvalidManagedIdError(`Invalid fenceId digest: ${JSON.stringify(fenceId)}`);
  }
  return `${fenceId}.json`;
}

export function eventFilename(eventId: string): string {
  assertValidLogicalEventId(eventId);
  return `${sha256Hex(eventId)}.json`;
}

export function accountingFilename(agentId: string): string {
  assertValidAgentId(agentId);
  return `${sha256Hex(agentId)}.json`;
}

export function serverEntityFilename(id: string, label: string): string {
  assertSafeServerId(id, label);
  return `${id}.json`;
}

export function computePromptDigest(serializedPrompt: string): string {
  return sha256Hex(serializedPrompt);
}

/**
 * Ensures `payloadRef` is a safe relative path strictly contained inside `rootDir`.
 */
export function validatePayloadRef(rootDir: string, payloadRef: string): string {
  if (
    typeof payloadRef !== "string" ||
    payloadRef.length === 0 ||
    payloadRef.includes("\0") ||
    payloadRef.includes("\\") ||
    path.isAbsolute(payloadRef)
  ) {
    throw new InvalidManagedIdError(`Invalid payloadRef: ${JSON.stringify(payloadRef)}`);
  }
  const normalized = path.posix.normalize(payloadRef);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new InvalidManagedIdError(`Path traversal rejected in payloadRef: ${payloadRef}`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, normalized);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new InvalidManagedIdError(`payloadRef escapes root directory: ${payloadRef}`);
  }
  return normalized;
}

export function assertUtf8ByteLimit(value: string, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new InvalidManagedIdError(`${label} exceeds UTF-8 byte limit (${bytes} > ${maxBytes})`);
  }
}

export interface ValidatedSendLaterSchedule {
  dueAt: string;
  dueAtMs: number;
  clamped: boolean;
}

/**
 * Validates `send_later(at)` per Spec v0.4.1 §6.2 & Guardrail #4:
 * - Must be a valid calendar ISO 8601 timestamp with explicit `Z` or `±HH:MM` timezone.
 * - Rejects `t < now - 60s` (`WAKE_TIME_IN_PAST`) and `t > now + 30d` (`WAKE_TIME_TOO_FAR`).
 * - Clamps `now - 60s <= t <= now + 10s` to `now + 10s` with `clamped: true`.
 */
export function validateSendLaterAt(at: string, nowMs: number): ValidatedSendLaterSchedule {
  if (typeof at !== "string" || at.trim() !== at || at.length === 0) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", "at must be a non-empty ISO 8601 string");
  }
  const match = ISO_WITH_TZ_RE.exec(at);
  if (!match) {
    const looksLikeIsoWithoutTz = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(at);
    if (looksLikeIsoWithoutTz) {
      throw new SendLaterTimeError(
        "WAKE_TIME_MISSING_TIMEZONE",
        `at timestamp must include Z or ±HH:MM timezone offset: ${at}`,
      );
    }
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Invalid ISO 8601 timestamp: ${at}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tz = match[8]!;
  const tzHour = match[10] ? Number(match[10]) : 0;
  const tzMinute = match[11] ? Number(match[11]) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Invalid calendar date in at: ${at}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Invalid clock time in at: ${at}`);
  }
  if (tz !== "Z" && (tzHour > 23 || tzMinute > 59)) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Invalid timezone offset in at: ${at}`);
  }

  // Verify exact calendar date (e.g. rejects 2026-02-30 or 2026-04-31).
  const checkUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    checkUtc.getUTCFullYear() !== year ||
    checkUtc.getUTCMonth() !== month - 1 ||
    checkUtc.getUTCDate() !== day
  ) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Non-existent calendar date in at: ${at}`);
  }

  const parsedMs = Date.parse(at);
  if (!Number.isFinite(parsedMs)) {
    throw new SendLaterTimeError("WAKE_TIME_INVALID", `Unparseable timestamp: ${at}`);
  }

  if (parsedMs < nowMs - SEND_LATER_PAST_GRACE_MS) {
    throw new SendLaterTimeError(
      "WAKE_TIME_IN_PAST",
      `at (${at}) is more than 60s in the past relative to server time`,
    );
  }
  if (parsedMs > nowMs + SEND_LATER_MAX_DELAY_MS) {
    throw new SendLaterTimeError(
      "WAKE_TIME_TOO_FAR",
      `at (${at}) exceeds maximum 30-day scheduling horizon`,
    );
  }
  if (parsedMs <= nowMs + SEND_LATER_MIN_DELAY_MS) {
    const clampedMs = nowMs + SEND_LATER_MIN_DELAY_MS;
    return {
      dueAt: new Date(clampedMs).toISOString(),
      dueAtMs: clampedMs,
      clamped: true,
    };
  }
  return {
    dueAt: new Date(parsedMs).toISOString(),
    dueAtMs: parsedMs,
    clamped: false,
  };
}

export function resolveSendLaterSchedule(
  input: { afterSeconds?: number; afterMinutes?: number; at?: string },
  nowMs: number,
): ValidatedSendLaterSchedule {
  const provided = [
    input.afterSeconds !== undefined,
    input.afterMinutes !== undefined,
    input.at !== undefined,
  ].filter(Boolean).length;

  if (provided !== 1) {
    throw new SendLaterTimeError(
      "WAKE_SCHEDULE_SPEC_CONFLICT",
      "Exactly one of afterSeconds, afterMinutes, or at must be provided",
    );
  }

  if (input.at !== undefined) {
    return validateSendLaterAt(input.at, nowMs);
  }

  if (input.afterSeconds !== undefined) {
    if (
      !Number.isInteger(input.afterSeconds) ||
      input.afterSeconds < SEND_LATER_MIN_SECONDS ||
      input.afterSeconds > SEND_LATER_MAX_SECONDS
    ) {
      throw new SendLaterTimeError(
        "WAKE_TIME_INVALID",
        `afterSeconds must be an integer between ${SEND_LATER_MIN_SECONDS} and ${SEND_LATER_MAX_SECONDS}`,
      );
    }
    const dueAtMs = nowMs + input.afterSeconds * 1000;
    return { dueAt: new Date(dueAtMs).toISOString(), dueAtMs, clamped: false };
  }

  const minutes = input.afterMinutes!;
  if (
    !Number.isInteger(minutes) ||
    minutes < SEND_LATER_MIN_MINUTES ||
    minutes > SEND_LATER_MAX_MINUTES
  ) {
    throw new SendLaterTimeError(
      "WAKE_TIME_INVALID",
      `afterMinutes must be an integer between ${SEND_LATER_MIN_MINUTES} and ${SEND_LATER_MAX_MINUTES}`,
    );
  }
  const dueAtMs = nowMs + minutes * 60_000;
  return { dueAt: new Date(dueAtMs).toISOString(), dueAtMs, clamped: false };
}
