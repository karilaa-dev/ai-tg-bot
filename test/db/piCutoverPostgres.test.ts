import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";

const postgresUrl = process.env.TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("Pi cutover migration on PostgreSQL", () => {
  let admin: AppDatabase;
  let db: AppDatabase;
  let schemaUrl: string;
  const schema = `pi_cutover_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    admin = createDatabase(loadTestConfig({ DB_URL: postgresUrl! }));
    await admin.db.execute(sql.raw(`create schema ${schema}`));
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    schemaUrl = url.toString();
    db = createDatabase(loadTestConfig({ DB_URL: schemaUrl }));
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await admin?.destroy();
  });

  it("preserves user settings, removes legacy conversations and invites, and is idempotent", async () => {
    for (const statement of legacyPostgresStatements()) await db.db.execute(sql.raw(statement));
    const contender = createDatabase(loadTestConfig({ DB_URL: schemaUrl }));
    const results = await Promise.all([db.migrate(), contender.migrate()]);
    await contender.destroy();
    const first = results.find((result) => result.piCutoverApplied);
    expect(results.filter((result) => result.piCutoverApplied)).toHaveLength(1);
    expect(results.filter((result) => !result.piCutoverApplied)).toHaveLength(1);
    expect(results.filter((result) => result.inviteRemovalApplied)).toHaveLength(1);
    expect(first).toBeDefined();
    if (!first) throw new Error("No PostgreSQL cutover contender applied the migration.");
    expect(first.piCutoverApplied).toBe(true);
    expect(first.deletedRows).toMatchObject({ threads: 1, messages: 1, files: 1, summaries: 1 });
    expect(await count("users")).toBe(1);
    expect(await tableExists("invites")).toBe(false);
    expect(await columnExists("users", "invited_with")).toBe(false);
    expect((await db.db.query<{ lang: string; tz_offset_min: number; stream_mode: number }>(
      sql.raw("select lang, tz_offset_min, stream_mode from users where tg_id = 42"),
    ))[0]).toEqual({ lang: "en", tz_offset_min: 120, stream_mode: 0 });
    expect(await count("threads")).toBe(0);
    expect(await count("messages")).toBe(0);
    expect(await tableExists("summaries")).toBe(false);
    expect(await columnExists("threads", "pi_session_file")).toBe(true);
    expect(await columnExists("threads", "meta_summary")).toBe(false);
    expect(await columnNullable("files", "path")).toBe(true);
    expect(await db.migrate()).toEqual({
      piCutoverApplied: false,
      deletedRows: {},
      fileSourcesApplied: false,
      migratedFileSources: 0,
      inviteRemovalApplied: false,
    });
  });

  async function count(table: string): Promise<number> {
    const rows = await db.db.query<{ count: number }>(sql.raw(`select count(*) as count from ${table}`));
    return Number(rows[0]?.count ?? 0);
  }

  async function tableExists(table: string): Promise<boolean> {
    const rows = await db.db.query<{ exists: boolean }>(sql`
      select exists(
        select 1 from information_schema.tables
        where table_schema = ${schema} and table_name = ${table}
      ) as exists
    `);
    return Boolean(rows[0]?.exists);
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await db.db.query<{ count: number }>(sql`
      select count(*) as count from information_schema.columns
      where table_schema = ${schema} and table_name = ${table} and column_name = ${column}
    `);
    return Number(rows[0]?.count ?? 0) > 0;
  }

  async function columnNullable(table: string, column: string): Promise<boolean> {
    const rows = await db.db.query<{ is_nullable: string }>(sql`
      select is_nullable from information_schema.columns
      where table_schema = ${schema} and table_name = ${table} and column_name = ${column}
    `);
    return rows[0]?.is_nullable === "YES";
  }
});

function legacyPostgresStatements(): string[] {
  return [
    `create table users (tg_id bigint primary key, first_name text, username text, lang text not null, tz_offset_min integer, stream_mode integer not null, invited_with text, created_at bigint not null)`,
    `create table invites (code text primary key, max_uses integer not null, used_count integer not null, expires_at bigint, revoked integer not null, created_by bigint not null, created_at bigint not null)`,
    `create table threads (id bigserial primary key, user_id bigint not null, topic_id integer, parent_thread_id bigint, fork_point_message_id bigint, title text not null, meta_summary text, compacted_upto_message_id bigint, archived integer not null, created_at bigint not null)`,
    `create table messages (id bigserial primary key, thread_id bigint not null, role text not null, kind text not null, content_json text not null, text_plain text not null, thinking text, tg_message_id bigint, tokens_est integer, created_at bigint not null)`,
    `create table files (id bigserial primary key, user_id bigint not null, thread_id bigint not null, message_id bigint, type text not null, name text not null, path text not null, size integer not null, content_md text, summary text, outline_json text, is_inline integer not null, created_at bigint not null)`,
    `create table file_chunks (id bigserial primary key, file_id bigint not null, idx integer not null, heading_path text, content text not null, created_at bigint not null)`,
    `create table embeddings (id bigserial primary key, kind text not null, ref_id bigint not null, dim integer not null, vector bytea not null, created_at bigint not null)`,
    `create table summaries (id bigserial primary key, thread_id bigint not null, level integer not null, from_message_id bigint, to_message_id bigint, content text not null, created_at bigint not null)`,
    `insert into users values (42, 'Legacy', 'legacy', 'en', 120, 0, 'KEEP-ME', 1)`,
    `insert into invites values ('KEEP-ME', 2, 1, null, 0, 42, 1)`,
    `insert into threads values (1, 42, null, null, null, 'Legacy thread', 'old summary', 1, 0, 1)`,
    `insert into messages values (1, 1, 'user', 'text', '{}', 'legacy message', null, 100, 10, 1)`,
    `insert into files values (1, 42, 1, 1, 'image', 'old.png', '/tmp/old.png', 3, null, 'old image', null, 0, 1)`,
    `insert into file_chunks values (1, 1, 0, null, 'legacy chunk', 1)`,
    `insert into embeddings values (1, 'summary', 1, 1, decode('00000000', 'hex'), 1)`,
    `insert into summaries values (1, 1, 0, 1, 1, 'legacy summary', 1)`,
  ];
}
