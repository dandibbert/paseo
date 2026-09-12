import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TimelinePayloadStore } from "./timeline-payload-store.js";
const stores: TimelinePayloadStore[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.dispose();
});

test("spills beyond a shared byte budget, reads losslessly, and releases backing", () => {
  const store = new TimelinePayloadStore(1024);
  stores.push(store);
  const rows = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    timestamp: String(i),
    item: { type: "assistant_message" as const, text: randomBytes(4096).toString("hex") },
  }));
  const handles = rows.map((row) => store.put(row));
  expect(store.stats().residentBytes).toBeLessThanOrEqual(1024);
  expect(store.stats().spilledRows).toBe(100);
  for (let i = 0; i < rows.length; i++) expect(store.get(handles[i])).toEqual(rows[i]);
  for (const handle of handles) store.release(handle);
  expect(store.stats()).toEqual({
    residentBytes: 0,
    spilledBytes: 0,
    spilledRows: 0,
    payloadReads: 100,
  });
  const next = store.put(rows[0]);
  expect(store.get(next)).toEqual(rows[0]);
});

test("does not retain mutable caller objects or let reads mutate stored history", () => {
  const store = new TimelinePayloadStore();
  stores.push(store);
  const row = {
    seq: 1,
    timestamp: "now",
    item: { type: "assistant_message" as const, text: "original" },
  };
  const handle = store.put(row);
  row.item.text = "mutated";
  const read = store.get(handle);
  expect(read.item).toEqual({ type: "assistant_message", text: "original" });
  if (read.item.type === "assistant_message") read.item.text = "modified read";
  expect(store.get(handle).item).toEqual({ type: "assistant_message", text: "original" });
});

test("a failed spill preserves accepted rows and recovers when storage is available", () => {
  const store = new TimelinePayloadStore(512);
  stores.push(store);
  const first = {
    seq: 1,
    timestamp: "now",
    item: { type: "assistant_message" as const, text: "kept" },
  };
  const handle = store.put(first);
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-missing-temp-"));
  rmSync(directory, { recursive: true });
  vi.stubEnv("TMPDIR", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TEMP", directory);
  const large = {
    seq: 2,
    timestamp: "later",
    item: { type: "assistant_message" as const, text: randomBytes(4096).toString("hex") },
  };
  expect(() => store.put(large)).toThrow();
  expect(store.get(handle)).toEqual(first);
  expect(store.stats().spilledRows).toBe(0);
  expect(store.stats().residentBytes).toBeLessThanOrEqual(512);
  vi.unstubAllEnvs();
  const recovered = store.put(large);
  expect(store.get(recovered)).toEqual(large);
  expect(store.get(handle)).toEqual(first);
});
