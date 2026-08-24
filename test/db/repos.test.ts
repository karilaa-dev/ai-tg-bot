import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";

describe("repository round-trip on sqlite", () => {
  let db: AppDatabase;

  afterEach(async () => {
    await db?.destroy();
  });

  it("persists users, threads, messages, and searchable text", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:" });
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const tgId = Date.now() + Math.floor(Math.random() * 1000);
    const user = await repos.users.ensure({ tgId, firstName: "DB", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: `needle-${tgId}` },
      textPlain: `needle-${tgId}`,
    });

    const hits = await db.search.searchMessages([thread.id], `needle-${tgId}`, 5);

    expect(message.id).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe(message.id);

    await repos.messages.setDeliveryContent({
      messageId: message.id,
      content: {
        text: `delivered-${tgId}`,
        attachment_failures: [{ file_id: 7, status: "source_unavailable" }],
      },
      textPlain: `delivered-${tgId}`,
      tgMessageId: 1234,
    });
    const updated = await repos.messages.get(message.id);
    expect(updated).toMatchObject({
      text_plain: `delivered-${tgId}`,
      tg_message_id: 1234,
    });
    expect(JSON.parse(updated!.content_json)).toEqual({
      text: `delivered-${tgId}`,
      attachment_failures: [{ file_id: 7, status: "source_unavailable" }],
    });
    await expect(db.search.searchMessages([thread.id], `delivered-${tgId}`, 5))
      .resolves.toEqual([expect.objectContaining({ id: message.id })]);

    await repos.messages.setThinking(message.id, "final delivery summary", 5678);
    await expect(repos.messages.get(message.id)).resolves.toMatchObject({
      thinking: "final delivery summary",
      // The already known Telegram message remains authoritative.
      tg_message_id: 1234,
    });
  });

  it("rolls back a message insert when its FTS index write fails", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:" });
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 77_012, firstName: "Atomic", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    await db.db.execute(sql`drop table messages_fts`);

    await expect(repos.messages.insert({
      threadId: thread.id,
      role: "assistant",
      content: { text: "must roll back" },
      textPlain: "must roll back",
    })).rejects.toThrow();

    await expect(repos.messages.listThread(thread.id)).resolves.toEqual([]);
  });

  it("persists one opaque Browser Use profile key per deployment user", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:" });
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 7711, firstName: "Private Name", lang: "en" });

    const first = await repos.browserUseProfiles.ensure("deployment", 7711);
    const second = await repos.browserUseProfiles.ensure("deployment", 7711);
    await repos.browserUseProfiles.setProfileId(
      "deployment",
      7711,
      "123e4567-e89b-12d3-a456-426614174001",
    );

    expect(first.provider_user_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.provider_user_key).toBe(first.provider_user_key);
    expect(first.provider_user_key).not.toContain("Private Name");
    await expect(repos.browserUseProfiles.get("deployment", 7711)).resolves.toMatchObject({
      provider_user_key: first.provider_user_key,
      profile_id: "123e4567-e89b-12d3-a456-426614174001",
    });
  });
});
