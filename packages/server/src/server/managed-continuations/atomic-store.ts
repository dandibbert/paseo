import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  accountingFilename,
  assertSafeServerId,
  assertValidAgentId,
  eventFilename,
  fenceFilename,
  serverEntityFilename,
  sha256Hex,
} from "./codec.js";
import {
  AgentAccountingSchema,
  ContinuationLeaseSchema,
  DispatchBatchSchema,
  OneShotWakeupSchema,
  OriginTurnFenceSchema,
  TombstoneRecordSchema,
  WakeEventSchema,
  type AgentAccounting,
  type ContinuationLease,
  type CorruptRecordReport,
  type DispatchBatch,
  type OneShotWakeup,
  type OriginTurnFence,
  type TombstoneRecord,
  type WakeEvent,
} from "./types.js";

export interface StorageFaultHooks {
  /** Called right before writing temporary file content. Throw to simulate crash before write. */
  beforeTempWrite?: (targetPath: string) => void | Promise<void>;
  /** Called right after writing temp file, before atomic rename. Throw to simulate crash mid-write. */
  beforeAtomicRename?: (targetPath: string, tempPath: string) => void | Promise<void>;
}

export interface LoadCollectionResult<T> {
  records: T[];
  corrupt: CorruptRecordReport[];
}

export class ManagedContinuationStore {
  readonly baseDir: string;
  readonly fencesDir: string;
  readonly leasesDir: string;
  readonly eventsDir: string;
  readonly batchesDir: string;
  readonly wakeupsDir: string;
  readonly accountingDir: string;
  readonly tombstonesDir: string;

  constructor(
    paseoHomeDir: string,
    private readonly faultHooks?: StorageFaultHooks,
  ) {
    this.baseDir = path.join(path.resolve(paseoHomeDir), "managed-continuations");
    this.fencesDir = path.join(this.baseDir, "fences");
    this.leasesDir = path.join(this.baseDir, "leases");
    this.eventsDir = path.join(this.baseDir, "outbox", "events");
    this.batchesDir = path.join(this.baseDir, "outbox", "batches");
    this.wakeupsDir = path.join(this.baseDir, "wakeups");
    this.accountingDir = path.join(this.baseDir, "accounting");
    this.tombstonesDir = path.join(this.baseDir, "tombstones");
  }

  async ensureLayout(): Promise<void> {
    const dirs = [
      this.baseDir,
      this.fencesDir,
      this.leasesDir,
      path.join(this.baseDir, "outbox"),
      this.eventsDir,
      this.batchesDir,
      this.wakeupsDir,
      this.accountingDir,
      this.tombstonesDir,
    ];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this.assertNoSymlink(dir);
    }
  }

  // --- OriginTurnFence (single authoritative mutable file per fenceId) ---

  fencePath(fenceId: string): string {
    return path.join(this.fencesDir, fenceFilename(fenceId));
  }

  async writeFence(fence: OriginTurnFence): Promise<void> {
    const parsed = OriginTurnFenceSchema.parse(fence);
    const target = this.fencePath(parsed.fenceId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readFence(fenceId: string): Promise<OriginTurnFence | null> {
    const target = this.fencePath(fenceId);
    const record = await this.readJsonValidated(target, OriginTurnFenceSchema);
    if (!record) return null;
    if (record.fenceId !== fenceId) {
      throw new Error(
        `Fence identity mismatch in ${target}: expected ${fenceId}, got ${record.fenceId}`,
      );
    }
    return record;
  }

  async listFences(): Promise<LoadCollectionResult<OriginTurnFence>> {
    return this.listDirectoryValidated(
      this.fencesDir,
      OriginTurnFenceSchema,
      (record, fileName) => {
        if (fenceFilename(record.fenceId) !== fileName) {
          throw new Error(`Fence digest filename mismatch: ${fileName} vs ${record.fenceId}`);
        }
      },
    );
  }

  async deleteFence(fenceId: string): Promise<void> {
    await fs.rm(this.fencePath(fenceId), { force: true });
  }

  // --- ContinuationLease (references creatorFenceId ONLY) ---

  leasePath(leaseId: string): string {
    return path.join(this.leasesDir, serverEntityFilename(leaseId, "leaseId"));
  }

  async writeLease(lease: ContinuationLease): Promise<void> {
    const parsed = ContinuationLeaseSchema.parse(lease);
    const target = this.leasePath(parsed.leaseId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readLease(leaseId: string): Promise<ContinuationLease | null> {
    const target = this.leasePath(leaseId);
    const record = await this.readJsonValidated(target, ContinuationLeaseSchema);
    if (!record) return null;
    if (record.leaseId !== leaseId) {
      throw new Error(
        `Lease identity mismatch in ${target}: expected ${leaseId}, got ${record.leaseId}`,
      );
    }
    return record;
  }

  async listLeases(): Promise<LoadCollectionResult<ContinuationLease>> {
    return this.listDirectoryValidated(
      this.leasesDir,
      ContinuationLeaseSchema,
      (record, fileName) => {
        if (serverEntityFilename(record.leaseId, "leaseId") !== fileName) {
          throw new Error(`Lease filename mismatch: ${fileName} vs ${record.leaseId}`);
        }
      },
    );
  }

  async deleteLease(leaseId: string): Promise<void> {
    await fs.rm(this.leasePath(leaseId), { force: true });
  }

  // --- WakeEvent (hashed filename sha256(eventId).json, verified on load) ---

  eventPath(eventId: string): string {
    return path.join(this.eventsDir, eventFilename(eventId));
  }

  async writeEvent(event: WakeEvent): Promise<void> {
    const parsed = WakeEventSchema.parse(event);
    const target = this.eventPath(parsed.eventId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readEvent(eventId: string): Promise<WakeEvent | null> {
    const target = this.eventPath(eventId);
    const record = await this.readJsonValidated(target, WakeEventSchema);
    if (!record) return null;
    if (record.eventId !== eventId) {
      throw new Error(
        `WakeEvent identity mismatch in ${target}: expected ${eventId}, got ${record.eventId}`,
      );
    }
    return record;
  }

  async listEvents(): Promise<LoadCollectionResult<WakeEvent>> {
    return this.listDirectoryValidated(this.eventsDir, WakeEventSchema, (record, fileName) => {
      if (eventFilename(record.eventId) !== fileName) {
        throw new Error(`WakeEvent digest filename mismatch: ${fileName} vs ${record.eventId}`);
      }
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await fs.rm(this.eventPath(eventId), { force: true });
  }

  // --- DispatchBatch (immutable eventIds / batchMessageId / promptDigest once frozen) ---

  batchPath(batchId: string): string {
    return path.join(this.batchesDir, serverEntityFilename(batchId, "batchId"));
  }

  async writeBatch(batch: DispatchBatch): Promise<void> {
    const parsed = DispatchBatchSchema.parse(batch);
    const target = this.batchPath(parsed.batchId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readBatch(batchId: string): Promise<DispatchBatch | null> {
    const target = this.batchPath(batchId);
    const record = await this.readJsonValidated(target, DispatchBatchSchema);
    if (!record) return null;
    if (record.batchId !== batchId) {
      throw new Error(
        `Batch identity mismatch in ${target}: expected ${batchId}, got ${record.batchId}`,
      );
    }
    return record;
  }

  async listBatches(): Promise<LoadCollectionResult<DispatchBatch>> {
    return this.listDirectoryValidated(this.batchesDir, DispatchBatchSchema, (record, fileName) => {
      if (serverEntityFilename(record.batchId, "batchId") !== fileName) {
        throw new Error(`Batch filename mismatch: ${fileName} vs ${record.batchId}`);
      }
    });
  }

  async deleteBatch(batchId: string): Promise<void> {
    await fs.rm(this.batchPath(batchId), { force: true });
  }

  // --- OneShotWakeup ---

  wakeupPath(wakeId: string): string {
    return path.join(this.wakeupsDir, serverEntityFilename(wakeId, "wakeId"));
  }

  async writeWakeup(wakeup: OneShotWakeup): Promise<void> {
    const parsed = OneShotWakeupSchema.parse(wakeup);
    const target = this.wakeupPath(parsed.wakeId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readWakeup(wakeId: string): Promise<OneShotWakeup | null> {
    const target = this.wakeupPath(wakeId);
    const record = await this.readJsonValidated(target, OneShotWakeupSchema);
    if (!record) return null;
    if (record.wakeId !== wakeId) {
      throw new Error(
        `Wakeup identity mismatch in ${target}: expected ${wakeId}, got ${record.wakeId}`,
      );
    }
    return record;
  }

  async listWakeups(): Promise<LoadCollectionResult<OneShotWakeup>> {
    return this.listDirectoryValidated(this.wakeupsDir, OneShotWakeupSchema, (record, fileName) => {
      if (serverEntityFilename(record.wakeId, "wakeId") !== fileName) {
        throw new Error(`Wakeup filename mismatch: ${fileName} vs ${record.wakeId}`);
      }
    });
  }

  async deleteWakeup(wakeId: string): Promise<void> {
    await fs.rm(this.wakeupPath(wakeId), { force: true });
  }

  // --- AgentAccounting (accounting/<sha256(agentId)>.json + internal agentId verification) ---

  accountingPath(agentId: string): string {
    return path.join(this.accountingDir, accountingFilename(agentId));
  }

  async writeAccounting(record: AgentAccounting): Promise<void> {
    assertValidAgentId(record.agentId);
    const parsed = AgentAccountingSchema.parse(record);
    const target = this.accountingPath(parsed.agentId);
    await this.writeJsonAtomic0600(target, parsed);
  }

  async readAccounting(agentId: string): Promise<AgentAccounting | null> {
    assertValidAgentId(agentId);
    const target = this.accountingPath(agentId);
    const record = await this.readJsonValidated(target, AgentAccountingSchema);
    if (!record) return null;
    if (record.agentId !== agentId) {
      throw new Error(
        `Accounting agentId mismatch in ${target}: expected ${agentId}, got ${record.agentId}`,
      );
    }
    return record;
  }

  async listAccounting(): Promise<LoadCollectionResult<AgentAccounting>> {
    return this.listDirectoryValidated(
      this.accountingDir,
      AgentAccountingSchema,
      (record, fileName) => {
        if (accountingFilename(record.agentId) !== fileName) {
          throw new Error(
            `Accounting agentId digest mismatch: file ${fileName} does not match sha256(${record.agentId})`,
          );
        }
      },
    );
  }

  // --- Tombstone records for unresolved blocked/uncertain audit evidence ---

  tombstonePath(kind: TombstoneRecord["kind"], recordId: string): string {
    const safeDigest = sha256Hex(`${kind}:${recordId}`);
    return path.join(this.tombstonesDir, `${kind}-${safeDigest}.json`);
  }

  async writeTombstone(record: TombstoneRecord): Promise<string> {
    const parsed = TombstoneRecordSchema.parse(record);
    const target = this.tombstonePath(parsed.kind, parsed.recordId);
    await this.writeJsonAtomic0600(target, parsed);
    return target;
  }

  async listTombstones(): Promise<LoadCollectionResult<TombstoneRecord>> {
    return this.listDirectoryValidated(this.tombstonesDir, TombstoneRecordSchema);
  }

  // --- Low-level safe atomic I/O ---

  private async assertNoSymlink(targetPath: string): Promise<void> {
    try {
      const stat = await fs.lstat(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Symlink rejected inside managed-continuations private tree: ${targetPath}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async writeJsonAtomic0600(targetPath: string, value: unknown): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.assertNoSymlink(dir);
    await this.assertNoSymlink(targetPath);

    const payload = JSON.stringify(value, null, 2);
    const tempPath = path.join(
      dir,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await this.faultHooks?.beforeTempWrite?.(targetPath);
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.faultHooks?.beforeAtomicRename?.(targetPath, tempPath);
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readJsonValidated<T>(targetPath: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      await this.assertNoSymlink(targetPath);
      const raw = await fs.readFile(targetPath, "utf8");
      return schema.parse(JSON.parse(raw));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async listDirectoryValidated<T>(
    dirPath: string,
    schema: z.ZodType<T>,
    verify?: (record: T, fileName: string) => void,
  ): Promise<LoadCollectionResult<T>> {
    const records: T[] = [];
    const corrupt: CorruptRecordReport[] = [];
    let entries: string[];
    try {
      await this.assertNoSymlink(dirPath);
      entries = await fs.readdir(dirPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { records, corrupt };
      }
      throw error;
    }

    for (const fileName of entries.sort()) {
      // Ignore hidden atomic temp files left behind by a mid-write crash.
      if (fileName.startsWith(".") && fileName.endsWith(".tmp")) continue;
      if (!fileName.endsWith(".json")) {
        corrupt.push({
          filePath: path.join(dirPath, fileName),
          error: `Unexpected non-JSON file in store directory: ${fileName}`,
        });
        continue;
      }
      const fullPath = path.join(dirPath, fileName);
      try {
        await this.assertNoSymlink(fullPath);
        const raw = await fs.readFile(fullPath, "utf8");
        const parsed = schema.parse(JSON.parse(raw));
        verify?.(parsed, fileName);
        records.push(parsed);
      } catch (error) {
        corrupt.push({
          filePath: fullPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { records, corrupt };
  }

  /** Helper exposed for tests that verify strict server ID acceptance. */
  validateServerId(id: string, label: string): string {
    return assertSafeServerId(id, label);
  }
}
