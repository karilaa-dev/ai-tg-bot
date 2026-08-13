import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";

const postgresUrl = process.env.TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("PostgreSQL schema initialization", () => {
  let admin: AppDatabase;
  let database: AppDatabase;
  let schema: string;

  beforeAll(async () => {
    schema = `current_schema_${randomUUID().replaceAll("-", "")}`;
    admin = createDatabase(loadTestConfig({ DB_URL: postgresUrl! }));
    await admin.db.execute(sql.raw(`create schema ${schema}`));
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    database = createDatabase(loadTestConfig({ DB_URL: url.toString() }));
  });

  afterAll(async () => {
    await database?.destroy();
    await admin?.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await admin?.destroy();
  });

  it("serializes concurrent initialization and preserves current data", async () => {
    const contender = createDatabase(loadTestConfig({ DB_URL: databaseUrl(database) }));
    await Promise.all([database.initialize(), contender.initialize()]);
    await contender.destroy();

    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42, firstName: "Current", lang: "en" });
    await database.initialize();

    expect(await tableExists("users")).toBe(true);
    expect(await tableExists("message_search")).toBe(true);
    expect(await tableExists("chunk_search")).toBe(true);
    expect(await tableExists("schema_migrations")).toBe(false);
    expect(await tableExists("invites")).toBe(false);
    expect(await tableExists("summaries")).toBe(false);
    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users`)).toEqual([{ tg_id: 42 }]);
  });

  it("migrates latest-main history and Telegram locators without changing durable rows", async () => {
    const legacySchema = `legacy_schema_${randomUUID().replaceAll("-", "")}`;
    await admin.db.execute(sql.raw(`create schema ${legacySchema}`));
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${legacySchema}`);
    const legacy = createDatabase(loadTestConfig({ DB_URL: url.toString() }));
    try {
      for (const statement of [
        `create table users (
          tg_id bigint primary key, first_name text, username text, lang text not null default 'en',
          tz_offset_min integer, stream_mode integer not null default 1, created_at bigint not null
        )`,
        `create table threads (
          id bigserial primary key, user_id bigint not null references users(tg_id), topic_id integer,
          parent_thread_id bigint, fork_point_message_id bigint, title text not null,
          title_source text not null default 'explicit', title_attempts integer not null default 0,
          topic_title_synced integer not null default 1, pi_session_file text, pi_session_id text,
          archived integer not null default 0, created_at bigint not null
        )`,
        `create table messages (
          id bigserial primary key, thread_id bigint not null references threads(id), role text not null,
          kind text not null, content_json text not null, text_plain text not null, thinking text,
          tg_message_id bigint, pi_entry_id text, created_at bigint not null
        )`,
        `create table files (
          id bigserial primary key, user_id bigint not null references users(tg_id),
          thread_id bigint not null references threads(id), message_id bigint, type text not null,
          content_sha256 text, mime_type text, extraction_status text not null default 'ready',
          name text not null, path text, size integer not null, content_md text, summary text,
          outline_json text, is_inline integer not null, created_at bigint not null
        )`,
        `create table file_sources (
          id bigserial primary key, file_id bigint not null references files(id) on delete cascade,
          transport text not null, connection_key text not null, remote_key text not null,
          locator_json text not null, mime_type text, last_verified_at bigint, created_at bigint not null
        )`,
      ]) await legacy.db.execute(sql.raw(statement));
      await legacy.db.execute(sql`
        insert into users(tg_id, first_name, lang, created_at) values (73, 'Legacy', 'en', 1)
      `);
      await legacy.db.execute(sql`
        insert into threads(id, user_id, title, pi_session_file, pi_session_id, created_at)
        values (73, 73, 'Preserved', '/app/data/pi/sessions/telegram/preserved.jsonl', 'session-73', 1)
      `);
      await legacy.db.execute(sql`
        insert into messages(id, thread_id, role, kind, content_json, text_plain, tg_message_id, pi_entry_id, created_at)
        values (73, 73, 'user', 'file', '{"text":"preserve me"}', 'preserve me', 7300, 'entry-73', 2)
      `);
      await legacy.db.execute(sql`
        insert into files(id, user_id, thread_id, message_id, type, name, path, size, content_md, is_inline, created_at)
        values (73, 73, 73, 73, 'txt', 'preserved.txt', '/old/73/content', 9, 'extracted', 1, 2)
      `);
      await legacy.db.execute(sql`
        insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at)
        values (73, 'telegram', 'default', 'unique-73',
          '{"file_id":"telegram-73","file_unique_id":"unique-73"}', 2)
      `);

      await legacy.initialize();
      await legacy.initialize();

      await expect(legacy.db.query<{ text_plain: string; pi_session_id: string }>(sql`
        select m.text_plain, t.pi_session_id from messages m join threads t on t.id = m.thread_id
      `)).resolves.toEqual([{ text_plain: "preserve me", pi_session_id: "session-73" }]);
      await expect(legacy.db.query<{ telegram_file_id: string }>(sql`
        select telegram_file_id from telegram_file_refs
      `)).resolves.toEqual([{ telegram_file_id: "telegram-73" }]);
      const fileColumns = await legacy.db.query<{ name: string }>(sql`
        select column_name as name from information_schema.columns
        where table_schema = current_schema() and table_name = 'files'
      `);
      expect(fileColumns.map((column) => column.name)).not.toContain("path");
    } finally {
      await legacy.destroy();
      await admin.db.execute(sql.raw(`drop schema if exists ${legacySchema} cascade`));
    }
  });

  async function tableExists(table: string): Promise<boolean> {
    const rows = await database.db.query<{ exists: boolean }>(sql`
      select exists(
        select 1 from information_schema.tables
        where table_schema = ${schema} and table_name = ${table}
      ) as exists
    `);
    return Boolean(rows[0]?.exists);
  }

  function databaseUrl(_database: AppDatabase): string {
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  }
});
