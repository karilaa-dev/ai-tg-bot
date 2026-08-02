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

  it("backfills the current Telegram locator once while preserving future ID history", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    await database.db.execute(sql`
      insert into users(tg_id, first_name, lang, created_at)
      values (91, 'Backfill', 'en', 1)
    `);
    await database.db.execute(sql`
      insert into threads(id, user_id, title, created_at)
      values (91, 91, 'Backfill', 1)
    `);
    await database.db.execute(sql`
      insert into messages(id, thread_id, role, kind, content_json, text_plain, created_at)
      values (91, 91, 'assistant', 'file', '{}', '', 1)
    `);
    await database.db.execute(sql`
      insert into files(id, user_id, thread_id, message_id, type, mime_type, name, size, is_inline, created_at)
      values (91, 91, 91, 91, 'image', 'image/jpeg', 'photo.jpg', 10, 1, 1)
    `);
    await database.db.execute(sql`
      insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
      values (
        91, 'telegram', 'default', 'unique-photo',
        '{"file_id":"photo-id","file_unique_id":"unique-photo"}', 2
      )
    `);

    await database.initialize();
    await database.initialize();

    await expect(database.db.query<{
      telegram_file_id: string;
      telegram_file_unique_id: string;
      direction: string;
      media_kind: string;
      is_primary: number;
    }>(sql`select telegram_file_id, telegram_file_unique_id, direction, media_kind, is_primary from telegram_file_refs`))
      .resolves.toEqual([{
        telegram_file_id: "photo-id",
        telegram_file_unique_id: "unique-photo",
        direction: "outbound",
        media_kind: "photo",
        is_primary: 1,
      }]);
  });

  it("drops legacy host paths while preserving files with a durable source", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    await database.db.execute(sql`alter table files add column path text`);
    await database.db.execute(sql`
      insert into users(tg_id, first_name, lang, created_at)
      values (8, 'Legacy', 'en', 1)
    `);
    await database.db.execute(sql`
      insert into threads(id, user_id, title, created_at)
      values (8, 8, 'Legacy', 1)
    `);
    await database.db.execute(sql`
      insert into files(id, user_id, thread_id, type, name, path, size, is_inline, created_at)
      values
        (80, 8, 8, 'other', 'host-only.bin', '/old/host-only.bin', 4, 0, 1),
        (81, 8, 8, 'txt', 'telegram.txt', '/old/telegram.txt', 4, 1, 1)
    `);
    await database.db.execute(sql`
      insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
      values (81, 'telegram', 'default', 'telegram-81', '{}', 1)
    `);

    await database.initialize();

    await expect(columns(database, "files")).resolves.not.toContain("path");
    await expect(database.db.query<{ id: number }>(sql`select id from files order by id`))
      .resolves.toEqual([{ id: 81 }]);
  });

  it("drops obsolete E2B mapping metadata without losing sandbox ownership", async () => {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    await database.db.execute(sql`alter table thread_sandboxes add column template text`);
    await database.db.execute(sql`alter table thread_sandboxes add column layout_version integer`);
    await database.db.execute(sql`alter table thread_sandboxes add column continuous_started_at integer`);
    await database.db.execute(sql`
      insert into users(tg_id, first_name, lang, created_at)
      values (71, 'E2B upgrade', 'en', 1)
    `);
    await database.db.execute(sql`
      insert into threads(id, user_id, title, created_at)
      values (71, 71, 'E2B upgrade', 1)
    `);
    await database.db.execute(sql`
      insert into thread_sandboxes(
        deployment_id, user_id, thread_id, sandbox_id, created_at, updated_at,
        template, layout_version, continuous_started_at
      ) values ('deployment', 71, 71, 'sandbox-71', 1, 1, 'desktop', 1, 1)
    `);

    await database.initialize();

    await expect(columns(database, "thread_sandboxes")).resolves.toEqual([
      "deployment_id", "user_id", "thread_id", "sandbox_id", "created_at", "updated_at",
    ]);
    const repos = createRepos(database.db, database.search);
    await expect(repos.threadSandboxes.get("deployment", 71))
      .resolves.toMatchObject({ sandbox_id: "sandbox-71", user_id: 71, thread_id: 71 });
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
