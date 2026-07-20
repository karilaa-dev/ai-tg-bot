import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { clearManagedFiles } from "../../src/files/storage.js";

describe("Pi cutover migration", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("preserves users and invites while deleting legacy SQLite conversation state", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-cutover-"));
    db = createDatabase(loadTestConfig({ DB_URL: `sqlite:${path.join(tempDir, "legacy.db")}` }));
    await installLegacySchema(db);

    const first = await db.migrate();
    expect(first.piCutoverApplied).toBe(true);
    expect(first.fileSourcesApplied).toBe(true);
    expect(first.deletedRows).toMatchObject({ threads: 1, messages: 1, files: 1, file_chunks: 1, embeddings: 1, summaries: 1 });
    expect(await count(db, "users")).toBe(1);
    expect(await count(db, "invites")).toBe(1);
    expect(await count(db, "threads")).toBe(0);
    expect(await count(db, "messages")).toBe(0);
    expect(await count(db, "files")).toBe(0);
    expect(await count(db, "embeddings")).toBe(0);
    expect(await tableExists(db, "summaries")).toBe(false);
    expect(await tableExists(db, "summaries_fts")).toBe(false);
    const threadColumns = await columns(db, "threads");
    const messageColumns = await columns(db, "messages");
    const fileColumns = await db.db.query<{ name: string; notnull: number }>(sql.raw("pragma table_info(files)"));
    expect(threadColumns).toContain("pi_session_file");
    expect(threadColumns).not.toContain("meta_summary");
    expect(messageColumns).toContain("pi_entry_id");
    expect(messageColumns).not.toContain("tokens_est");
    expect(fileColumns.find((column) => column.name === "path")?.notnull).toBe(0);
    expect(fileColumns.map((column) => column.name)).not.toContain("telegram_file_id");
    expect(await tableExists(db, "file_sources")).toBe(true);

    const second = await db.migrate();
    expect(second).toEqual({
      piCutoverApplied: false,
      deletedRows: {},
      fileSourcesApplied: false,
      migratedFileSources: 0,
    });
    expect(await count(db, "users")).toBe(1);
    expect(await count(db, "invites")).toBe(1);
  });

  it("cleans only managed files and leaves just-bash workspaces untouched", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-files-"));
    const filesDir = path.join(tempDir, "files");
    const bashFile = path.join(tempDir, "bash", "thread-1", "notes.txt");
    await fs.mkdir(path.join(filesDir, "nested"), { recursive: true });
    await fs.mkdir(path.dirname(bashFile), { recursive: true });
    await fs.writeFile(path.join(filesDir, "one.png"), "one");
    await fs.writeFile(path.join(filesDir, "nested", "two.pdf"), "two");
    await fs.writeFile(bashFile, "keep");

    expect(await clearManagedFiles(filesDir)).toBe(2);
    expect(await fs.readdir(filesDir)).toEqual([]);
    expect(await fs.readFile(bashFile, "utf8")).toBe("keep");
  });

  it("backfills Telegram locators after the Pi cutover without deleting current conversations", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-source-backfill-"));
    db = createDatabase(loadTestConfig({ DB_URL: `sqlite:${path.join(tempDir, "legacy-sources.db")}` }));
    await installPiSchemaWithLegacyFileRefs(db);

    const result = await db.migrate();

    expect(result).toMatchObject({
      piCutoverApplied: false,
      fileSourcesApplied: true,
      migratedFileSources: 3,
    });
    expect(await count(db, "threads")).toBe(1);
    expect(await count(db, "messages")).toBe(1);
    expect(await count(db, "files")).toBe(2);
    const sources = await db.db.query<{
      transport: string;
      connection_key: string;
      remote_key: string;
      locator_json: string;
    }>(sql.raw("select transport, connection_key, remote_key, locator_json from file_sources order by remote_key"));
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.transport === "telegram" && source.connection_key === "default")).toBe(true);
    expect(sources.map((source) => source.remote_key)).toEqual(["legacy-unique-a", "legacy-unique-b", "telegram-file-c"]);
    expect(JSON.parse(sources[0]!.locator_json)).toMatchObject({ file_id: "telegram-file-a" });
    expect(JSON.parse(sources[1]!.locator_json)).toMatchObject({ file_id: "telegram-file-b" });
    expect(JSON.parse(sources[2]!.locator_json)).toMatchObject({ file_id: "telegram-file-c" });
    expect(await tableExists(db, "file_telegram_refs")).toBe(false);
    expect(await columns(db, "files")).not.toContain("telegram_file_id");
    expect((await db.migrate()).fileSourcesApplied).toBe(false);
  });

  it("rolls back the entire SQLite cutover when a destructive step fails", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-cutover-rollback-"));
    db = createDatabase(loadTestConfig({ DB_URL: `sqlite:${path.join(tempDir, "legacy.db")}` }));
    await installLegacySchema(db);
    await db.db.execute(sql.raw(`
      create trigger fail_pi_cutover before delete on messages
      begin
        select raise(abort, 'forced cutover failure');
      end
    `));

    await expect(db.migrate()).rejects.toThrow("delete from messages");
    expect(await count(db, "threads")).toBe(1);
    expect(await count(db, "messages")).toBe(1);
    expect(await count(db, "files")).toBe(1);
    expect(await tableExists(db, "summaries")).toBe(true);
    expect(await tableExists(db, "schema_migrations")).toBe(false);
    expect(await columns(db, "threads")).not.toContain("pi_session_file");

    await db.db.execute(sql.raw("drop trigger fail_pi_cutover"));
    expect((await db.migrate()).piCutoverApplied).toBe(true);
  });
});

async function installLegacySchema(database: AppDatabase): Promise<void> {
  const statements = [
    `create table users (tg_id integer primary key, first_name text, username text, lang text not null, tz_offset_min integer, stream_mode integer not null, invited_with text, created_at integer not null)`,
    `create table invites (code text primary key, max_uses integer not null, used_count integer not null, expires_at integer, revoked integer not null, created_by integer not null, created_at integer not null)`,
    `create table threads (id integer primary key autoincrement, user_id integer not null, topic_id integer, parent_thread_id integer, fork_point_message_id integer, title text not null, meta_summary text, compacted_upto_message_id integer, archived integer not null, created_at integer not null)`,
    `create table messages (id integer primary key autoincrement, thread_id integer not null, role text not null, kind text not null, content_json text not null, text_plain text not null, thinking text, tg_message_id integer, tokens_est integer, created_at integer not null)`,
    `create table files (id integer primary key autoincrement, user_id integer not null, thread_id integer not null, message_id integer, type text not null, name text not null, path text not null, size integer not null, content_md text, summary text, outline_json text, is_inline integer not null, created_at integer not null)`,
    `create table file_chunks (id integer primary key autoincrement, file_id integer not null, idx integer not null, heading_path text, content text not null, created_at integer not null)`,
    `create table embeddings (id integer primary key autoincrement, kind text not null, ref_id integer not null, dim integer not null, vector blob not null, created_at integer not null)`,
    `create table summaries (id integer primary key autoincrement, thread_id integer not null, level integer not null, from_message_id integer, to_message_id integer, content text not null, created_at integer not null)`,
    `create virtual table summaries_fts using fts5(text, summary_id unindexed, thread_id unindexed)`,
    `insert into users values (42, 'Legacy', 'legacy', 'en', null, 1, null, 1)`,
    `insert into invites values ('KEEP-ME', 2, 1, null, 0, 42, 1)`,
    `insert into threads values (1, 42, null, null, null, 'Legacy thread', 'old summary', 1, 0, 1)`,
    `insert into messages values (1, 1, 'user', 'text', '{}', 'legacy message', null, 100, 10, 1)`,
    `insert into files values (1, 42, 1, 1, 'image', 'old.png', '/tmp/old.png', 3, null, 'old image', null, 0, 1)`,
    `insert into file_chunks values (1, 1, 0, null, 'legacy chunk', 1)`,
    `insert into embeddings values (1, 'summary', 1, 1, x'00000000', 1)`,
    `insert into summaries values (1, 1, 0, 1, 1, 'legacy summary', 1)`,
    `insert into summaries_fts(text, summary_id, thread_id) values ('legacy summary', 1, 1)`,
  ];
  for (const statement of statements) await database.db.execute(sql.raw(statement));
}

async function installPiSchemaWithLegacyFileRefs(database: AppDatabase): Promise<void> {
  const statements = [
    `create table users (tg_id integer primary key, first_name text, username text, lang text not null, tz_offset_min integer, stream_mode integer not null, invited_with text, created_at integer not null)`,
    `create table invites (code text primary key, max_uses integer not null, used_count integer not null, expires_at integer, revoked integer not null, created_by integer not null, created_at integer not null)`,
    `create table threads (id integer primary key autoincrement, user_id integer not null, topic_id integer, parent_thread_id integer, fork_point_message_id integer, title text not null, pi_session_file text, pi_session_id text, archived integer not null, created_at integer not null)`,
    `create table messages (id integer primary key autoincrement, thread_id integer not null, role text not null, kind text not null, content_json text not null, text_plain text not null, thinking text, tg_message_id integer, pi_entry_id text, created_at integer not null)`,
    `create table files (id integer primary key autoincrement, user_id integer not null, thread_id integer not null, message_id integer, type text not null, content_sha256 text, mime_type text, telegram_file_id text, telegram_file_unique_id text, name text not null, path text, size integer not null, content_md text, summary text, outline_json text, is_inline integer not null, created_at integer not null)`,
    `create table file_telegram_refs (file_id integer not null, file_unique_id text not null, telegram_file_id text, created_at integer not null)`,
    `create table schema_migrations (name text primary key, applied_at integer not null)`,
    `insert into schema_migrations values ('pi_cutover_v2', 1)`,
    `insert into users values (44, 'Current', 'current', 'en', null, 1, null, 1)`,
    `insert into threads values (1, 44, null, null, null, 'Current thread', '/tmp/pi.jsonl', 'pi-session', 0, 1)`,
    `insert into messages values (1, 1, 'user', 'file', '{}', 'current file', null, 101, 'entry-1', 1)`,
    `insert into files values (1, 44, 1, 1, 'image', 'abc', 'image/png', 'telegram-file-a', 'legacy-unique-a', 'current.png', null, 3, null, 'current image', null, 1, 1)`,
    `insert into files values (2, 44, 1, null, 'image', 'def', 'image/jpeg', 'telegram-file-c', null, 'current-c.jpg', null, 3, null, 'current image c', null, 1, 2)`,
    `insert into file_telegram_refs values (1, 'legacy-unique-b', 'telegram-file-b', 2)`,
  ];
  for (const statement of statements) await database.db.execute(sql.raw(statement));
}

async function count(database: AppDatabase, table: string): Promise<number> {
  const rows = await database.db.query<{ count: number }>(sql.raw(`select count(*) as count from ${table}`));
  return Number(rows[0]?.count ?? 0);
}

async function tableExists(database: AppDatabase, table: string): Promise<boolean> {
  const rows = await database.db.query<{ name: string }>(sql`
    select name from sqlite_master where type in ('table', 'view') and name = ${table}
  `);
  return rows.length > 0;
}

async function columns(database: AppDatabase, table: string): Promise<string[]> {
  const rows = await database.db.query<{ name: string }>(sql.raw(`pragma table_info(${table})`));
  return rows.map((row) => row.name);
}
