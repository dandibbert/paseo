import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
// Isolated synthetic benchmark: no daemon, provider process, or user home is opened.
if (typeof global.gc !== "function") throw new Error("Run node with --expose-gc");
if (!process.argv[2]) throw new Error("Pass the timeline store source path");
const { InMemoryAgentTimelineStore } = await import(pathToFileURL(process.argv[2]));
const store = new InMemoryAgentTimelineStore();
store.initialize("agent", { epoch: "test" });
global.gc();
const initial = process.memoryUsage();
let seed = 123456789;
const count = Number(process.argv[3] ?? 20_000);
if (!Number.isSafeInteger(count) || count < 10 || count > 100_000)
  throw new Error("Row count must be 10..100000");
const samples = [];
for (let i = 0; i < count; i++) {
  const data = Buffer.allocUnsafe(4096);
  for (let j = 0; j < 4096; j += 4) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data.writeUInt32LE(seed >>> 0, j);
  }
  const text = data.toString("hex");
  const start = performance.now();
  store.append("agent", { type: "user_message", text });
  samples.push(performance.now() - start);
}
global.gc();
global.gc();
const memory = process.memoryUsage();
const beforeRead = store.getStorageStats?.();
const page = store.fetch("agent", { limit: 10 });
if (page.rows.length !== 10 || page.rows[0].seq !== count - 9) throw new Error("history mismatch");
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      count,
      rawPayloadMiB: (count * 8192) / 1048576,
      heapUsedMiB: memory.heapUsed / 1048576,
      heapGrowthMiB: (memory.heapUsed - initial.heapUsed) / 1048576,
      externalMiB: memory.external / 1048576,
      rssMiB: memory.rss / 1048576,
      appendP95Ms: samples[Math.floor(samples.length * 0.95)],
      beforeRead,
      afterRead: store.getStorageStats?.(),
    },
    null,
    2,
  ),
);
store.dispose?.();
