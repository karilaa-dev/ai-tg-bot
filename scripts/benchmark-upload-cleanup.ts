import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Measures how upload cleanup scales with the size of the attachment directory.
// Usage: bun scripts/benchmark-upload-cleanup.ts [checkout] [--entries 1000,10000,50000] [--batch 25]
// For each storage size it revokes one recovery batch of abandoned keys (each with a stranded staging copy)
// through the checkout's LocalFileStore, and separately times the directory listings that cleanup performs.
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const root = path.resolve(args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--")) ?? process.cwd());
const sizes = (option("--entries") ?? "1000,10000,50000").split(",").map(Number);
const batch = Number(option("--batch") ?? 25);
const { LocalFileStore }: typeof import("../src/files/localStore.js") =
  await import(pathToFileURL(path.join(root, "src/files/localStore.ts")).href);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results = [];
for (const entries of sizes) {
  const runs: Array<{ revokeMs: number; listingMs: number; listings: number }> = [];
  for (let run = 0; run < 3; run++) {
    const directory = await mkdtemp(path.join(tmpdir(), "upload-cleanup-bench-"));
    try {
      // Unrelated accepted attachments in the same flat directory.
      for (let start = 0; start < entries; start += 500) {
        await Promise.all(Array.from({ length: Math.min(500, entries - start) }, () => writeFile(path.join(directory, randomUUID()), "x")));
      }
      const keys = Array.from({ length: batch }, () => randomUUID());
      for (const key of keys) {
        await writeFile(path.join(directory, key), "abandoned");
        await writeFile(path.join(directory, `${key}.${randomUUID()}.tmp`), "stranded staging copy");
      }
      const store = new LocalFileStore(directory);
      const revoke = "revokeMany" in store && typeof store.revokeMany === "function"
        ? (all: string[]) => (store.revokeMany as (keys: string[]) => Promise<unknown>)(all)
        : async (all: string[]) => { for (const key of all) await store.revoke(key); };
      let started = performance.now();
      await revoke(keys);
      const revokeMs = performance.now() - started;
      const left = (await readdir(directory)).filter((name) => name.endsWith(".tmp")).length;
      if (left) throw new Error(`${left} staging copies were not removed.`);
      // The listing cost cleanup pays: one full directory read per key before, one per batch after batching.
      const listings = "revokeMany" in store ? 1 : batch;
      started = performance.now();
      for (let index = 0; index < listings; index++) await readdir(directory);
      runs.push({ revokeMs, listingMs: performance.now() - started, listings });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const revokeMs = median(runs.map((run) => run.revokeMs));
  const listingMs = median(runs.map((run) => run.listingMs));
  results.push({ entries, batch, directoryListings: runs[0]!.listings, revokeBatchMs: Number(revokeMs.toFixed(1)),
    listingMs: Number(listingMs.toFixed(1)), listingShare: Number((listingMs / revokeMs).toFixed(2)), runs });
}
process.stdout.write(`${JSON.stringify({ checkout: path.basename(root), runtime: `bun ${Bun.version}`, filesystem: tmpdir(), results }, null, 2)}\n`);
