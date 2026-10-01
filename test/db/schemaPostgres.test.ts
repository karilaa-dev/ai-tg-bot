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
    database = createDatabase(loadTestConfig({ DB_URL: databaseUrl() }));
  });

  afterAll(async () => {
    await database?.destroy();
    await admin?.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await admin?.destroy();
  });

  it("serializes concurrent initialization and preserves current data", async () => {
    const contender = createDatabase(loadTestConfig({ DB_URL: databaseUrl() }));
    await Promise.all([database.initialize(), contender.initialize()]);
    await contender.destroy();

    const repos = createRepos(database.db, database.search);
    const user = await repos.users.ensure({ tgId: 42, firstName: "Current", lang: "en" });
    const threads = await Promise.all(Array.from({ length: 5 }, () => repos.threads.activeForUserTopic(user.tg_id, null)));
    expect(new Set(threads.map(thread => thread.id)).size).toBe(1);
    const thread = threads[0]!;
    const toggled = await Promise.all([repos.users.toggleStream(user.tg_id), repos.users.toggleStream(user.tg_id)]);
    expect(toggled.map(user => user.stream_mode).sort()).toEqual([0, 1]);
    expect((await repos.users.get(user.tg_id))?.stream_mode).toBe(1);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "postgres search needle" },
      textPlain: "postgres search needle",
    });
    await database.initialize();

    const transcriptId = await repos.audioTranscripts.insert({ userId: user.tg_id, threadId: thread.id, messageId: message.id }, {
      text: "A persisted transcript.", model: "qwen/qwen3-asr-1.7b",
    });
    await database.initialize();
    expect(await repos.audioTranscripts.get(transcriptId)).toMatchObject({ text: "A persisted transcript.", visible_message_id: message.id });
    const incomingId = await repos.audioTranscripts.insert({ userId: user.tg_id, threadId: thread.id, telegramUpdateId: 1234 }, {
      text: "An incoming transcript.", model: "qwen/qwen3-asr-1.7b",
    });
    expect(await repos.audioTranscripts.get(incomingId)).toMatchObject({ visible_message_id: null });
    expect(await repos.turnRuns.hasTelegramUpdate(1234)).toBe(false);
    const accepted = await repos.turnRuns.accept({
      userId: user.tg_id, threadId: thread.id, chatId: user.tg_id, messageThreadId: null,
      locale: "en", kind: "file", content: {}, textPlain: "A bounded preview.", sources: [{ updateId: 1234, messageId: 1 }],
    });
    expect(await repos.audioTranscripts.get(incomingId)).toMatchObject({ visible_message_id: accepted.userMessage.id });
    expect(await repos.turnRuns.hasTelegramUpdate(1234)).toBe(true);
    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users`)).toEqual([{ tg_id: 42 }]);
    await expect(database.search.searchMessages([thread.id], "needle", 5))
      .resolves.toEqual([expect.objectContaining({ id: message.id })]);
  });

  function databaseUrl(): string {
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  }
});
