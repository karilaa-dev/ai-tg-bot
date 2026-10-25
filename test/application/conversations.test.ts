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
    expect(await app.conversations.compact(1001, fork.id)).toBe(2);
    expect(app.compact).toHaveBeenCalledTimes(1);
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
