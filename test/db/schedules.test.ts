import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { MIN_SCHEDULE_INTERVAL_MS as HOUR } from "../../src/scheduling/types.js";

for (const dialect of ["sqlite", "postgres"] as const) {
describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} durable scheduled chats`, () => {
  let db: AppDatabase;
  let contender: AppDatabase;
  let admin: AppDatabase | undefined;
  let repos: Repos;
  let directory: string;
  let schema: string;
  let threadId: string;
  let now: number;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    now = Date.UTC(2026, 9, 26, 12);
    vi.setSystemTime(now);
    directory = await mkdtemp(path.join(tmpdir(), "scheduled-chats-"));
    schema = `schedules_${randomUUID().replaceAll("-", "")}`;
    let DB_URL = `sqlite:${path.join(directory, "test.db")}`;
    if (dialect === "postgres") {
      admin = createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! });
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      const url = new URL(process.env.TEST_POSTGRES_URL!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      DB_URL = url.toString();
    }
    db = createDatabase({ DB_URL });
    await db.initialize();
    contender = createDatabase({ DB_URL });
    repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 42 });
    await repos.users.ensure({ tgId: 84 });
    threadId = (await repos.threads.create({ userId: 42, title: "Forecast", origin: "web", topicId: 123 })).id;
  });
  afterEach(async () => {
    await contender?.destroy();
    await db?.destroy();
    if (admin) { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); admin = undefined; }
    await rm(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });
  const input = () => ({ threadId, title: "Forecast", prompt: "Check tomorrow's forecast", nextRunAt: now + HOUR, intervalMinutes: 60 });
  const advance = (ms: number) => { now += ms; vi.setSystemTime(now); };
  const finish = async () => { await db.db.execute(sql`update turn_runs set status = 'succeeded', started_at = accepted_at, finished_at = ${now}`); };

  it("validates ownership, one schedule per chat, future time, and the hourly minimum on every write", async () => {
    for (const intervalMinutes of [0, 59, 60.5, 525601]) {
      await expect(repos.schedules.create(42, { ...input(), intervalMinutes })).rejects.toThrow();
    }
    await expect(repos.schedules.create(42, { ...input(), nextRunAt: now })).rejects.toThrow("future");
    await expect(repos.schedules.create(84, input())).rejects.toThrow("not found");
    const schedule = await repos.schedules.create(42, input());
    await expect(repos.schedules.create(42, input())).rejects.toThrow("already has");
    expect(await repos.schedules.list(84)).toEqual([]);
    await expect(repos.schedules.update(84, schedule.id, { enabled: false })).rejects.toThrow("not found");
    await expect(repos.schedules.delete(84, schedule.id)).rejects.toThrow("not found");
    await expect(repos.schedules.update(42, schedule.id, { intervalMinutes: 1 })).rejects.toThrow();
    await repos.schedules.update(42, schedule.id, { enabled: false });
    advance(2 * HOUR);
    expect(await repos.schedules.enqueue(42, schedule.id)).toBeNull();
    await expect(repos.schedules.update(42, schedule.id, { enabled: true })).rejects.toThrow("future");
    await repos.schedules.update(42, schedule.id, { enabled: true, nextRunAt: now + HOUR });
    await repos.schedules.delete(42, schedule.id);
    expect(await repos.schedules.list(42)).toEqual([]);
  });

  it.each(["web", "telegram"] as const)("queues a one-time %s check exactly once across independent workers and restarts", async origin => {
    await db.db.execute(sql`update threads set origin = ${origin} where id = ${threadId}`);
    const saved = await repos.schedules.create(42, { ...input(), intervalMinutes: null });
    expect(await repos.schedules.enqueue(42, saved.id)).toBeNull();
    advance(HOUR);
    const other = createRepos(contender.db, contender.search);
    const queued = await Promise.all([repos.schedules.enqueue(42, saved.id), other.schedules.enqueue(42, saved.id)]);
    expect(queued.filter(Boolean)).toHaveLength(1);
    const turns = await repos.turnRuns.listForThread(threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ origin, status: "queued", message_thread_id: 123, chat_id: 42 });
    expect((await repos.messages.listThread(threadId))[0]?.text_plain).toContain("Check tomorrow's forecast");
    await db.initialize();
    expect(await repos.schedules.list(42)).toEqual([expect.objectContaining({ id: saved.id, enabled: false, lastTurnId: turns[0]!.id, lastRunAt: now })]);
    expect(await other.schedules.enqueue(42, saved.id)).toBeNull();
    expect(await repos.turnRuns.queuedThreadIds()).toEqual([threadId]);
    expect(await db.search.searchMessages([threadId], "forecast", 10)).toHaveLength(1);
  });

  it("skips missed intervals, does not overlap turns, and preserves the hourly cap through edits and recreation", async () => {
    const saved = await repos.schedules.create(42, input());
    advance(25 * HOUR);
    expect(await repos.schedules.enqueue(42, saved.id)).not.toBeNull();
    expect((await repos.schedules.list(42))[0]?.nextRunAt).toBe(now + HOUR);
    advance(2 * HOUR);
    expect(await repos.schedules.due(now)).toEqual([]);
    expect(await repos.schedules.enqueue(42, saved.id)).toBeNull();
    // A slow queue starts much later; the next check is measured from actual start.
    await db.db.execute(sql`update turn_runs set status = 'succeeded', started_at = ${now}`);
    await repos.schedules.update(42, saved.id, { nextRunAt: now + 1 });
    advance(1);
    expect(await repos.schedules.enqueue(42, saved.id)).toBeNull();
    await repos.schedules.delete(42, saved.id);
    const recreated = await repos.schedules.create(42, { ...input(), nextRunAt: now + 1 });
    advance(1);
    expect(await repos.schedules.enqueue(42, recreated.id)).toBeNull();
    advance(HOUR);
    expect(await repos.schedules.enqueue(42, recreated.id)).not.toBeNull();
    expect(await repos.turnRuns.listForThread(threadId)).toHaveLength(2);
  });

  it("does not run an archived chat or enqueue behind a user turn", async () => {
    const saved = await repos.schedules.create(42, input());
    await repos.turnRuns.accept({ userId: 42, threadId, chatId: 42, messageThreadId: 123, locale: "en",
      kind: "text", content: {}, textPlain: "Manual question", sources: [], webRequestId: randomUUID() });
    advance(HOUR);
    expect(await repos.schedules.enqueue(42, saved.id)).toBeNull();
    await finish();
    await repos.threads.archive(threadId);
    expect(await repos.schedules.due(now)).toEqual([]);
    expect(await repos.schedules.enqueue(42, saved.id)).toBeNull();
    await repos.schedules.update(42, saved.id, { enabled: false });
    await expect(repos.schedules.create(42, input())).rejects.toThrow("archived");
  });

  it.skipIf(dialect !== "sqlite")("rolls back the queued message and turn when schedule advancement fails", async () => {
    const saved = await repos.schedules.create(42, input());
    advance(HOUR);
    await db.db.execute(sql`create trigger fail_schedule_update before update on chat_schedules begin select raise(abort, 'disk failure'); end`);
    await expect(repos.schedules.enqueue(42, saved.id)).rejects.toThrow("disk failure");
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([]);
    expect(await repos.messages.listThread(threadId)).toEqual([]);
    expect((await repos.schedules.list(42))[0]?.lastRunAt).toBeNull();
    await db.db.execute(sql`drop trigger fail_schedule_update`);
    expect(await repos.schedules.enqueue(42, saved.id)).not.toBeNull();
  });
});
}
