import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { AccessControl } from "../../src/access/control.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";

const databases: AppDatabase[] = [];
const directories: string[] = [];
type UserIdentity = "telegram" | "uuid";

function openDatabase(url = "sqlite::memory:"): AppDatabase {
  const database = createDatabase({ DB_URL: url });
  databases.push(database);
  return database;
}

async function fixture(identity: UserIdentity = "uuid", url?: string) {
  const database = openDatabase(url);
  await database.db.execute(sql`pragma foreign_keys = on`);
  const identityColumns = identity === "uuid"
    ? sql`id text primary key not null, tg_id integer not null unique`
    : sql`tg_id integer primary key`;
  await database.db.execute(sql`
    create table users (
      ${identityColumns}, first_name text, username text, created_at integer not null
    )
  `);
  return {
    database,
    access: new AccessControl(database.db),
    register: async (tgId: number, firstName: string | null = null, username: string | null = null) => {
      const idColumn = identity === "uuid" ? sql`id,` : sql``;
      const idValue = identity === "uuid" ? sql`${randomUUID()},` : sql``;
      await database.db.execute(sql`
        insert into users(${idColumn} tg_id, first_name, username, created_at)
        values (${idValue} ${tgId}, ${firstName}, ${username}, 100)
      `);
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(databases.splice(0).map(database => database.destroy()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("AccessControl SQLite migration", () => {
  const identities: UserIdentity[] = ["telegram", "uuid"];

  it.each(identities)("grandfathers existing %s users once and joins their identity", async (identity) => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { access, register } = await fixture(identity);
    await register(42, "Ada", "ada");
    await register(43);

    await access.initialize();

    expect(await access.isAllowed(42)).toBe(true);
    expect(await access.isAllowed(999)).toBe(false);
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: "Ada", username: "ada", registered: true, createdAt: 2_000 },
      { telegramId: 43, firstName: null, username: null, registered: true, createdAt: 2_000 },
    ]);

    await access.revoke(42);
    await register(44, "New registration");
    await access.initialize();

    expect(await access.isAllowed(42)).toBe(false);
    expect(await access.isAllowed(43)).toBe(true);
    expect(await access.isAllowed(44)).toBe(false);
  });

  it("preserves revocations across closing and reopening the database", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-access-"));
    directories.push(directory);
    const url = `sqlite:${path.join(directory, "access.db")}`;
    const { database, access, register } = await fixture("uuid", url);
    await register(42, "Revoked");
    await register(43, "Kept");
    await access.initialize();
    await access.allow(44);
    await access.revoke(42);
    await database.destroy();

    const restarted = new AccessControl(openDatabase(url).db);
    await restarted.initialize();
    await restarted.initialize();

    expect(await restarted.isAllowed(42)).toBe(false);
    expect(await restarted.isAllowed(43)).toBe(true);
    expect(await restarted.isAllowed(44)).toBe(true);
  });

  it("records an empty first migration and never seeds later registrations or environment IDs", async () => {
    vi.stubEnv("BOT_ALLOWED_USER_IDS", "41,42");
    vi.stubEnv("WEB_ADMIN_USER_IDS", "43");
    const { database, access, register } = await fixture();
    await access.initialize();
    expect(await access.list()).toEqual([]);
    await register(44, "Later");
    const restarted = new AccessControl(database.db);
    await restarted.initialize();

    for (const tgId of [41, 42, 43, 44]) expect(await restarted.isAllowed(tgId)).toBe(false);
  });

  it("rolls back table creation and the migration marker when the seed fails, allowing a retry", async () => {
    const database = openDatabase();
    const access = new AccessControl(database.db);

    await expect(access.initialize()).rejects.toThrow(/users/);
    expect(await database.db.query(sql`
      select name from sqlite_master where name in ('bot_allowed_users', 'access_migrations')
    `)).toEqual([]);

    await database.db.execute(sql`
      create table users(tg_id integer primary key, first_name text, username text)
    `);
    await database.db.execute(sql`insert into users(tg_id) values (42)`);
    await access.initialize();

    expect(await access.isAllowed(42)).toBe(true);
  });

  it("rolls back partial seeding and the marker together on existing access tables", async () => {
    const { database, access, register } = await fixture();
    await register(42);
    await register(43);
    await database.db.execute(sql`
      create table bot_allowed_users(tg_id integer primary key, created_at integer not null)
    `);
    await database.db.execute(sql`create table access_migrations(name text primary key)`);
    await database.db.execute(sql`
      create trigger fail_seed before insert on bot_allowed_users when new.tg_id = 43
      begin select raise(fail, 'seed failed'); end
    `);

    await expect(access.initialize()).rejects.toThrow("seed failed");
    expect(await database.db.query(sql`select * from bot_allowed_users`)).toEqual([]);
    expect(await database.db.query(sql`select * from access_migrations`)).toEqual([]);

    await database.db.execute(sql`drop trigger fail_seed`);
    await access.initialize();
    expect(await access.isAllowed(42)).toBe(true);
    expect(await access.isAllowed(43)).toBe(true);
  });

  it("serializes concurrent initialization on separate SQLite connections", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-access-concurrent-"));
    directories.push(directory);
    const url = `sqlite:${path.join(directory, "access.db")}`;
    const { access, register } = await fixture("uuid", url);
    await register(42);
    const contender = new AccessControl(openDatabase(url).db);

    await Promise.all([access.initialize(), contender.initialize()]);
    expect(await access.isAllowed(42)).toBe(true);
    await access.revoke(42);
    await Promise.all([access.initialize(), contender.initialize()]);

    expect(await access.list()).toEqual([]);
    expect(await contender.isAllowed(42)).toBe(false);
  });
});

describe("AccessControl allowlist", () => {
  it("allows unregistered IDs without creating users and refreshes joined metadata after registration", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { database, access, register } = await fixture();
    await access.initialize();
    await access.allow(42);

    expect(await database.db.query(sql`select * from users`)).toEqual([]);
    expect(await access.isAllowed(42)).toBe(true);
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: null, username: null, registered: false, createdAt: 2_000 },
    ]);

    now.mockReturnValue(3_000);
    await access.allow(42);
    await register(42, "Ada", "ada");
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: "Ada", username: "ada", registered: true, createdAt: 2_000 },
    ]);

    await database.db.execute(sql`update users set first_name = 'Grace', username = null where tg_id = 42`);
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: "Grace", username: null, registered: true, createdAt: 2_000 },
    ]);
    await database.db.execute(sql`delete from users where tg_id = 42`);
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: null, username: null, registered: false, createdAt: 2_000 },
    ]);
  });

  it("revokes idempotently without deleting a user's identity, and permits explicit reallow", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { database, access, register } = await fixture();
    await register(42, "Ada", "ada");
    await access.initialize();
    await access.revoke(42);
    await access.revoke(42);
    await access.revoke(999);

    expect(await access.isAllowed(42)).toBe(false);
    expect(await access.list()).toEqual([]);
    expect(await database.db.query(sql`select tg_id, first_name from users`)).toEqual([
      { tg_id: 42, first_name: "Ada" },
    ]);

    now.mockReturnValue(3_000);
    await access.allow(42);
    expect(await access.list()).toEqual([
      { telegramId: 42, firstName: "Ada", username: "ada", registered: true, createdAt: 3_000 },
    ]);
  });

  it("orders by newest grant and then Telegram ID and retains safe 64-bit integers", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { access } = await fixture();
    await access.initialize();
    await access.allow(5_000_000_000);
    now.mockReturnValue(1_800_000_000_001);
    await access.allow(Number.MAX_SAFE_INTEGER);
    await access.allow(1);

    expect(await access.list()).toEqual([
      { telegramId: 1, firstName: null, username: null, registered: false, createdAt: 1_800_000_000_001 },
      { telegramId: Number.MAX_SAFE_INTEGER, firstName: null, username: null, registered: false, createdAt: 1_800_000_000_001 },
      { telegramId: 5_000_000_000, firstName: null, username: null, registered: false, createdAt: 1_800_000_000_000 },
    ]);
    expect(await access.isAllowed(Number.MAX_SAFE_INTEGER)).toBe(true);
    await access.revoke(Number.MAX_SAFE_INTEGER);
    expect(await access.isAllowed(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid Telegram ID %s before accessing the database",
    async (tgId) => {
      const access = new AccessControl(openDatabase().db);

      await expect(access.allow(tgId)).rejects.toBeInstanceOf(ZodError);
      await expect(access.revoke(tgId)).rejects.toBeInstanceOf(ZodError);
      await expect(access.isAllowed(tgId)).rejects.toBeInstanceOf(ZodError);
    },
  );
});
