import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { AccessControl } from "../../src/access/control.js";
import { createApplication } from "../../src/application/runtime.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { FileResolver } from "../../src/files/resolver.js";
import { createLogger } from "../../src/logger.js";
import type { PiRuntimeService } from "../../src/pi/runtime.js";
import { deferred } from "../helpers/async.js";
import { savedCompactionAction } from "../../src/application/compactionAction.js";
import { CompactionGuardError } from "../../src/pi/compactionPolicy.js";

async function setup() {
  const config = loadTestConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const access = new AccessControl(db.db);
  await access.initialize();
  await access.allow(1001);
  await repos.users.ensure({ tgId: 1001, lang: "en", firstName: "Owner" });
  const fork = vi.fn<PiRuntimeService["fork"]>(async () => undefined);
  const compact = vi.fn<PiRuntimeService["compact"]>(async () => 2);
  const pi: PiRuntimeService = {
    runtime: async () => { throw new Error("Model runtime is not used in this test."); },
    captionImage: async () => "Image", generateThreadTitle: async () => "Thread",
    fork, compact, abort: async () => false, dispose: async () => undefined,
  };
  const application = createApplication({
    config, db, repos, access, logger, pi, fileResolver: new FileResolver(repos.files),
    t: (_locale, key) => key, awaitProcessingOnAccept: true,
    frontend: {
      activity: { schedule() {}, recover: async () => {}, waitForIdle: async () => {}, shutdown: async () => {} },
      async run(input) {
        const message = await repos.messages.insert({ threadId: input.thread.id, role: "assistant",
          textPlain: `Reply: ${input.text}`, content: { text: `Reply: ${input.text}` }, piEntryId: "checkpoint" });
        await input.onAwaitingDelivery?.({ assistantMessageId: message.id });
        if (!input.onDeliveryStarting?.()) throw new Error("Delivery was cancelled.");
        await input.onDeliveryConfirmed?.({ assistantMessageId: message.id });
      },
    },
  });
  return { ...application, fork, compact, async dispose() { await application.turnCoordinator.shutdown(); await db.destroy(); } };
}

describe("conversation backend without a Telegram client", () => {
  let app: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { app = await setup(); });
  afterEach(async () => { await app.dispose(); });

  it("shares durable turns and settings between frontend sources", async () => {
    const thread = await app.conversations.create({ userId: 1001, title: "Shared", origin: "web" });
    expect(thread.topic_id).toBeNull();
    await app.conversations.updateSettings(1001, { language: "ru", memoryEnabled: false });
    const first = await app.conversations.accept({ userId: 1001, threadId: thread.id,
      source: { kind: "web", requestId: randomUUID() }, kind: "text", text: "Website", content: { text: "Website" } });
    const second = await app.conversations.accept({ userId: 1001, threadId: thread.id,
      source: { kind: "telegram", chatId: 1001, updates: [{ updateId: 17, messageId: 19 }] },
      kind: "text", text: "Telegram", content: { text: "Telegram" } });
    expect((await app.repos.messages.listThread(thread.id)).map(message => message.text_plain))
      .toEqual(["Website", "Reply: Website", "Telegram", "Reply: Telegram"]);
    expect(await app.repos.turnRuns.get(first.turnRun.id)).toMatchObject({ status: "succeeded", locale: "ru", origin: "web" });
    expect(await app.repos.turnRuns.get(second.turnRun.id)).toMatchObject({ status: "succeeded", locale: "ru", origin: "telegram" });
    expect((await app.conversations.settings(1001)).memoryEnabled).toBe(false);
  });

  it("keeps fork visibility and compaction consistent across frontends", async () => {
    const thread = await app.conversations.create({ userId: 1001, title: "Parent", origin: "web" });
    await app.conversations.accept({ userId: 1001, threadId: thread.id, source: { kind: "web", requestId: randomUUID() },
      kind: "text", text: "Before fork", content: { text: "Before fork" } });
    const point = (await app.repos.messages.latest(thread.id))!;
    const fork = await app.conversations.fork({ userId: 1001, threadId: thread.id, origin: "telegram", messageId: point.id });
    expect(fork).toMatchObject({ parent_thread_id: thread.id, fork_point_message_id: point.id });
    expect(app.fork).toHaveBeenCalledWith(expect.objectContaining({ id: thread.id }), expect.objectContaining({ id: fork.id }),
      expect.objectContaining({ tg_id: 1001 }), "checkpoint", expect.any(AbortSignal));
    expect(await (await app.conversations.compact(1001, fork.id)).completion).toBe(2);
    expect(app.compact).toHaveBeenCalledTimes(1);
  });

  it("records progress and duration, coalesces duplicate requests, and preserves the completed action", async () => {
    const thread = await app.conversations.create({ userId: 1001, title: "Compact", origin: "web" });
    const finish = deferred<number>();
    app.compact.mockImplementation(() => finish.promise);
    const run = await app.conversations.compact(1001, thread.id);
    const same = await app.conversations.compact(1001, thread.id);
    expect(same.messageId).toBe(run.messageId);
    await vi.waitFor(() => expect(app.compact).toHaveBeenCalledOnce());
    const before = await app.repos.messages.get(run.messageId);
    expect(before?.role).toBe("system");
    const active = savedCompactionAction(before!.content_json);
    expect(active?.status).toBe("running");
    finish.resolve(12);
    expect(await run.completion).toBe(12);
    const saved = savedCompactionAction((await app.repos.messages.get(run.messageId))!.content_json);
    expect(saved).toMatchObject({ status: "succeeded", messagesCompacted: 12 });
    if (saved?.status !== "succeeded") throw new Error("Missing completed action");
    expect(saved.finishedAt).toBeGreaterThanOrEqual(saved.startedAt);
    expect((await app.repos.messages.listThread(thread.id))).toHaveLength(1);
  });

  it.each(["too_small", "recent", "unchanged"] as const)("persists a useful %s result without reporting success", async reason => {
    const thread = await app.conversations.create({ userId: 1001, title: "Guarded", origin: "web" });
    app.compact.mockRejectedValueOnce(new CompactionGuardError(reason));
    const run = await app.conversations.compact(1001, thread.id);
    await expect(run.completion).rejects.toMatchObject({ reason });
    expect(savedCompactionAction((await app.repos.messages.get(run.messageId))!.content_json))
      .toMatchObject({ status: "failed", reason });
  });

  it("records a provider failure and permits a retry", async () => {
    const thread = await app.conversations.create({ userId: 1001, title: "Retry", origin: "web" });
    app.compact.mockRejectedValueOnce(new Error("Private provider failure detail"));
    const run = await app.conversations.compact(1001, thread.id);
    await expect(run.completion).rejects.toThrow("Private provider failure detail");
    const saved = (await app.repos.messages.get(run.messageId))!;
    expect(savedCompactionAction(saved.content_json)).toMatchObject({ status: "failed", reason: "failed" });
    expect(saved.text_plain).not.toContain("Private provider");
    const retry = await app.conversations.compact(1001, thread.id);
    expect(retry.messageId).not.toBe(run.messageId);
    await retry.completion;
  });

  it("denies revoked accounts and cross-user access before durable writes", async () => {
    const thread = await app.conversations.create({ userId: 1001, title: "Private", origin: "web" });
    await app.access.allow(1002);
    await app.repos.users.ensure({ tgId: 1002, lang: "en" });
    await expect(app.conversations.thread(1002, thread.id)).rejects.toMatchObject({ status: 404 });
    await app.access.revoke(1001);
    await expect(app.conversations.accept({ userId: 1001, threadId: thread.id,
      source: { kind: "telegram", chatId: 1001, updates: [{ updateId: 21, messageId: 22 }] },
      kind: "text", text: "Blocked", content: { text: "Blocked" } })).rejects.toMatchObject({ status: 403 });
    expect(await app.db.db.query(sql`select * from messages`)).toHaveLength(0);
    expect(await app.db.db.query(sql`select * from turn_runs`)).toHaveLength(0);
  });
});
