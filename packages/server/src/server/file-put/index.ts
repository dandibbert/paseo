import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FilePutRequest, FilePutResponse } from "../messages.js";
import {
  commitFilePut,
  openFilePutTemporary,
  prepareExplorerFilePut,
  type PreparedFilePut,
  type WrittenFilePut,
} from "../file-explorer/service.js";

interface FilePutStoreOptions {
  staleTimeoutMs?: number;
}

interface PendingPut {
  request: FilePutRequest;
  source: object;
  finished(response: FilePutResponse | null): void;
  temporaryPath: string | null;
  handle: FileHandle | null;
  target: PreparedFilePut | null;
  receivedBytes: number;
  done: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  cleanup?: Promise<void>;
}

type PutOutcome = { file: WrittenFilePut } | { error: string; errorCode: "exists" | "error" };

/**
 * Receives `fs.file.put` streams. Bytes go to a hidden temporary file beside the target and replace
 * it only after the declared size arrives, so a dropped connection never leaves a partial file at
 * the target path.
 */
export class FilePutStore {
  private static readonly defaultStaleTimeoutMs = 10 * 60 * 1000;
  private readonly staleTimeoutMs: number;
  private readonly pending = new Map<object, Map<string, PendingPut>>();

  constructor(options: FilePutStoreOptions = {}) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? FilePutStore.defaultStaleTimeoutMs;
  }

  begin(
    request: FilePutRequest,
    source: object,
    finished: (response: FilePutResponse | null) => void,
  ): () => Promise<void> {
    const existing = this.pending.get(source)?.get(request.requestId);
    if (existing) void this.cancel(existing).catch(() => {});
    const put: PendingPut = {
      request,
      source,
      finished,
      temporaryPath: null,
      handle: null,
      target: null,
      receivedBytes: 0,
      done: false,
      staleTimeout: this.createStaleTimeout(source, request.requestId),
      queue: Promise.resolve(),
    };
    const puts = this.pending.get(source) ?? new Map<string, PendingPut>();
    puts.set(request.requestId, put);
    this.pending.set(source, puts);
    // Reject an unwritable target before the client finishes streaming.
    this.enqueue(put, () => this.prepare(put));
    return () => this.cancel(put);
  }

  /** True when the frame belongs to a put stream from `source`. */
  owns(frame: FileTransferFrame, source: object): boolean {
    return this.pending.get(source)?.has(frame.requestId) ?? false;
  }

  async receiveFrame(frame: FileTransferFrame, source: object): Promise<void> {
    const put = this.pending.get(source)?.get(frame.requestId);
    if (!put) return;
    this.refreshStaleTimeout(put);
    await this.enqueue(put, () => this.applyFrame(put, frame));
  }

  private enqueue(put: PendingPut, step: () => Promise<PutOutcome | null>): Promise<void> {
    put.queue = put.queue
      .then(async () => (put.done ? null : step()))
      .catch(async (error: unknown) => {
        await this.discard(put);
        return { error: getErrorMessage(error), errorCode: "error" } as const;
      })
      .then(async (outcome) => {
        if (!outcome) return undefined;
        if ("error" in outcome) await this.discard(put);
        this.settle(put, outcome);
        return undefined;
      });
    return put.queue;
  }

  private async prepare(put: PendingPut): Promise<PutOutcome | null> {
    const prepared = await prepareExplorerFilePut({
      root: put.request.cwd,
      relativePath: put.request.path,
      overwrite: put.request.overwrite === true,
      createParents: put.request.createParents === true,
    });
    if (prepared.status === "exists") return { error: prepared.error, errorCode: "exists" };
    if (prepared.status === "error") return { error: prepared.error, errorCode: "error" };
    put.target = prepared.target;
    const opened = await openFilePutTemporary(prepared.target);
    put.handle = opened.handle;
    put.temporaryPath = opened.temporaryPath;
    return null;
  }

  private async applyFrame(put: PendingPut, frame: FileTransferFrame): Promise<PutOutcome | null> {
    if (!put.handle) return null;
    if (frame.opcode === FileTransferOpcode.FileBegin) return null;
    if (frame.opcode === FileTransferOpcode.FileChunk) {
      const next = put.receivedBytes + frame.payload.byteLength;
      if (next > put.request.size) {
        throw new Error(
          `Put exceeded declared size: expected ${put.request.size}, received ${next}.`,
        );
      }
      await put.handle.write(frame.payload);
      put.receivedBytes = next;
      return null;
    }
    if (put.receivedBytes !== put.request.size) {
      throw new Error(
        `Put size mismatch: expected ${put.request.size}, received ${put.receivedBytes}.`,
      );
    }
    const handle = put.handle;
    put.handle = null;
    await handle.sync();
    await handle.close();
    const temporaryPath = put.temporaryPath!;
    put.temporaryPath = null;
    const committed = await commitFilePut({
      temporaryPath,
      target: put.target!,
      overwrite: put.request.overwrite === true,
    });
    if (committed.status === "exists") {
      return { error: "Target file already exists", errorCode: "exists" };
    }
    return { file: committed.file };
  }

  private settle(put: PendingPut, outcome: PutOutcome): void {
    if (put.done) return;
    put.done = true;
    this.clearPending(put);
    put.finished({
      type: "fs.file.put.response",
      payload: {
        requestId: put.request.requestId,
        cwd: put.request.cwd,
        path: put.target?.path ?? put.request.path,
        file: "file" in outcome ? outcome.file : null,
        error: "error" in outcome ? outcome.error : null,
        errorCode: "errorCode" in outcome ? outcome.errorCode : null,
      },
    });
  }

  private cancel(put: PendingPut): Promise<void> {
    if (put.cleanup) return put.cleanup;
    const wasDone = put.done;
    put.done = true;
    this.clearPending(put);
    put.cleanup = put.queue.then(() => this.discard(put));
    if (!wasDone) put.finished(null);
    return put.cleanup;
  }

  private async discard(put: PendingPut): Promise<void> {
    const handle = put.handle;
    put.handle = null;
    await handle?.close().catch(() => undefined);
    const temporaryPath = put.temporaryPath;
    put.temporaryPath = null;
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
  }

  private clearPending(put: PendingPut): void {
    clearTimeout(put.staleTimeout);
    const puts = this.pending.get(put.source);
    if (puts?.get(put.request.requestId) === put) puts.delete(put.request.requestId);
    if (puts?.size === 0) this.pending.delete(put.source);
  }

  private createStaleTimeout(source: object, requestId: string): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const put = this.pending.get(source)?.get(requestId);
      if (put) void this.cancel(put).catch(() => {});
    }, this.staleTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleTimeout(put: PendingPut): void {
    clearTimeout(put.staleTimeout);
    put.staleTimeout = this.createStaleTimeout(put.source, put.request.requestId);
  }
}
