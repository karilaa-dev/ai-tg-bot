import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";

describe("SQLite schema initialization", () => {
  let database: AppDatabase | undefined;

  afterEach(async () => {
    await database?.destroy();
  });

  it("preserves current data when initialization is repeated", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));

    await database.initialize();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42, firstName: "Current", lang: "en" });
    await database.initialize();

    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users`)).toEqual([{ tg_id: 42 }]);
  });

  it("creates upload recovery storage once and keeps its rows when initialization is repeated", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    await database.db.execute(sql`insert into web_upload_items(id, lease_id, user_id, kind, target, instance, created_at)
      values ('item', 'lease', 42, 'directory', 'chat-upload-0123456789abcdef01234567', 'volume', 1)`);
    await database.db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
      values ('cleanup', 'file', '00000000-0000-4000-8000-000000000001', 'volume', 2, 5, 1)`);
    await database.initialize();
    expect(await database.db.query(sql`select id, kind from web_upload_items`)).toEqual([{ id: "item", kind: "directory" }]);
    expect(await database.db.query(sql`select id, attempts from web_upload_cleanup`)).toEqual([{ id: "cleanup", attempts: 2 }]);
    // One record per artifact keeps concurrent reclaimers from queueing the same removal twice.
    await expect(database.db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
      values ('again', 'file', '00000000-0000-4000-8000-000000000001', 'volume', 0, 5, 1)`)).rejects.toThrow();
    await expect(database.db.execute(sql`insert into web_upload_items(id, lease_id, user_id, kind, target, instance, created_at)
      values ('bad', 'lease', 42, 'socket', 'x', 'volume', 1)`)).rejects.toThrow();
  });

  it("enables foreign keys and applies declared delete cascades", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();

    await expect(database.db.query<{ foreign_keys: number }>(sql`pragma foreign_keys`))
      .resolves.toEqual([{ foreign_keys: 1 }]);
    await database.db.execute(sql`
      insert into users(tg_id, first_name, lang, created_at)
      values (7, 'Cascade', 'en', 1)
    `);
    await database.db.execute(sql`
      insert into threads(id, user_id, title, created_at)
      values ('00000000-0000-4000-8000-000000000001', 7, 'Cascade', 1)
    `);
    await database.db.execute(sql`
      insert into files(id, user_id, thread_id, type, name, size, is_inline, created_at)
      values ('00000000-0000-4000-8000-000000000002', 7, '00000000-0000-4000-8000-000000000001', 'txt', 'cascade.txt', 1, 0, 1)
    `);
    await database.db.execute(sql`
      insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
      values ('00000000-0000-4000-8000-000000000002', 'test', 'default', 'cascade-source', '{}', 1)
    `);

    await database.db.execute(sql`delete from files where id = '00000000-0000-4000-8000-000000000002'`);

    await expect(database.db.query<{ count: number }>(sql`select count(*) as count from file_sources`))
      .resolves.toEqual([{ count: 0 }]);
  });
});
