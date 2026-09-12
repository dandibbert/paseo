import { closeSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

interface DiskBlock {
  offset: number;
  capacity: number;
  length: number;
}
export interface TimelinePayloadHandle {
  readonly compressed: boolean;
  block?: DiskBlock;
}

/** Runtime-only backing, never the provider's durable transcript. */
export class TimelinePayloadStore {
  private readonly resident = new Map<TimelinePayloadHandle, Buffer>();
  private readonly freeBlocks = new Map<number, number[]>();
  private residentBytes = 0;
  private diskBytes = 0;
  private diskRows = 0;
  private endOffset = 0;
  private fd: number | null = null;
  private cleanupFile: (() => void) | null = null;
  private reads = 0;

  constructor(private readonly maxMemoryBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes < 0) {
      throw new Error("Timeline memory budget must be a non-negative safe integer");
    }
  }

  put(row: AgentTimelineRow): TimelinePayloadHandle {
    const raw = serialize(row);
    const zipped = raw.length >= 1024 ? deflateRawSync(raw, { level: 1 }) : raw;
    const compressed = zipped.length < raw.length;
    const selected = compressed ? zipped : raw;
    // zlib can return a short view of a much larger slab. Own exactly the bytes
    // charged to the budget rather than retaining that entire allocation.
    const bytes = Buffer.allocUnsafeSlow(selected.length);
    selected.copy(bytes);
    const handle: TimelinePayloadHandle = { compressed };
    this.resident.set(handle, bytes);
    this.residentBytes += bytes.length;
    try {
      this.evict();
      return handle;
    } catch (error) {
      this.release(handle);
      throw error;
    }
  }

  get(handle: TimelinePayloadHandle): AgentTimelineRow {
    this.reads++;
    let bytes = this.resident.get(handle);
    if (!bytes) {
      const block = handle.block;
      if (!block || this.fd === null) throw new Error("Timeline payload was released");
      bytes = Buffer.allocUnsafe(block.length);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(this.fd, bytes, offset, bytes.length - offset, block.offset + offset);
        if (n === 0) throw new Error("Unexpected end of timeline backing file");
        offset += n;
      }
    }
    // Historical reads do not repopulate the hot set or evict live tail payloads.
    return deserialize(handle.compressed ? inflateRawSync(bytes) : bytes) as AgentTimelineRow;
  }

  release(handle: TimelinePayloadHandle): void {
    const buffer = this.resident.get(handle);
    if (buffer) {
      this.residentBytes -= buffer.length;
      this.resident.delete(handle);
    }
    const block = handle.block;
    if (block) {
      const free = this.freeBlocks.get(block.capacity) ?? [];
      free.push(block.offset);
      this.freeBlocks.set(block.capacity, free);
      this.diskBytes -= block.length;
      this.diskRows--;
      delete handle.block;
      if (this.diskRows === 0) this.closeBacking();
    }
  }

  stats(): {
    residentBytes: number;
    spilledBytes: number;
    spilledRows: number;
    payloadReads: number;
  } {
    return {
      residentBytes: this.residentBytes,
      spilledBytes: this.diskBytes,
      spilledRows: this.diskRows,
      payloadReads: this.reads,
    };
  }

  dispose(): void {
    this.resident.clear();
    this.residentBytes = 0;
    this.diskBytes = 0;
    this.diskRows = 0;
    this.closeBacking();
  }

  private evict(): void {
    while (this.residentBytes > this.maxMemoryBytes) {
      const entry = this.resident.entries().next().value;
      if (!entry) return;
      const [handle, bytes] = entry;
      // Commit the complete disk write before dropping the only in-memory copy.
      handle.block = this.writeBlock(bytes);
      this.diskRows++;
      this.diskBytes += bytes.length;
      this.resident.delete(handle);
      this.residentBytes -= bytes.length;
    }
  }

  private writeBlock(bytes: Buffer): DiskBlock {
    const fd = this.openBacking();
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(64, bytes.length)));
    const free = this.freeBlocks.get(capacity);
    const reused = free?.pop();
    const offset = reused ?? this.endOffset;
    if (reused === undefined) this.endOffset += capacity;
    let written = 0;
    try {
      while (written < bytes.length) {
        const n = writeSync(fd, bytes, written, bytes.length - written, offset + written);
        if (n === 0) throw new Error("Timeline backing write made no progress");
        written += n;
      }
    } catch (error) {
      const available = this.freeBlocks.get(capacity) ?? [];
      available.push(offset);
      this.freeBlocks.set(capacity, available);
      throw error;
    }
    return { offset, length: bytes.length, capacity };
  }

  private openBacking(): number {
    if (this.fd !== null) return this.fd;
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-"));
    const filename = path.join(directory, "rows.bin");
    let fd: number;
    try {
      fd = openSync(filename, "wx+", 0o600);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    try {
      if (process.platform !== "win32") {
        // An unlinked descriptor is private and the OS reclaims it even on crash.
        unlinkSync(filename);
        rmSync(directory, { recursive: true });
      }
    } catch (error) {
      closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    this.fd = fd;
    this.cleanupFile = () => {
      closeSync(fd);
      if (process.platform === "win32") rmSync(directory, { recursive: true, force: true });
    };
    if (process.platform === "win32") process.once("exit", this.cleanupFile);
    return fd;
  }

  private closeBacking(): void {
    if (this.cleanupFile) {
      process.off("exit", this.cleanupFile);
      this.cleanupFile();
    }
    this.cleanupFile = null;
    this.fd = null;
    this.endOffset = 0;
    this.freeBlocks.clear();
  }
}
