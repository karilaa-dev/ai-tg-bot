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
      values (1, 7, 'Cascade', 1)
    `);
    await database.db.execute(sql`
      insert into files(id, user_id, thread_id, type, name, size, is_inline, created_at)
      values (1, 7, 1, 'txt', 'cascade.txt', 1, 0, 1)
    `);
    await database.db.execute(sql`
      insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
      values (1, 'test', 'default', 'cascade-source', '{}', 1)
    `);

    await database.db.execute(sql`delete from files where id = 1`);

    await expect(database.db.query<{ count: number }>(sql`select count(*) as count from file_sources`))
      .resolves.toEqual([{ count: 0 }]);
  });
});
