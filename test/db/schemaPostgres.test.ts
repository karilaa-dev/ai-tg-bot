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
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "postgres search needle" },
      textPlain: "postgres search needle",
    });
    await database.initialize();

    expect(await tableExists("users")).toBe(true);
    expect(await tableExists("message_search")).toBe(true);
    expect(await tableExists("chunk_search")).toBe(true);
    expect(await tableExists("turn_runs")).toBe(true);
    expect(await tableExists("turn_run_sources")).toBe(true);
    expect(await tableExists("schema_migrations")).toBe(false);
    expect(await tableExists("invites")).toBe(false);
    expect(await tableExists("summaries")).toBe(false);
    expect(await database.db.query<{ tg_id: number }>(sql`select tg_id from users`)).toEqual([{ tg_id: 42 }]);
    await expect(database.search.searchMessages([thread.id], "needle", 5))
      .resolves.toEqual([expect.objectContaining({ id: message.id })]);
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

  function databaseUrl(): string {
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  }
});
