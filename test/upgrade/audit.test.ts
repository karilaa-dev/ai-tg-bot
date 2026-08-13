import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import {
  createUpgradeAuditManifest,
  verifyUpgradeAuditManifest,
  verifyUpgradeBaselineOnce,
  writeUpgradeAuditManifest,
} from "../../src/upgrade/audit.js";

const CHAT_SECRET = "private migration conversation";
const TELEGRAM_FILE_ID = "BQAC-private-telegram-file-id";
const BROWSER_PROFILE_KEY = "private-browser-profile-user";

describe("upgrade preservation audit", () => {
  let tempDir: string;
  let piDir: string;
  let sessionFile: string;
  let database: AppDatabase;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-upgrade-audit-"));
    piDir = path.join(tempDir, "pi");
    sessionFile = path.join(piDir, "sessions", "telegram", "thread-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, `${JSON.stringify({ role: "user", content: CHAT_SECRET })}\n`);
    database = createDatabase(loadTestConfig({ DB_URL: `sqlite:${path.join(tempDir, "legacy.db")}` }));
    await createLatestMainSchema(database, sessionFile);
  });

  afterEach(async () => {
    await database?.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("snapshots latest-main without migration and verifies the migrated append-only state", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(CHAT_SECRET);
    expect(serialized).not.toContain(TELEGRAM_FILE_ID);
    expect(serialized).not.toContain(BROWSER_PROFILE_KEY);
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("778899");
    expect(manifest.datasets.messages.count).toBe(1);
    expect(manifest.datasets.telegramFileRefs.count).toBe(1);
    expect(manifest.datasets.messageSearch.count).toBe(1);
    expect(manifest.datasets.chunkSearch.count).toBe(1);
    expect(manifest.datasets.embeddings.count).toBe(1);
    expect(manifest.datasets.browserUseProfiles.count).toBe(1);
    expect(manifest.datasets.postgresSequences.count).toBe(0);
    expect(manifest.piSessions.count).toBe(1);

    await database.initialize();
    await fs.appendFile(sessionFile, `${JSON.stringify({ role: "assistant", content: "later" })}\n`);
    await database.db.execute(sql`
      insert into messages(thread_id, role, kind, content_json, text_plain, created_at)
      values (1, 'assistant', 'text', '{}', 'later', 3)
    `);

    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest)).resolves.toMatchObject({
      piSessions: 1,
      datasets: { messages: 1, telegramFileRefs: 1 },
    });
    await expect(columns(database, "files")).resolves.not.toContain("path");
  });

  it("rejects missing persisted lexical and embedding retrieval data", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    await database.initialize();

    await database.db.execute(sql`delete from messages_fts`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("messageSearch count fell");
    await database.db.execute(sql`
      insert into messages_fts(text, message_id, thread_id) values (${CHAT_SECRET}, 1, 1)
    `);

    await database.db.execute(sql`delete from chunks_fts`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("chunkSearch count fell");
    await database.db.execute(sql`
      insert into chunks_fts(text, chunk_id, file_id) values ('searchable content', 1, 1)
    `);

    await database.db.execute(sql`delete from embeddings`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("embeddings count fell");
  });

  it("rejects changed chat rows, missing Telegram references, and changed Pi prefixes", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    await database.initialize();

    await database.db.execute(sql`update messages set text_plain = 'changed' where id = 1`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("baseline messages record changed");

    await database.db.execute(sql`update messages set text_plain = ${CHAT_SECRET} where id = 1`);
    await database.db.execute(sql`update telegram_file_refs set is_primary = 0`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("baseline telegramFileRefs record changed");

    await database.db.execute(sql`update telegram_file_refs set is_primary = 1`);
    await database.db.execute(sql`delete from telegram_file_refs`);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("telegramFileRefs count fell");

    await database.initialize();
    const bytes = await fs.readFile(sessionFile);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    await fs.writeFile(sessionFile, bytes);
    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("Pi session prefix changed");
  });

  it("rejects missing Browser Use profile mappings", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    await database.initialize();
    await database.db.execute(sql`delete from browser_use_profiles`);

    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("browserUseProfiles count fell");
  });

  it("rejects malformed Telegram locators and missing referenced Pi sessions", async () => {
    await database.db.execute(sql`update file_sources set locator_json = '{bad-json' where id = 1`);
    await expect(createUpgradeAuditManifest(database.db, piDir)).rejects.toThrow("malformed locator JSON");

    await database.db.execute(sql`
      update file_sources
      set locator_json = ${JSON.stringify({ file_id: TELEGRAM_FILE_ID, file_unique_id: "unique-file" })}
      where id = 1
    `);
    await fs.unlink(sessionFile);
    await expect(createUpgradeAuditManifest(database.db, piDir)).rejects.toThrow("Pi session is missing");
  });

  it("rejects referenced Pi sessions reached through a directory symlink outside the Pi root", async () => {
    const outsideDir = path.join(tempDir, "outside-sessions");
    const linkedDir = path.join(piDir, "linked-sessions");
    const outsideFile = path.join(outsideDir, "outside.jsonl");
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsideFile, '{"role":"user","content":"outside"}\n');
    await fs.symlink(outsideDir, linkedDir, "dir");
    await database.db.execute(sql`
      update threads set pi_session_file = ${path.join(linkedDir, "outside.jsonl")} where id = 1
    `);

    await expect(createUpgradeAuditManifest(database.db, piDir))
      .rejects.toThrow("Referenced Pi session is missing or unsafe");
  });

  it("rejects verification when a Pi session directory is replaced by an escaping symlink", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    await database.initialize();
    const sessionDir = path.dirname(sessionFile);
    const savedSessionDir = path.join(path.dirname(sessionDir), "telegram-saved");
    const outsideDir = path.join(tempDir, "replacement-sessions");
    await fs.mkdir(outsideDir);
    await fs.copyFile(sessionFile, path.join(outsideDir, path.basename(sessionFile)));
    await fs.rename(sessionDir, savedSessionDir);
    await fs.symlink(outsideDir, sessionDir, "dir");

    await expect(verifyUpgradeAuditManifest(database.db, piDir, manifest))
      .rejects.toThrow("Preserved Pi session is missing or unsafe");
  });

  it("writes a hash-bound marker and skips only the already verified manifest", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    const baselineFile = path.join(piDir, "upgrade-baseline.json");
    const manifestSha256 = await writeUpgradeAuditManifest(baselineFile, manifest);
    await database.initialize();

    await expect(verifyUpgradeBaselineOnce({
      db: database.db,
      piCodingAgentDir: piDir,
      baselineFile,
    })).resolves.toMatchObject({ skipped: false, summary: { manifestSha256 } });
    const marker = JSON.parse(await fs.readFile(`${baselineFile}.verified`, "utf8"));
    expect(marker.manifestSha256).toBe(manifestSha256);

    await database.db.execute(sql`delete from telegram_file_refs`);
    await expect(verifyUpgradeBaselineOnce({
      db: database.db,
      piCodingAgentDir: piDir,
      baselineFile,
    })).resolves.toMatchObject({ skipped: true });
  });

  it("refuses a startup baseline outside the Pi data root", async () => {
    const manifest = await createUpgradeAuditManifest(database.db, piDir);
    const outsideBaseline = path.join(tempDir, "outside-baseline.json");
    await writeUpgradeAuditManifest(outsideBaseline, manifest);
    await database.initialize();

    await expect(verifyUpgradeBaselineOnce({
      db: database.db,
      piCodingAgentDir: piDir,
      baselineFile: outsideBaseline,
    })).rejects.toThrow("must be inside PI_CODING_AGENT_DIR");
    await expect(fs.access(`${outsideBaseline}.verified`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createLatestMainSchema(database: AppDatabase, piSessionFile: string): Promise<void> {
  const statements = [
    `create table users (
      tg_id integer primary key, first_name text, username text, lang text not null default 'en',
      tz_offset_min integer, stream_mode integer not null default 1, created_at integer not null
    )`,
    `create table threads (
      id integer primary key autoincrement, user_id integer not null references users(tg_id), topic_id integer,
      parent_thread_id integer, fork_point_message_id integer, title text not null,
      title_source text not null default 'explicit', title_attempts integer not null default 0,
      topic_title_synced integer not null default 1, pi_session_file text, pi_session_id text,
      archived integer not null default 0, created_at integer not null
    )`,
    `create table messages (
      id integer primary key autoincrement, thread_id integer not null references threads(id), role text not null,
      kind text not null, content_json text not null, text_plain text not null, thinking text,
      tg_message_id integer, pi_entry_id text, created_at integer not null
    )`,
    `create table files (
      id integer primary key autoincrement, user_id integer not null references users(tg_id),
      thread_id integer not null references threads(id), message_id integer, type text not null,
      content_sha256 text, mime_type text, extraction_status text not null default 'ready',
      name text not null, path text, size integer not null, content_md text, summary text,
      outline_json text, is_inline integer not null, created_at integer not null
    )`,
    `create table file_sources (
      id integer primary key autoincrement, file_id integer not null references files(id) on delete cascade,
      transport text not null, connection_key text not null, remote_key text not null,
      locator_json text not null, mime_type text, last_verified_at integer, created_at integer not null
    )`,
    `create table file_chunks (
      id integer primary key autoincrement, file_id integer not null references files(id), idx integer not null,
      heading_path text, content text not null, created_at integer not null
    )`,
    `create table message_files (
      message_id integer not null references messages(id) on delete cascade,
      file_id integer not null references files(id) on delete cascade,
      display_name text, caption text, created_at integer not null, primary key(message_id, file_id)
    )`,
    `create table embeddings (
      id integer primary key autoincrement, kind text not null, ref_id integer not null, model text,
      dim integer not null, vector blob not null, created_at integer not null
    )`,
    `create table browser_use_profiles (
      deployment_id text not null, user_id integer not null references users(tg_id) on delete cascade,
      provider_user_key text not null unique, profile_id text, created_at integer not null,
      updated_at integer not null, primary key(deployment_id, user_id)
    )`,
    `create virtual table messages_fts using fts5(text, message_id unindexed, thread_id unindexed)`,
    `create virtual table chunks_fts using fts5(text, chunk_id unindexed, file_id unindexed)`,
  ];
  for (const statement of statements) await database.db.execute(sql.raw(statement));
  await database.db.execute(sql`
    insert into users(tg_id, first_name, username, lang, created_at)
    values (987654321, 'Migration', 'private-user', 'en', 1)
  `);
  await database.db.execute(sql`
    insert into threads(id, user_id, title, pi_session_file, pi_session_id, created_at)
    values (1, 987654321, 'Private thread', ${piSessionFile}, 'pi-session-1', 1)
  `);
  await database.db.execute(sql`
    insert into messages(id, thread_id, role, kind, content_json, text_plain, tg_message_id, pi_entry_id, created_at)
    values (1, 1, 'user', 'text', ${JSON.stringify({ text: CHAT_SECRET })}, ${CHAT_SECRET}, 778899, 'entry-1', 2)
  `);
  await database.db.execute(sql`
    insert into files(id, user_id, thread_id, message_id, type, content_sha256, mime_type,
      name, path, size, content_md, summary, outline_json, is_inline, created_at)
    values (1, 987654321, 1, 1, 'txt', 'content-hash', 'text/plain', 'history.txt',
      '/old/.chat-files/1/content', 7, 'content', 'summary', '[]', 1, 2)
  `);
  await database.db.execute(sql`
    insert into file_sources(id, file_id, transport, connection_key, remote_key, locator_json,
      mime_type, last_verified_at, created_at)
    values (1, 1, 'telegram', 'default', 'unique-file',
      ${JSON.stringify({ file_id: TELEGRAM_FILE_ID, file_unique_id: "unique-file" })},
      'text/plain', 2, 2)
  `);
  await database.db.execute(sql`
    insert into file_chunks(id, file_id, idx, heading_path, content, created_at)
    values (1, 1, 0, null, 'searchable content', 2)
  `);
  await database.db.execute(sql`
    insert into message_files(message_id, file_id, display_name, caption, created_at)
    values (1, 1, 'history.txt', 'attachment caption', 2)
  `);
  await database.db.execute(sql`
    insert into messages_fts(text, message_id, thread_id) values (${CHAT_SECRET}, 1, 1)
  `);
  await database.db.execute(sql`
    insert into chunks_fts(text, chunk_id, file_id) values ('searchable content', 1, 1)
  `);
  await database.db.execute(sql`
    insert into embeddings(id, kind, ref_id, model, dim, vector, created_at)
    values (1, 'chunk', 1, 'legacy-embedding', 2, ${Buffer.from([0, 0, 128, 63, 0, 0, 0, 0])}, 2)
  `);
  await database.db.execute(sql`
    insert into browser_use_profiles(deployment_id, user_id, provider_user_key, profile_id, created_at, updated_at)
    values ('legacy', 987654321, ${BROWSER_PROFILE_KEY}, 'browser-profile-1', 2, 2)
  `);
}

async function columns(database: AppDatabase, table: string): Promise<string[]> {
  const rows = await database.db.query<{ name: string }>(sql.raw(`pragma table_info(${table})`));
  return rows.map((row) => row.name);
}
