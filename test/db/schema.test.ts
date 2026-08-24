import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";

const CURRENT_TABLES = [
  "browser_use_profiles",
  "chunks_fts",
  "embeddings",
  "file_chunks",
  "file_sources",
  "files",
  "message_files",
  "messages",
  "messages_fts",
  "sandbox_file_restore_status",
  "telegram_file_refs",
  "thread_sandboxes",
  "threads",
  "users",
];

describe("SQLite schema initialization", () => {
  let database: AppDatabase | undefined;

  afterEach(async () => {
    await database?.destroy();
  });

  it("creates only the current schema and preserves current data when repeated", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));

    await database.initialize();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42, firstName: "Current", lang: "en" });
    await database.initialize();

    const tables = await database.db.query<{ name: string }>(sql`
      select name
      from sqlite_master
      where type = 'table' and name not like 'sqlite_%' and name not like '%_fts_%'
      order by name
    `);
    expect(tables.map((row) => row.name)).toEqual(CURRENT_TABLES);
    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users`)).toEqual([{ tg_id: 42 }]);
    expect(await tableExists(database, "schema_migrations")).toBe(false);
    expect(await tableExists(database, "invites")).toBe(false);
    expect(await tableExists(database, "summaries")).toBe(false);
  });

  it("creates the exact current columns", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();

    await expect(columns(database, "users")).resolves.toEqual([
      "tg_id", "first_name", "username", "lang", "tz_offset_min", "stream_mode", "created_at",
    ]);
    await expect(columns(database, "threads")).resolves.toEqual([
      "id", "user_id", "topic_id", "parent_thread_id", "fork_point_message_id", "title",
      "title_source", "title_attempts", "topic_title_synced", "pi_session_file", "pi_session_id",
      "archived", "created_at",
    ]);
    await expect(columns(database, "messages")).resolves.toEqual([
      "id", "thread_id", "role", "kind", "content_json", "text_plain", "thinking",
      "tg_message_id", "pi_entry_id", "created_at",
    ]);
    await expect(columns(database, "files")).resolves.toEqual([
      "id", "user_id", "thread_id", "message_id", "type", "content_sha256", "mime_type",
      "extraction_status", "name", "size", "content_md", "summary", "outline_json",
      "is_inline", "created_at",
    ]);
    await expect(columns(database, "thread_sandboxes")).resolves.toEqual([
      "deployment_id", "user_id", "thread_id", "sandbox_id", "created_at", "updated_at",
    ]);
    await expect(columns(database, "browser_use_profiles")).resolves.toEqual([
      "deployment_id", "user_id", "provider_user_key", "profile_id", "created_at", "updated_at",
    ]);
    await expect(columns(database, "telegram_file_refs")).resolves.toEqual([
      "id", "file_id", "telegram_file_id", "telegram_file_unique_id", "direction",
      "media_kind", "telegram_message_id", "width", "height", "telegram_size",
      "is_primary", "first_seen_at", "last_seen_at",
    ]);
    await expect(columns(database, "sandbox_file_restore_status")).resolves.toEqual([
      "deployment_id", "thread_id", "sandbox_id", "file_id", "telegram_file_ref_id",
      "sandbox_name", "status", "restored_size", "restored_sha256", "error_code",
      "error_detail", "attempted_at", "completed_at",
    ]);
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

async function tableExists(database: AppDatabase, table: string): Promise<boolean> {
  const rows = await database.db.query<{ name: string }>(sql`
    select name from sqlite_master where type = 'table' and name = ${table}
  `);
  return rows.length > 0;
}

async function columns(database: AppDatabase, table: string): Promise<string[]> {
  const rows = await database.db.query<{ name: string }>(sql.raw(`pragma table_info(${table})`));
  return rows.map((row) => row.name);
}
