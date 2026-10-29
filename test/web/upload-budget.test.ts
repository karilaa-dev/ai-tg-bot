import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { requireUploadSpace, UploadBudget } from "../../src/web/upload-budget.js";

let database: AppDatabase;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "upload-budget-"));
  database = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
  await database.initialize();
});
afterEach(async () => { vi.restoreAllMocks(); await database.destroy(); await rm(directory, { recursive: true, force: true }); });
const config = () => loadTestConfig({ FILE_STORAGE_PATH: directory, WEB_UPLOAD_USER_MAX_BYTES: 10 });

it("serializes reservations across connections and preserves quotas after restart", async () => {
  const other = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
  try {
    const attempts = await Promise.allSettled([
      new UploadBudget(database.db, config()).reserve(42, 8),
      new UploadBudget(other.db, config()).reserve(42, 8),
    ]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toMatchObject([{ reason: { status: 413 } }]);
    const independent = await new UploadBudget(other.db, config()).reserve(84, 10);
    await independent.release();
    const reserved = attempts.find(attempt => attempt.status === "fulfilled")!;
    await reserved.value.release();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42 });
    const thread = await repos.threads.activeForUserTopic(42, null);
    const file = await repos.files.insertFile({ userId: 42, threadId: thread.id, type: "other", name: "old.bin", size: 8, isInline: false });
    await repos.turnRuns.accept({ userId: 42, threadId: thread.id, chatId: 42, messageThreadId: null, locale: "en",
      kind: "file", content: {}, textPlain: "Legacy upload", sources: [], webRequestId: "legacy_upload_01234567", attachments: [{ fileId: file.id }] });
    await database.destroy();
    database = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
    await database.initialize();
    await expect(new UploadBudget(database.db, config()).reserve(42, 3)).rejects.toMatchObject({ status: 413 });
    const next = await new UploadBudget(database.db, config()).reserve(84, 7);
    await next.release();
  } finally { await other.destroy(); }
});

it("allows each user their full quota beyond the former shared limit", async () => {
  const budget = new UploadBudget(database.db, loadTestConfig({ FILE_STORAGE_PATH: directory }));
  const reservations = await Promise.all([42, 84, 126].map(userId => budget.reserve(userId, 5 * 1024 ** 3)));
  try {
    await expect(budget.reserve(42, 1)).rejects.toMatchObject({ status: 413 });
  } finally { await Promise.all(reservations.map(reservation => reservation.release())); }
});

it("expires abandoned reservations, renews active ones, and fails closed when disk is full", async () => {
  const budget = new UploadBudget(database.db, config());
  const reservation = await budget.reserve(42, 8);
  await reservation.beforeWrite(8);
  await expect(requireUploadSpace(directory, 1, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ status: 507 });
  await database.db.execute(sql`update web_upload_reservations set expires_at = 0`);
  await expect(reservation.beforeWrite(1)).rejects.toMatchObject({ status: 503 });
  const next = await budget.reserve(42, 8);
  await reservation.release();
  await next.release();
  expect(await database.db.query(sql`select * from web_upload_reservations`)).toEqual([]);
});
