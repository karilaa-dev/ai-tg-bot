import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createReadFileSectionTool } from "../../src/ai/tools/readFileSection.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { legacyUuid } from "../../src/db/uuidMigration.js";
import { isUuid } from "../../src/utils/uuid.js";
import { projectTurnContext, TURN_CONTEXT_TYPE } from "../../src/pi/turnContext.js";
import { asRecord } from "../../src/util/records.js";
import { initializeLegacySchema } from "./fixtures/legacySchema.js";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} UUID upgrade`, () => {
    let database: AppDatabase;
    let admin: AppDatabase | undefined;
    let schema: string;
    let directory: string;
    let url: string;

    async function legacyDatabase() {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "uuid-migration-"));
      url = `sqlite:${path.join(directory, "database.sqlite")}`;
      if (dialect === "postgres") {
        admin = createDatabase(loadTestConfig({ DB_URL: process.env.TEST_POSTGRES_URL! }));
        schema = `uuid_upgrade_${randomUUID().replaceAll("-", "")}`;
        await admin.db.execute(sql`create schema ${sql.identifier(schema)}`);
        const address = new URL(process.env.TEST_POSTGRES_URL!);
        address.searchParams.set("options", `-c search_path=${schema}`);
        url = address.toString();
      }
      database = createDatabase(loadTestConfig({ DB_URL: url }));
      await initializeLegacySchema(database.db, dialect);
      await seed(database);
    }

    afterEach(async () => {
      await database?.destroy();
      if (admin) {
        await admin.db.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`);
        await admin.destroy();
        admin = undefined;
      }
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });

    it("preserves the complete graph, blobs, search and serialized references across repeated initialization", async () => {
      await legacyDatabase();
      const session = path.join(directory, "session.jsonl");
      const originalSession = `${JSON.stringify({ type: "message", id: "pi-entry", message: { role: "toolResult", content: [{ type: "text", text: JSON.stringify({ file_id: 7, file_ids: [7], thread_id: 1 }) }] } })}\n`;
      await fs.writeFile(session, originalSession);
      await database.db.execute(sql`update threads set pi_session_file = ${session} where id = 1`);
      await database.db.execute(sql`alter table files add column extra_metadata text`);
      await database.db.execute(sql`update files set extra_metadata = 'keep me' where id = 7`);
      await database.db.execute(sql`create index files_extra_metadata_idx on files(extra_metadata)`);
      if (dialect === "sqlite") {
        await database.db.execute(sql`update sqlite_sequence set seq = 100 where name = 'messages'`);
        await database.db.execute(sql`create view file_names as select id, name from files`);
      }
      const contender = createDatabase(loadTestConfig({ DB_URL: url }));
      try { await Promise.all([database.initialize(), contender.initialize()]); }
      finally { await contender.destroy(); }
      const threadId = legacyUuid("thread", "1");
      const forkId = legacyUuid("thread", "2");
      const fileId = legacyUuid("file", "7");
      expect(isUuid(threadId) && isUuid(fileId)).toBe(true);
      expect(threadId).toBe("7798a181-b22c-5cdc-8cc3-46cea27d1130");
      const repos = createRepos(database.db, database.search);
      expect(await repos.threads.get(forkId)).toMatchObject({ parent_thread_id: threadId, fork_point_message_id: 11 });
      expect(await repos.files.get(fileId)).toMatchObject({ thread_id: threadId, user_id: 42, message_id: 11, extra_metadata: "keep me" });
      expect(await repos.messages.get(11)).toMatchObject({ thread_id: threadId, tg_message_id: 345 });
      expect(JSON.parse((await repos.messages.get(11))!.content_json)).toEqual({
        text: `needle [[chat-file:${fileId}]] <attachment id="${fileId}">`, files: [{ id: fileId }],
        file_ids: [fileId], threadId, message_id: 11, user_id: 42,
        link: `/?thread=${threadId}`, download: `/api/chat/threads/${threadId}/files/${fileId}`,
        attachment_failures: [{ file_id: legacyUuid("file", "99") }],
      });
      expect(await repos.messages.get(11)).toMatchObject({ text_plain: `needle [[chat-file:${fileId}]] <attachment id="${fileId}">` });
      expect(await repos.turnRuns.get(3)).toMatchObject({ thread_id: threadId, user_message_id: 11, message_thread_id: 9 });
      for (const table of ["thread_sandboxes", "thread_reads", "thread_operation_barriers", "audio_transcripts", "sandbox_file_restore_status"]) {
        expect(await database.db.query(sql`select thread_id from ${sql.identifier(table)}`)).toEqual([{ thread_id: threadId }]);
      }
      for (const table of ["file_chunks", "message_files", "web_file_blobs", "telegram_file_refs", "sandbox_file_restore_status"]) {
        expect(await database.db.query(sql`select file_id from ${sql.identifier(table)}`)).toEqual([{ file_id: fileId }]);
      }
      expect(await database.db.query(sql`select source_file_id, source_message_id from audio_transcripts`)).toEqual([{ source_file_id: fileId, source_message_id: 11 }]);
      const [blob] = await database.db.query<{ bytes: Buffer }>(sql`select bytes from web_file_blobs where file_id = ${fileId}`);
      expect(blob!.bytes).toEqual(Buffer.from([0, 1, 255, 10]));
      const sources = await repos.files.listSources(fileId);
      expect(sources.find(source => source.transport === "web")?.remote_key).toBe(fileId);
      expect(sources.find(source => source.transport === "e2b")).toMatchObject({
        remote_key: `sandbox:file:${fileId}:sha256:hash`, locator_json: JSON.stringify({ thread_id: threadId, user_id: 42, path: "/tmp/7.txt" }),
      });
      expect(sources.find(source => source.transport === "telegram")).toMatchObject({ remote_key: "7", locator_json: '{"file_id":"7"}' });
      expect(await database.search.searchMessages([threadId], "needle", 5)).toEqual([expect.objectContaining({ id: 11 })]);
      expect(await database.search.searchChunks([fileId], "chunkneedle", 5)).toEqual([expect.objectContaining({ id: 13 })]);
      expect((await fs.readFile(session, "utf8"))).toBe(originalSession);
      const migratedSession = (await repos.threads.get(threadId))!.pi_session_file!;
      expect(migratedSession).not.toBe(session);
      const sessionEntry = JSON.parse((await fs.readFile(migratedSession, "utf8")).trim());
      expect(JSON.parse(sessionEntry.message.content[0].text)).toEqual({ file_id: fileId, file_ids: [fileId], thread_id: threadId });
      const before = await database.db.query(sql`select * from legacy_uuid_ids order by kind, legacy_id`);
      expect(before).toHaveLength(4);
      await database.initialize();
      expect(await database.db.query(sql`select * from legacy_uuid_ids order by kind, legacy_id`)).toEqual(before);
      expect(await database.db.query(sql`select * from schema_migrations`)).toHaveLength(1);
      const freshThread = await repos.threads.create({ userId: 42, topicId: null, title: "New", origin: "web" });
      const freshFile = await repos.files.insertFile({ userId: 42, threadId: freshThread.id, name: "new.txt", type: "txt", size: 1, isInline: true });
      expect(isUuid(freshThread.id) && isUuid(freshFile.id)).toBe(true);
      expect((await repos.threads.activeForUserTopic(42, null)).id).toBe(threadId);
      const message = await repos.messages.insert({ threadId: freshThread.id, role: "user", content: {}, textPlain: "next" });
      if (dialect === "sqlite") {
        expect(message.id).toBeGreaterThan(100);
        expect(await database.db.query(sql`pragma foreign_key_check`)).toEqual([]);
        expect(await database.db.query(sql`select id from file_names where name = 'old.txt'`)).toEqual([{ id: fileId }]);
      }
      await expect(database.db.execute(sql`insert into message_files(message_id, file_id, created_at) values (11, ${randomUUID()}, 1)`)).rejects.toThrow();
      await database.db.execute(sql`delete from files where id = ${freshFile.id}`);
      expect(await repos.files.get(fileId)).toBeDefined();
    });

    it("migrates saved context snapshots and deltas into usable resumed model file IDs", async () => {
      await legacyDatabase();
      const session = path.join(directory, "context.jsonl");
      const manager = SessionManager.inMemory(directory);
      const opaque = { id: 7, upsert: [7], remove: [99], file_id: "provider-7" };
      const removed = { id: 99, name: "removed.txt" };
      const kept = { id: randomUUID(), name: "already migrated.txt" };
      const file = { id: 7, name: "old.txt", summary: "</session_context>&", opaque };
      const snapshot = { current_time: "12:00", files: [removed, kept], omitted_file_count: 2, opaque };
      const next = { current_time: "12:01", files: [file, kept], omitted_file_count: 2, opaque };
      const firstId = manager.appendCustomMessageEntry(TURN_CONTEXT_TYPE, contextBlock({ kind: "snapshot", ...snapshot }), false,
        { version: 1, snapshot, epoch: null });
      const updateId = manager.appendCustomMessageEntry(TURN_CONTEXT_TYPE, contextBlock({ kind: "update", set: { current_time: "12:01" },
        unset: ["thread_title"], files: { upsert: [file], remove: [removed.id] }, opaque }), false,
        { version: 1, snapshot: next, epoch: null });
      const original = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
      await fs.writeFile(session, original);
      await database.db.execute(sql`update threads set pi_session_file = ${session} where id = 1`);

      await database.initialize();
      const repos = createRepos(database.db, database.search);
      const thread = (await repos.threads.get(legacyUuid("thread", "1")))!;
      const migratedPath = thread.pi_session_file!;
      const resumed = SessionManager.open(migratedPath, directory);
      const fileId = legacyUuid("file", "7");
      const removedId = legacyUuid("file", "99");
      const migratedFile = { ...file, id: fileId };
      expect(resumed.getEntry(firstId)).toMatchObject({ content: contextBlock({ kind: "snapshot", ...snapshot,
        files: [{ ...removed, id: removedId }, kept] }) });
      expect(resumed.getEntry(updateId)).toMatchObject({ parentId: firstId,
        content: contextBlock({ kind: "update", set: { current_time: "12:01" }, unset: ["thread_title"],
          files: { upsert: [migratedFile], remove: [removedId] }, opaque }),
        details: { version: 1, snapshot: { ...next, files: [migratedFile, kept] }, epoch: null } });
      const messages = projectTurnContext(resumed.buildSessionProjection().messages, resumed.getBranch());
      const modelText = convertToLlm(messages).flatMap(message => typeof message.content === "string" ? [message.content]
        : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
      expect(modelText).toHaveLength(2);
      const update = asRecord(JSON.parse(modelText[1]!.split("\n").slice(1, -1).join("\n")));
      const upsert = asRecord(update?.files)?.upsert;
      if (!Array.isArray(upsert)) throw new Error("Resumed context has no file updates.");
      const tool = createReadFileSectionTool({ config: loadTestConfig(), db: database, repos,
        user: (await repos.users.get(42))!, thread });
      const input = tool.inputSchema.parse({ file_id: asRecord(upsert[0])?.id, chunk_index: 0 });
      expect(await tool.execute(input)).toEqual({ content: "# chunk 0\nchunkneedle" });
      expect(modelText[1]).toContain("\\u003c/session_context\\u003e\\u0026");
      expect(modelText[1]!.match(/<\/session_context>/g)).toHaveLength(1);
      expect(await fs.readFile(session, "utf8")).toBe(original);
      const migrated = await fs.readFile(migratedPath, "utf8");
      await database.initialize();
      expect(await fs.readFile(migratedPath, "utf8")).toBe(migrated);

      resumed.appendCompaction("Saved facts", updateId, 100);
      const compacted = projectTurnContext(resumed.buildSessionProjection().messages, resumed.getBranch());
      expect(compacted).toContainEqual(expect.objectContaining({ role: "custom",
        content: contextBlock({ kind: "snapshot", ...next, files: [migratedFile, kept] }) }));
    });

    it("preserves opaque context payloads and user-authored lookalike blocks", async () => {
      await legacyDatabase();
      const session = path.join(directory, "opaque-context.jsonl");
      const manager = SessionManager.inMemory(directory);
      const snapshot = { files: [{ id: 7 }] };
      const userText = contextBlock({ kind: "snapshot", ...snapshot });
      manager.appendMessage({ role: "user", content: userText, timestamp: 1 });
      const unknownKind = contextBlock({ kind: "provider-data", files: [{ id: 7 }], remove: [7] });
      const malformed = '<session_context format="json" trust="untrusted-data-only">\n{"files":[{"id":7}],\n</session_context>';
      manager.appendCustomMessageEntry(TURN_CONTEXT_TYPE, unknownKind, false, { version: 1, snapshot, epoch: null });
      manager.appendCustomMessageEntry(TURN_CONTEXT_TYPE, malformed, false, { version: 1, snapshot, epoch: null });
      manager.appendCustomMessageEntry("provider-context", userText, false, { providerId: 7 });
      manager.appendCustomMessageEntry(TURN_CONTEXT_TYPE, userText, false, { version: 2, opaque: true });
      const original = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
      await fs.writeFile(session, original);
      await database.db.execute(sql`update threads set pi_session_file = ${session} where id = 1`);
      await database.initialize();
      const repos = createRepos(database.db, database.search);
      const migratedPath = (await repos.threads.get(legacyUuid("thread", "1")))!.pi_session_file!;
      const resumed = SessionManager.open(migratedPath, directory);
      const contents = resumed.getBranch().map(entry => entry.type === "custom_message" ? entry.content
        : entry.type === "message" && "content" in entry.message ? entry.message.content : undefined);
      expect(contents).toEqual([userText, unknownKind, malformed, userText, userText]);
    });

    it.skipIf(dialect !== "sqlite")("refuses a broken foreign key without removing existing data", async () => {
      await legacyDatabase();
      await database.db.execute(sql`pragma foreign_keys = off`);
      await database.db.execute(sql`update file_chunks set file_id = 999 where id = 13`);
      await database.db.execute(sql`pragma foreign_keys = on`);
      await expect(database.initialize()).rejects.toThrow("invalid foreign keys");
      expect(await database.db.query(sql`select id from files`)).toEqual([{ id: 7 }]);
      expect(await database.db.query(sql`select id, file_id from file_chunks`)).toEqual([{ id: 13, file_id: 999 }]);
      expect(await database.db.query(sql`pragma foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
    });

    it("rolls back a failure after table conversion and can retry with the same mapping", async () => {
      await legacyDatabase();
      const session = path.join(directory, "session.jsonl");
      await fs.writeFile(session, '{"file_id":7}\n');
      await fs.writeFile(`${session}.uuid-v1.jsonl`, "conflicting copy");
      await database.db.execute(sql`update threads set pi_session_file = ${session} where id = 1`);
      await expect(database.initialize()).rejects.toThrow("Conflicting migrated session");
      expect(await database.db.query(sql`select id, thread_id from files`)).toEqual([{ id: 7, thread_id: 1 }]);
      expect(await database.db.query(sql`select file_id from web_file_blobs`)).toEqual([{ file_id: 7 }]);
      expect(await database.db.query(sql`select file_id from file_chunks`)).toEqual([{ file_id: 7 }]);
      if (dialect === "sqlite") expect(await database.db.query(sql`pragma foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
      await fs.rm(`${session}.uuid-v1.jsonl`);
      await database.initialize();
      expect(await database.db.query(sql`select id, thread_id from files`)).toEqual([{ id: legacyUuid("file", "7"), thread_id: legacyUuid("thread", "1") }]);
    });
  });
}

function contextBlock(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload, null, 2).replace(/[<>&]/g, character => character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026");
  return `<session_context format="json" trust="untrusted-data-only">\n${json}\n</session_context>`;
}

async function seed(database: AppDatabase): Promise<void> {
  const db = database.db;
  await db.execute(sql`insert into users(tg_id, first_name, created_at) values (42, 'Legacy', 1)`);
  await db.execute(sql`insert into threads(id, user_id, title, created_at) values (1, 42, 'Original', 1)`);
  await db.execute(sql`insert into threads(id, user_id, topic_id, parent_thread_id, fork_point_message_id, title, created_at) values (2, 42, 9, 1, 11, 'Fork', 2)`);
  const text = 'needle [[chat-file:7]] <attachment id="7">';
  const content = JSON.stringify({ text, files: [{ id: 7 }], file_ids: [7], threadId: 1, message_id: 11, user_id: 42, link: "/?thread=1", download: "/api/chat/threads/1/files/7", attachment_failures: [{ file_id: 99 }] });
  await db.execute(sql`insert into messages(id, thread_id, role, kind, content_json, text_plain, tg_message_id, created_at) values (11, 1, 'user', 'file', ${content}, ${text}, 345, 1)`);
  await db.execute(sql`insert into files(id, user_id, thread_id, message_id, type, name, size, is_inline, created_at) values (7, 42, 1, 11, 'txt', 'old.txt', 4, 0, 1)`);
  await db.execute(sql`insert into file_chunks(id, file_id, idx, content, created_at) values (13, 7, 0, 'chunkneedle', 1)`);
  await db.execute(sql`insert into message_files(message_id, file_id, created_at) values (11, 7, 1)`);
  await db.execute(sql`insert into web_file_blobs(file_id, bytes) values (7, ${Buffer.from([0, 1, 255, 10])})`);
  await db.execute(sql`insert into thread_reads(user_id, thread_id, message_id) values (42, 1, 11)`);
  await db.execute(sql`insert into thread_sandboxes(deployment_id, user_id, thread_id, sandbox_id, created_at, updated_at) values ('local', 42, 1, 'sandbox', 1, 1)`);
  await db.execute(sql`insert into thread_operation_barriers(thread_id, owner_id, operation, snapshot_message_id, lease_expires_at, created_at, updated_at) values (1, 'owner', 'fork', 11, 1, 1, 1)`);
  await db.execute(sql`insert into turn_runs(id, user_id, thread_id, user_message_id, chat_id, message_thread_id, locale, status, accepted_at, updated_at) values (3, 42, 1, 11, 42, 9, 'en', 'queued', 1, 1)`);
  await db.execute(sql`insert into turn_run_sources(turn_run_id, telegram_update_id, created_at) values (3, 456, 1)`);
  await db.execute(sql`insert into audio_transcripts(id, user_id, thread_id, source_file_id, source_message_id, text, model, created_at) values ('transcript', 42, 1, 7, 11, 'hello', 'model', 1)`);
  await db.execute(sql`insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at) values (7, 'web', 'default', '7', '{}', 1)`);
  await db.execute(sql`insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at) values (7, 'e2b', 'local', 'sandbox:file:7:sha256:hash', '{"thread_id":1,"user_id":42,"path":"/tmp/7.txt"}', 1)`);
  await db.execute(sql`insert into file_sources(file_id, transport, connection_key, remote_key, locator_json, created_at) values (7, 'telegram', 'default', '7', '{"file_id":"7"}', 1)`);
  await db.execute(sql`insert into telegram_file_refs(id, file_id, telegram_file_id, direction, media_kind, is_primary, first_seen_at, last_seen_at) values (9, 7, 'telegram-opaque', 'inbound', 'document', 1, 1, 1)`);
  await db.execute(sql`insert into sandbox_file_restore_status(deployment_id, thread_id, sandbox_id, file_id, telegram_file_ref_id, sandbox_name, status, attempted_at) values ('local', 1, 'sandbox', 7, 9, '7.txt', 'available', 1)`);
  if (database.dialect === "sqlite") {
    await db.execute(sql`insert into messages_fts(text, message_id, thread_id) values (${text}, 11, 1)`);
    await db.execute(sql`insert into chunks_fts(text, chunk_id, file_id) values ('chunkneedle', 13, 7)`);
  } else {
    await db.execute(sql`insert into message_search(message_id, thread_id, text, ts) values (11, 1, ${text}, to_tsvector('simple', ${text}))`);
    await db.execute(sql`insert into chunk_search(chunk_id, file_id, text, ts) values (13, 7, 'chunkneedle', to_tsvector('simple', 'chunkneedle'))`);
    // The fixture inserts explicit numeric IDs just like a restored database dump.
    await db.execute(sql`select setval(pg_get_serial_sequence('messages', 'id'), 11)`);
  }
}
