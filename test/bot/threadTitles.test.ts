import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { ThreadTitleCoordinator } from "../../src/bot/threadTitles.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { deferred } from "../helpers/async.js";

describe("thread activity titles", () => {
  let db: AppDatabase;
  let repos: Repos;
  let titles: ThreadTitleCoordinator;
  const editForumTopic = vi.fn(async (_payload: unknown) => true);
  const api = { raw: { editForumTopic } } as unknown as Api;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 1001, firstName: "Alice", lang: "en" });
    titles = new ThreadTitleCoordinator({ repos, pi: {} as never, logger: createLogger(config) });
    editForumTopic.mockClear();
  });

  afterEach(async () => {
    await titles.waitForIdle();
    await db.destroy();
  });

  async function accept(threadId: number, updateId: number) {
    return repos.turnRuns.accept({
      userId: 1001, chatId: 1001, threadId, messageThreadId: 42,
      locale: "en", kind: "text", content: { text: "hello" }, textPlain: "hello",
      sources: [{ updateId, messageId: updateId }],
    });
  }

  it("keeps the marker until the whole queue finishes and preserves the saved title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    const first = await accept(thread.id, 1);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith({ chat_id: 1001, message_thread_id: 42, name: "⏳ Planning" }, expect.any(AbortSignal));
    const second = await accept(thread.id, 2);
    await repos.turnRuns.markFailed(first.turnRun.id, "generation_failed");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenLastCalledWith({ chat_id: 1001, message_thread_id: 42, name: "⏳ Planning" }, expect.any(AbortSignal));
    expect((await repos.threads.get(thread.id))?.title).toBe("Planning");
    await repos.turnRuns.markFailed(second.turnRun.id, "generation_failed");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith({ chat_id: 1001, message_thread_id: 42, name: "Planning" }, expect.any(AbortSignal));
  });

  it("restores a title generated or manually renamed during work", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "New topic", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    const run = await accept(thread.id, 1);
    await titles.syncActivity(input);
    await repos.threads.setGeneratedTitleIfPlaceholder(thread.id, "Generated title");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "⏳ Generated title" }), expect.any(AbortSignal));
    await repos.threads.applyTelegramTopicTitle(thread.id, "My title", false);
    await repos.turnRuns.markFailed(run.turnRun.id, "generation_failed");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "My title" }), expect.any(AbortSignal));
  });

  it("serializes a slow working-title edit before cleanup", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    const run = await accept(thread.id, 1);
    const started = deferred<void>();
    const release = deferred<void>();
    editForumTopic.mockImplementationOnce(async () => { started.resolve(); await release.promise; return true; });
    const working = titles.syncActivity(input);
    await started.promise;
    await repos.turnRuns.markFailed(run.turnRun.id, "generation_failed");
    const cleanup = titles.syncActivity(input);
    release.resolve();
    await Promise.all([working, cleanup]);
    expect(editForumTopic.mock.calls.map(([payload]) => payload)).toEqual([
      { chat_id: 1001, message_thread_id: 42, name: "⏳ Planning" },
      { chat_id: 1001, message_thread_id: 42, name: "Planning" },
    ]);
  });

  it("coalesces concurrent requests for the same title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    await accept(thread.id, 1);
    await Promise.all([titles.syncActivity(input), titles.syncActivity(input), titles.syncActivity(input)]);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("repairs a manual rename that races an in-flight title request", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    await accept(thread.id, 1);
    const started = deferred<void>();
    const release = deferred<void>();
    editForumTopic.mockImplementationOnce(async () => { started.resolve(); await release.promise; return true; });
    const update = titles.syncActivity(input);
    await started.promise;
    await repos.threads.applyTelegramTopicTitle(thread.id, "My new title", false);
    await titles.observeTelegramTitle(1001, 42, "My new title");
    release.resolve();
    await update;
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "⏳ My new title" }), expect.any(AbortSignal));
  });

  it("does not trust an old working-title cache after a peer clears the title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    const first = await accept(thread.id, 1);
    await titles.syncActivity(input);
    await repos.turnRuns.markFailed(first.turnRun.id, "done");
    const peer = new ThreadTitleCoordinator({ repos, pi: {} as never, logger: createLogger(loadTestConfig()) });
    await peer.syncActivity(input);
    await accept(thread.id, 2);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "⏳ Planning" }), expect.any(AbortSignal));
  });

  it("retries a failed edit before remembering the title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    await accept(thread.id, 1);
    editForumTopic.mockRejectedValueOnce(new Error("Telegram unavailable"));
    await titles.syncActivity(input);
    await titles.syncActivity(input);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenCalledTimes(2);
  });

  it("respects an observed manual rename even when the saved title is unchanged", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const input = { api, chatId: 1001, threadId: thread.id };
    await accept(thread.id, 1);
    await titles.syncActivity(input);
    await titles.observeTelegramTitle(1001, 42, "Planning");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenCalledTimes(2);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "⏳ Planning" }), expect.any(AbortSignal));
  });

  it("truncates only the working title to Telegram's limit", async () => {
    const original = "🌲".repeat(128);
    const thread = await repos.threads.activeForUserTopic(1001, 42, original);
    const input = { api, chatId: 1001, threadId: thread.id };
    const run = await accept(thread.id, 1);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: `⏳ ${"🌲".repeat(126)}` }), expect.any(AbortSignal));
    await repos.turnRuns.markFailed(run.turnRun.id, "generation_failed");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: original }), expect.any(AbortSignal));
  });
});
