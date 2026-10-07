import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/index.js";
import { UsersRepo } from "../../src/db/repos/users.js";
import { DatabaseMemoryStore } from "../../src/memory/optmem/databaseStore.js";
import { Store } from "../helpers/optmemFileStore.js";
import { runMemo } from "../../src/memory/optmem/index.js";
import { DEFAULT_MEMORY_SIZES } from "../../src/memory/optmem/settings.js";
import { initializeUserMemory } from "../../src/memory/userMemory.js";
import { recallInWorker } from "../../src/memory/optmem/recall.js";
import { deferred } from "../helpers/async.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(postgres: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "optmem-db-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  let url = `sqlite:${directory}/app.db`;
  if (postgres) {
    const admin = createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! });
    const schema = `memory_${randomUUID().replaceAll("-", "")}`;
    await admin.db.execute(sql.raw(`create schema ${schema}`));
    cleanup.push(async () => { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); });
    const parsed = new URL(process.env.TEST_POSTGRES_URL!);
    parsed.searchParams.set("options", `-c search_path=${schema}`);
    url = parsed.toString();
  }
  const db = createDatabase({ DB_URL: url });
  cleanup.push(() => db.destroy());
  await db.initialize();
  const users = new UsersRepo(db.db);
  await users.ensure({ tgId: 42 }); await users.ensure({ tgId: 43 });
  const store = new DatabaseMemoryStore(db.db, 42);
  await store.initialize();
  const settings = { ...DEFAULT_MEMORY_SIZES };
  const now = new Date(2026, 9, 7, 12);
  const run = (...args: string[]) => runMemo({ store, settings, now, args });
  return { directory, url, db, users, store, settings, now, run };
}

for (const postgres of [false, true]) describe.skipIf(postgres && !process.env.TEST_POSTGRES_URL)(`OptMem ${postgres ? "PostgreSQL" : "SQLite"}`, () => {
  it("preserves command transcripts, tree order, paging, recall and forget against upstream-format storage", async () => {
    const { directory, store, settings, now, run } = await fixture(postgres);
    const original = new Store(path.join(directory, "reference"), "memo");
    await original.initialize();
    const compare = async (...args: string[]) => {
      const result = await run(...args);
      expect(result).toEqual(await runMemo({ store: original, settings, now, args }));
      return result;
    };
    expect((await compare("note", "first fact")).stdout).toBe("Saved as #0.\n");
    await compare("note", "second fact");
    expect((await compare("nap", "0-1", "both facts")).stdout).toBe("0-1 saved.\nNothing left to compress.\n");
    const entries = Array.from({ length: 126 }, (_, i) => ["2026-10-07", `event ${i}, café\u0000BOM\ufeff`] as const);
    await store.append(entries); await original.append(entries);
    settings.WAKE_LINES = 8; settings.PART_LINES = 2;
    await compare("wake");
    let result = await compare("nap");
    for (let i = 0; i < 127; i++) {
      const block = /^Run: memo nap (\d+-\d+) /mu.exec(result.stdout)?.[1];
      if (!block) break;
      result = await compare("nap", block, `summary ${block}`);
    }
    expect(result.stdout).toContain("Nothing left to compress.");
    for (let part = 1; part <= 4; part++) await compare("wake", String(part), "128");
    await compare("zoom", "0-63");
    await compare("recall", "CAFÉ");
    expect(await recallInWorker({ store, settings }, "CAFÉ")).toEqual(await run("recall", "CAFÉ"));
    await compare("forget", "16-31"); await compare("nap");
    expect(await store.slice(0, 128)).toEqual(await original.slice(0, 128));
  }, 30000);

  it("isolates owners, persists disable, blocks stale writers and keeps notes for re-enable", async () => {
    const { store, db, users, run, url } = await fixture(postgres);
    await run("note", "private fact");
    const other = new DatabaseMemoryStore(db.db, 43);
    await other.initialize();
    expect(await runMemo({ store: other, args: ["recall", "private"] })).toMatchObject({ stdout: "No match.\n" });
    await users.setMemoryEnabled(42, false);
    for (const args of [["note", "blocked"], ["wake"], ["recall", "fact"], ["config"], ["nap"], ["forget", "0-1"], ["init"]]) {
      expect(await run(...args)).toMatchObject({ exit_code: 1, stderr: expect.stringContaining("disabled") });
    }
    const reopened = createDatabase({ DB_URL: url }); cleanup.push(() => reopened.destroy());
    await reopened.initialize();
    expect((await new UsersRepo(reopened.db).get(42))?.memory_enabled).toBe(0);
    expect((await new UsersRepo(reopened.db).get(43))?.memory_enabled).toBe(1);
    await users.ensure({ tgId: 42, firstName: "Updated" });
    expect((await users.get(42))?.memory_enabled).toBe(0);
    await users.setMemoryEnabled(42, true);
    expect(await store.slice(0, 10)).toEqual([[0, "2026-10-07", "private fact"]]);
    expect((await run("config", "WAKE_LINES=1")).stderr).toContain("global and read-only");
  });

  it("assigns unique IDs across independent connections and rolls back a failed append", async () => {
    const { store, url } = await fixture(postgres);
    const contender = createDatabase({ DB_URL: url }); cleanup.push(() => contender.destroy());
    const other = new DatabaseMemoryStore(contender.db, 42);
    const ids = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? store : other).append([["2026-10-07", `note ${i}`]])));
    expect(ids.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    await expect(store.append([["2026-10-07", "must roll back"], ["2026-10-07", "x".repeat(400)]])).rejects.toThrow("Too long");
    expect(await store.length()).toBe(16);
    expect(await store.slice(16, 18)).toEqual([]);
    expect((await Promise.all([store.put(0, 2, "first"), other.put(0, 2, "second")])).sort()).toEqual([false, true]);
  });

  it("checks the off switch after waiting for a write transaction", async () => {
    const { db, store, users } = await fixture(postgres);
    const ready = deferred<void>(), release = deferred<void>();
    const disabled = db.db.transaction(async tx => {
      await new UsersRepo(tx).setMemoryEnabled(42, false);
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const write = store.append([["2026-10-07", "queued"]]);
    const rejected = expect(write).rejects.toThrow("disabled");
    release.resolve();
    await disabled;
    await rejected;
    await users.setMemoryEnabled(42, true);
    expect(await store.length()).toBe(0);
  });

  it.each([
    { concurrentDate: "2026-10-08", accepted: false },
    { concurrentDate: "2026-10-07", accepted: true },
    { concurrentDate: "2026-10-06", accepted: true },
    { concurrentDate: "𝟚𝟘𝟚𝟞-10-07", accepted: false },
  ])("rechecks import dates after a concurrent note dated $concurrentDate", async ({ concurrentDate, accepted }) => {
    const { directory, db, store } = await fixture(postgres);
    const file = path.join(directory, "import.txt");
    await fs.writeFile(file, "2026-10-07 historical note\n2026-10-09 second imported note\n");
    const ready = deferred<void>(), release = deferred<void>();
    class PausedImporter extends DatabaseMemoryStore {
      override async append(...args: Parameters<DatabaseMemoryStore["append"]>): Promise<number> {
        ready.resolve();
        await release.promise;
        return super.append(...args);
      }
    }
    const pending = runMemo({ store: new PausedImporter(db.db, 42), args: ["import", file] });
    await ready.promise;
    try {
      await store.append([[concurrentDate, "concurrent note"]]);
    } finally { release.resolve(); }
    const result = await pending;
    if (accepted) {
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("Imported 2 memories, #1 to #2.");
      expect(await store.slice(0, 4)).toEqual([
        [0, concurrentDate, "concurrent note"],
        [1, "2026-10-07", "historical note"],
        [2, "2026-10-09", "second imported note"],
      ]);
    } else {
      expect(result).toMatchObject({ exit_code: 1, stderr: expect.stringContaining(`precedes the previous memory (${concurrentDate})`) });
      expect(await store.slice(0, 4)).toEqual([[0, concurrentDate, "concurrent note"]]);
      expect(await store.length()).toBe(1);
    }
  });

  it("initializes an empty database memory once and preserves existing notes and summaries", async () => {
    const { db } = await fixture(postgres);
    const store = new DatabaseMemoryStore(db.db, 43);
    await Promise.all([initializeUserMemory(db.db, 43), initializeUserMemory(db.db, 43)]);
    expect(await store.length()).toBe(0);
    await store.append([["2026-10-07", "one"], ["2026-10-07", "two"]]);
    await store.put(0, 2, "both notes");
    await initializeUserMemory(db.db, 43);
    expect(await store.slice(0, 2)).toEqual([[0, "2026-10-07", "one"], [1, "2026-10-07", "two"]]);
    expect(await store.summary(0, 2)).toBe("both notes");
  });

  it("uses the database in the operator CLI and prints usable continuations", async () => {
    const { directory, url, store } = await fixture(postgres);
    const cli = path.resolve("src/memory/optmem/cli.ts");
    const env = { ...process.env, DB_URL: url, PI_CODING_AGENT_DIR: directory, OPTMEM_ENTRY_CHARS: "280" };
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => exec(process.execPath, [cli, "--user", "42", "note", `cli ${i}`], { env })));
    expect(results.map(result => Number(/Saved as #(\d+)/u.exec(result.stdout)?.[1])).sort()).toEqual([0, 1, 2, 3]);
    const result = await exec(process.execPath, [cli, "--user", "42", "nap"], { env });
    const order = result.stdout.split("\n").find(line => line.startsWith("Run: "))!;
    const obeyed = await exec("/bin/sh", ["-c", order.slice(5).replace('"<your line>"', '"cli pair"')], { env: { ...env, PATH: "" } });
    expect(obeyed.stdout).toContain("0-1 saved.");
    expect(await store.summary(0, 2)).toBe("cli pair");
    await expect(fs.stat(path.join(directory, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);
});
