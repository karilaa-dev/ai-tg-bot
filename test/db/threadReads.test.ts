import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MessagesRepo } from "../../src/db/repos/messages.js";
import { deferred } from "../helpers/async.js";
import { sql } from "drizzle-orm";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import type { ThreadRow } from "../../src/db/types.js";

for (const dialect of ["sqlite", "postgres"] as const) {
describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} persistent thread read cursors`, () => {
  let db: AppDatabase;
  let repos: Repos;
  let thread: ThreadRow;
  let admin: AppDatabase | undefined;
  let schema: string;
  beforeEach(async () => {
    schema = `thread_reads_${randomUUID().replaceAll("-", "")}`;
    admin = dialect === "postgres" ? createDatabase(loadTestConfig({ DB_URL: process.env.TEST_POSTGRES_URL! })) : undefined;
    const url = admin ? new URL(process.env.TEST_POSTGRES_URL!) : undefined;
    if (admin && url) {
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      url.searchParams.set("options", `-c search_path=${schema}`);
    }
    db = createDatabase(loadTestConfig({ DB_URL: url?.toString() ?? "sqlite::memory:" }));
    await db.initialize();
    repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 42 });
    await repos.users.ensure({ tgId: 84 });
    thread = await repos.threads.create({ origin: "web", userId: 42, title: "Read state", topicId: null });
  });
  afterEach(async () => {
    await db?.destroy();
    if (admin) {
      await admin.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await admin.destroy();
    }
  });
  const message = (text: string, threadId = thread.id) => repos.messages.insert({ threadId, role: "assistant", textPlain: text, content: { text } });
  const state = async (threadId = thread.id) => (await repos.threadReads.states(42, [threadId])).get(threadId);

  it.each(["web", "telegram"] as const)("limits unread to web-origin chats and persists acknowledgement (%s)", async origin => {
    await db.db.execute(sql`update threads set origin = ${origin} where id = ${thread.id}`);
    expect(await state()).toEqual({ unread: false, lastMessageId: null, readMessageId: null });
    const first = await message("First response");
    expect(await state()).toEqual({ unread: origin === "web", lastMessageId: first.id, readMessageId: null });
    expect(await repos.threadReads.markRead(42, thread.id, first.id)).toMatchObject({ unread: false, readMessageId: first.id });
    await db.initialize();
    repos = createRepos(db.db, db.search);
    expect(await state()).toMatchObject({ unread: false, readMessageId: first.id });
    const second = await message("Another response");
    expect(await state()).toEqual({ unread: origin === "web", lastMessageId: second.id, readMessageId: first.id });
  });

  it("keeps delayed and concurrent acknowledgements monotonic without swallowing later messages", async () => {
    const first = await message("First");
    const second = await message("Second");
    const latest = await message("Newer than either request");
    await Promise.all([
      repos.threadReads.markRead(42, thread.id, second.id),
      repos.threadReads.markRead(42, thread.id, first.id),
    ]);
    expect(await state()).toEqual({ unread: true, readMessageId: second.id, lastMessageId: latest.id });
    expect(await repos.threadReads.markRead(42, thread.id, latest.id + 100)).toBeUndefined();
    expect(await state()).toMatchObject({ unread: true, readMessageId: second.id });
  });

  it.skipIf(dialect !== "postgres")("commits an earlier assistant before a later accepted user message can pass it", async () => {
    const inserted = deferred<number>();
    const release = deferred<void>();
    const earlier = db.db.transaction(async tx => {
      const row = await new MessagesRepo(tx).insert({ threadId: thread.id, role: "assistant", textPlain: "Earlier response", content: {} });
      inserted.resolve(row.id);
      await release.promise;
      return row;
    });
    const earlierId = await inserted.promise;
    let accepted = false;
    const later = repos.turnRuns.accept({ userId: 42, threadId: thread.id, chatId: 42, messageThreadId: null,
      locale: "en", kind: "text", textPlain: "Later user message", content: {}, sources: [{ updateId: 991, messageId: 991 }] })
      .then(value => { accepted = true; return value; });
    try {
      // Another thread can allocate and commit while this thread's writer waits.
      const other = await repos.threads.create({ origin: "web", userId: 42, topicId: 42, title: "Independent" });
      await message("Independent response", other.id);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(accepted).toBe(false);
      expect(await repos.messages.listThread(thread.id)).toEqual([]);
      expect(await repos.threadReads.markRead(42, thread.id, earlierId)).toBeUndefined();
    } finally { release.resolve(); }
    const [assistant, user] = await Promise.all([earlier, later]);
    expect(assistant.id).toBeLessThan(user.userMessage.id);
    expect(await state()).toMatchObject({ unread: true, lastMessageId: user.userMessage.id });
    expect(await repos.threadReads.markRead(42, thread.id, user.userMessage.id)).toMatchObject({ unread: false });
  });

  it("counts real saved attachments but ignores empty metadata, whitespace, thinking and user messages", async () => {
    await repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "User text" });
    const metadata = await repos.messages.insert({ threadId: thread.id, role: "assistant", content: { toolActivity: { cancelled: true }, files: [123] }, textPlain: " \n\t ", thinking: "Thinking only" });
    expect(await state()).toMatchObject({ unread: false, lastMessageId: metadata.id });
    const attachment = await message("");
    const file = await repos.files.insertFile({ userId: 42, threadId: thread.id, type: "other", name: "archive.zip", size: 10, isInline: false });
    await repos.files.attachToMessage(attachment.id, file.id);
    expect(await state()).toMatchObject({ unread: true });
    await repos.threadReads.markRead(42, thread.id, attachment.id);
    const directlyOwned = await message("");
    await repos.files.insertFile({ userId: 42, threadId: thread.id, messageId: directlyOwned.id, type: "image", name: "image.png", size: 10, isInline: false });
    expect(await state()).toMatchObject({ unread: true, lastMessageId: directlyOwned.id });
  });

  it("respects inherited fork cutoffs and keeps sibling and owner cursors independent", async () => {
    const inherited = await message("Inherited");
    const fork = await repos.threads.create({ origin: "web", userId: 42, title: "Fork", topicId: 2, parentThreadId: thread.id, forkPointMessageId: inherited.id });
    const outside = await message("Past fork cutoff");
    const forkOwn = await message("Only in first fork", fork.id);
    const nested = await repos.threads.create({ origin: "web", userId: 42, title: "Nested", topicId: 3, parentThreadId: fork.id, forkPointMessageId: inherited.id });
    expect(await state(nested.id)).toEqual({ unread: true, readMessageId: null, lastMessageId: inherited.id });
    for (const id of [outside.id, forkOwn.id]) expect(await repos.threadReads.markRead(42, nested.id, id)).toBeUndefined();
    await repos.threadReads.markRead(42, nested.id, inherited.id);
    expect(await state(nested.id)).toMatchObject({ unread: false });
    expect(await state(fork.id)).toMatchObject({ unread: true, readMessageId: null });
    expect(await state()).toMatchObject({ unread: true, readMessageId: null });
    expect(await repos.threadReads.markRead(84, thread.id, inherited.id)).toBeUndefined();
    const foreign = await repos.threads.create({ origin: "web", userId: 84, title: "Foreign", topicId: null });
    const secret = await message("Foreign message", foreign.id);
    const malformed = await repos.threads.create({ origin: "web", userId: 42, title: "Cross-owner parent", topicId: 4, parentThreadId: foreign.id, forkPointMessageId: secret.id });
    expect(await state(malformed.id)).toMatchObject({ unread: false, lastMessageId: null });
    expect(await repos.threadReads.markRead(42, malformed.id, secret.id)).toBeUndefined();
    expect(await repos.threadReads.markRead(42, thread.id, secret.id)).toBeUndefined();
  });

  it.each(["complete", "expired", "cancelled"])("does not acknowledge pending delivery before content becomes visible (%s)", async outcome => {
    const before = await message("Earlier response");
    const accepted = await repos.turnRuns.accept({ userId: 42, threadId: thread.id, chatId: 42, messageThreadId: null,
      locale: "en", kind: "text", textPlain: "Generate file", content: {}, sources: [{ updateId: 1, messageId: 1 }] });
    await db.db.execute(sql`update turn_runs set status = 'awaiting_delivery', lease_expires_at = ${Date.now() + 60_000} where id = ${accepted.turnRun.id}`);
    const pending = await repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "", content: { attachmentDeliveryTurnId: accepted.turnRun.id } });
    const file = await repos.files.insertFile({ userId: 42, threadId: thread.id, messageId: pending.id, type: "other", name: "report.zip", size: 10, isInline: false });
    const after = await repos.messages.insert({ threadId: thread.id, role: "user", textPlain: "Next message", content: {} });
    await repos.threadReads.markRead(42, thread.id, after.id);
    expect(await state()).toEqual({ unread: false, lastMessageId: accepted.userMessage.id, readMessageId: accepted.userMessage.id });
    expect(accepted.userMessage.id).toBeGreaterThan(before.id);
    if (outcome === "complete") {
      await repos.messages.setDeliveryContent({ messageId: pending.id, textPlain: "Your report", content: { files: [file.id] }, tgMessageId: null });
    } else if (outcome === "expired") {
      await db.db.execute(sql`update turn_runs set lease_expires_at = 0 where id = ${accepted.turnRun.id}`);
      expect(await state()).toEqual({ unread: true, lastMessageId: accepted.userMessage.id, readMessageId: accepted.userMessage.id });
      await repos.threadReads.markRead(42, thread.id, after.id);
      expect(await state()).toMatchObject({ unread: true, readMessageId: accepted.userMessage.id });
      await db.db.execute(sql`update turn_runs set status = 'interrupted' where id = ${accepted.turnRun.id}`);
    } else {
      await db.db.execute(sql`update turn_runs set status = 'cancelled' where id = ${accepted.turnRun.id}`);
    }
    expect(await state()).toEqual({ unread: true, lastMessageId: after.id, readMessageId: accepted.userMessage.id });
    await repos.threadReads.markCurrentRead(42, thread.id);
    expect(await state()).toMatchObject({ unread: false, readMessageId: after.id });
  });

  it("shows pending answer text as unread without acknowledging its still-hidden files", async () => {
    const accepted = await repos.turnRuns.accept({ userId: 42, threadId: thread.id, chatId: 42, messageThreadId: null,
      locale: "en", kind: "text", textPlain: "Generate file", content: {}, sources: [{ updateId: 1, messageId: 1 }] });
    await db.db.execute(sql`update turn_runs set status = 'awaiting_delivery', lease_expires_at = ${Date.now() + 60_000} where id = ${accepted.turnRun.id}`);
    const pending = await repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Visible answer", content: { attachmentDeliveryTurnId: accepted.turnRun.id } });
    expect(await state()).toEqual({ unread: true, lastMessageId: accepted.userMessage.id, readMessageId: null });
    await repos.threadReads.markRead(42, thread.id, pending.id);
    expect(await state()).toMatchObject({ unread: true, readMessageId: accepted.userMessage.id });
    await repos.files.insertFile({ userId: 42, threadId: thread.id, messageId: pending.id, type: "other", name: "report.zip", size: 10, isInline: false });
    await repos.messages.setDeliveryContent({ messageId: pending.id, textPlain: "Visible answer", content: {}, tgMessageId: null });
    expect(await state()).toMatchObject({ unread: true, lastMessageId: pending.id });
    expect(await repos.threadReads.markRead(42, thread.id, pending.id)).toMatchObject({ unread: false, readMessageId: pending.id });
  });
});
}
