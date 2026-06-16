import { afterEach, describe, expect, it } from "vitest";
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
    await db.migrate();
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
  });
});
