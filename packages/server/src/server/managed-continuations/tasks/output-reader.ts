import { promises as fs } from "node:fs";
import { ManagedTaskStore } from "./task-store.js";
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  MAX_OUTPUT_READ_BYTES,
  type ReadTaskOutputInput,
  type ReadTaskOutputResult,
} from "./types.js";

export class TaskAccessDeniedError extends Error {
  readonly code = "TASK_ACCESS_DENIED";
}

export class TaskOutputQueryError extends Error {
  readonly code = "INVALID_OUTPUT_QUERY";
}

/**
 * Trims leading UTF-8 continuation bytes (`10xxxxxx`) so a slice starting mid-codepoint
 * never produces leading U+FFFD replacement characters.
 */
export function trimLeadingUtf8Continuation(buf: Buffer): { slice: Buffer; trimmed: number } {
  let start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return { slice: buf.subarray(start), trimmed: start };
}

/**
 * Trims trailing incomplete UTF-8 multi-byte sequence so a slice ending mid-codepoint
 * never produces trailing U+FFFD replacement characters.
 */
export function trimTrailingIncompleteUtf8(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  let contCount = 0;
  while (i >= 0 && contCount < 3 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1;
    contCount += 1;
  }
  if (i < 0) return Buffer.alloc(0);
  const lead = buf[i]!;
  let expectedLen = 1;
  if ((lead & 0x80) === 0x00) expectedLen = 1;
  else if ((lead & 0xe0) === 0xc0) expectedLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
  const actualLen = buf.length - i;
  return actualLen < expectedLen ? buf.subarray(0, i) : buf;
}

/**
 * Extracts a UTF-8-boundary-safe tail of at most `maxBytes` from a log file.
 */
export async function readUtf8TailFromFile(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { text: "", truncated: false, totalBytes: 0 };
    }
    throw error;
  }
  const totalBytes = stat.size;
  if (totalBytes === 0 || maxBytes <= 0) {
    return { text: "", truncated: totalBytes > 0, totalBytes };
  }
  const start = Math.max(0, totalBytes - maxBytes);
  const length = totalBytes - start;
  const buf = Buffer.alloc(length);
  const handle = await fs.open(filePath, "r");
  try {
    await handle.read(buf, 0, length, start);
  } finally {
    await handle.close();
  }
  const { slice } = start > 0 ? trimLeadingUtf8Continuation(buf) : { slice: buf };
  const clean = trimTrailingIncompleteUtf8(slice);
  return {
    text: clean.toString("utf8"),
    truncated: start > 0,
    totalBytes,
  };
}

function parseCursorByteOffset(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    throw new TaskOutputQueryError(`Invalid output cursor: ${cursor}`);
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TaskOutputQueryError(`Invalid output cursor offset: ${cursor}`);
  }
  return parsed;
}

async function assertTaskOutputAccess(
  store: ManagedTaskStore,
  input: ReadTaskOutputInput,
): Promise<void> {
  const intent = await store.readIntent(input.taskId);
  if (!intent) {
    throw new TaskAccessDeniedError(`Task not found: ${input.taskId}`);
  }
  if (
    intent.agentId !== input.callerAgentId ||
    (input.callerWorkspaceId && intent.workspaceId !== input.callerWorkspaceId)
  ) {
    throw new TaskAccessDeniedError(`Caller does not own task ${input.taskId}`);
  }
}

export async function readManagedTaskOutput(
  store: ManagedTaskStore,
  input: ReadTaskOutputInput,
): Promise<ReadTaskOutputResult> {
  if (input.cursor !== undefined && input.tailBytes !== undefined) {
    throw new TaskOutputQueryError("cursor and tailBytes are mutually exclusive");
  }
  await assertTaskOutputAccess(store, input);

  const maxBytes = Math.min(
    Math.max(1, input.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES),
    MAX_OUTPUT_READ_BYTES,
  );
  const logPath = store.logPath(input.taskId, input.stream);
  await store.assertNoSymlink(logPath);

  const resultRecord = await store.readResult(input.taskId);
  const discardedField =
    input.stream === "stdout" ? "bytesDiscardedStdout" : "bytesDiscardedStderr";
  const bytesDiscarded = resultRecord?.[discardedField] ?? 0;

  let totalBytes = 0;
  try {
    totalBytes = (await fs.stat(logPath)).size;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return {
      taskId: input.taskId,
      stream: input.stream,
      text: "",
      startByte: 0,
      endByte: 0,
      truncated: false,
      bytesDiscarded,
    };
  }

  let requestStart = 0;
  let requestLen = 0;
  if (input.tailBytes !== undefined) {
    const effectiveTail = Math.min(Math.max(0, input.tailBytes), maxBytes);
    requestStart = Math.max(0, totalBytes - effectiveTail);
    requestLen = totalBytes - requestStart;
  } else {
    requestStart = input.cursor !== undefined ? parseCursorByteOffset(input.cursor) : 0;
    if (requestStart >= totalBytes) {
      return {
        taskId: input.taskId,
        stream: input.stream,
        text: "",
        startByte: totalBytes,
        endByte: totalBytes,
        truncated: false,
        bytesDiscarded,
      };
    }
    requestLen = Math.min(maxBytes, totalBytes - requestStart);
  }

  const raw = Buffer.alloc(requestLen);
  const handle = await fs.open(logPath, "r");
  try {
    await handle.read(raw, 0, requestLen, requestStart);
  } finally {
    await handle.close();
  }

  const { slice, trimmed } =
    requestStart > 0 ? trimLeadingUtf8Continuation(raw) : { slice: raw, trimmed: 0 };
  const clean = requestStart + requestLen < totalBytes ? trimTrailingIncompleteUtf8(slice) : slice;
  const startByte = requestStart + trimmed;
  const endByte = startByte + clean.length;
  const hasMore = endByte < totalBytes;

  return {
    taskId: input.taskId,
    stream: input.stream,
    text: clean.toString("utf8"),
    startByte,
    endByte,
    ...(hasMore ? { nextCursor: String(endByte) } : {}),
    truncated: startByte > 0 || hasMore || bytesDiscarded > 0,
    bytesDiscarded,
  };
}
