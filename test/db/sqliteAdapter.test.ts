import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";

describe("stable SQLite adapter", () => {
  let database: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await database?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("opens an existing node:sqlite file and preserves commit, rollback, WAL, and close behavior", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-sqlite-adapter-"));
    const sqlitePath = path.join(tempDir, "existing.db");
    const legacy = new DatabaseSync(sqlitePath);
    legacy.exec("create table legacy_marker(value text not null)");
    legacy.prepare("insert into legacy_marker(value) values (?)").run("preserved");
    legacy.close();

    database = createDatabase(loadTestConfig({ DB_URL: `sqlite:${sqlitePath}` }));
    await database.initialize();

    await expect(database.db.query<{ value: string }>(sql`select value from legacy_marker`))
      .resolves.toEqual([{ value: "preserved" }]);
    await expect(database.db.query<{ journal_mode: string }>(sql`pragma journal_mode`))
      .resolves.toEqual([{ journal_mode: "wal" }]);

    await database.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into users(tg_id, first_name, lang, created_at)
        values (101, 'Committed', 'en', 1)
      `);
    });
    await expect(database.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into users(tg_id, first_name, lang, created_at)
        values (102, 'Rolled back', 'en', 1)
      `);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    await expect(database.db.query<{ tg_id: number }>(sql`select tg_id from users order by tg_id`))
      .resolves.toEqual([{ tg_id: 101 }]);

    await database.destroy();
    database = undefined;
    const verifier = new DatabaseSync(sqlitePath, { readOnly: true });
    expect(verifier.prepare("select tg_id from users order by tg_id").all()).toEqual([{ tg_id: 101 }]);
    verifier.close();
  });

  it("serializes asynchronous transactions on the shared SQLite connection", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let secondEntered = false;
    const first = database.db.transaction(async (tx) => {
      firstStarted();
      await holdFirst;
      await tx.execute(sql`
        insert into users(tg_id, first_name, lang, created_at)
        values (201, 'First', 'en', 1)
      `);
    });
    await started;
    const second = database.db.transaction(async (tx) => {
      secondEntered = true;
      await tx.execute(sql`
        insert into users(tg_id, first_name, lang, created_at)
        values (202, 'Second', 'en', 1)
      `);
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users order by tg_id`))
      .toEqual([{ tg_id: 201 }, { tg_id: 202 }]);
  });
});
