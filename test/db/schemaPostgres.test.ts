import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createUpgradeAuditManifest, verifyUpgradeAuditManifest } from "../../src/upgrade/audit.js";

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
    const piDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-postgres-audit-"));
    const sessionFile = path.join(piDir, "sessions", "telegram", "preserved.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, '{"role":"user","content":"preserve me"}\n');
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
        `create table file_chunks (
          id bigserial primary key, file_id bigint not null references files(id), idx integer not null,
          heading_path text, content text not null, created_at bigint not null
        )`,
        `create table message_files (
          message_id bigint not null references messages(id) on delete cascade,
          file_id bigint not null references files(id) on delete cascade,
          display_name text, caption text, created_at bigint not null, primary key(message_id, file_id)
        )`,
        `create table embeddings (
          id bigserial primary key, kind text not null, ref_id bigint not null, model text,
          dim integer not null, vector bytea not null, created_at bigint not null
        )`,
        `create table browser_use_profiles (
          deployment_id text not null, user_id bigint not null references users(tg_id) on delete cascade,
          provider_user_key text not null unique, profile_id text, created_at bigint not null,
          updated_at bigint not null, primary key(deployment_id, user_id)
        )`,
        `create table message_search (
          message_id bigint primary key references messages(id) on delete cascade,
          thread_id bigint not null, text text not null, ts tsvector not null
        )`,
        `create table chunk_search (
          chunk_id bigint primary key references file_chunks(id) on delete cascade,
          file_id bigint not null, text text not null, ts tsvector not null
        )`,
      ]) await legacy.db.execute(sql.raw(statement));
      await legacy.db.execute(sql`
        insert into users(tg_id, first_name, lang, created_at) values (73, 'Legacy', 'en', 1)
      `);
      await legacy.db.execute(sql`
        insert into threads(id, user_id, title, pi_session_file, pi_session_id, created_at)
        values (73, 73, 'Preserved', ${sessionFile}, 'session-73', 1)
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
      await legacy.db.execute(sql`
        insert into file_chunks(id, file_id, idx, content, created_at)
        values (73, 73, 0, 'indexed attachment', 2)
      `);
      await legacy.db.execute(sql`
        insert into message_files(message_id, file_id, display_name, caption, created_at)
        values (73, 73, 'preserved.txt', 'attachment', 2)
      `);
      await legacy.db.execute(sql`
        insert into embeddings(id, kind, ref_id, model, dim, vector, created_at)
        values (73, 'chunk', 73, 'legacy-embedding', 2, ${Buffer.from([0, 0, 128, 63, 0, 0, 0, 0])}, 2)
      `);
      await legacy.db.execute(sql`
        insert into message_search(message_id, thread_id, text, ts)
        values (73, 73, 'preserve me', to_tsvector('simple', 'preserve me'))
      `);
      await legacy.db.execute(sql`
        insert into chunk_search(chunk_id, file_id, text, ts)
        values (73, 73, 'indexed attachment', to_tsvector('simple', 'indexed attachment'))
      `);
      await legacy.db.execute(sql`
        insert into browser_use_profiles(deployment_id, user_id, provider_user_key, profile_id, created_at, updated_at)
        values ('legacy', 73, 'browser-user-73', 'browser-profile-73', 2, 2)
      `);
      for (const table of ["threads", "messages", "files", "file_chunks", "embeddings"]) {
        await legacy.db.execute(sql.raw(
          `select setval(pg_get_serial_sequence('${table}', 'id'), (select max(id) from ${table}), true)`,
        ));
      }

      const manifest = await createUpgradeAuditManifest(legacy.db, piDir);
      expect(manifest.datasets.messageSearch.count).toBe(1);
      expect(manifest.datasets.chunkSearch.count).toBe(1);
      expect(manifest.datasets.embeddings.count).toBe(1);
      expect(manifest.datasets.browserUseProfiles.count).toBe(1);
      expect(manifest.datasets.postgresSequences.count).toBe(6);

      await legacy.initialize();
      await legacy.initialize();

      await expect(verifyUpgradeAuditManifest(legacy.db, piDir, manifest)).resolves.toMatchObject({
        datasets: {
          messageSearch: 1,
          chunkSearch: 1,
          embeddings: 1,
          browserUseProfiles: 1,
          postgresSequences: 6,
        },
      });

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

      await legacy.db.execute(sql`select setval(pg_get_serial_sequence('threads', 'id'), 1, false)`);
      await expect(verifyUpgradeAuditManifest(legacy.db, piDir, manifest))
        .rejects.toThrow("unsafe PostgreSQL sequence");
      await legacy.db.execute(sql`select setval(pg_get_serial_sequence('threads', 'id'), 73, true)`);

      await legacy.db.execute(sql`delete from message_search`);
      await expect(verifyUpgradeAuditManifest(legacy.db, piDir, manifest))
        .rejects.toThrow("messageSearch count fell");
    } finally {
      await legacy.destroy();
      await admin.db.execute(sql.raw(`drop schema if exists ${legacySchema} cascade`));
      await fs.rm(piDir, { recursive: true, force: true });
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
