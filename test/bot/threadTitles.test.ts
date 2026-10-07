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

  it("keeps the placeholder marker across repeated syncs and coordinator restarts", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith({ chat_id: 1001, message_thread_id: 42, name: "⏳" }, expect.any(AbortSignal));
    const restarted = new ThreadTitleCoordinator({ repos, pi: {} as never, logger: createLogger(loadTestConfig()) });
    await restarted.syncActivity(input);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect((await repos.threads.get(thread.id))?.title).toBe("Planning");
  });

  it("replaces the marker directly with a generated or manual title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "New topic", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    await titles.syncActivity(input);
    await repos.threads.setGeneratedTitleIfPlaceholder(thread.id, "Generated title");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Generated title" }), expect.any(AbortSignal));
    await repos.threads.applyTelegramTopicTitle(thread.id, "My title", false);
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "My title" }), expect.any(AbortSignal));
  });

  it("coalesces concurrent requests for the same title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    await Promise.all([titles.syncActivity(input), titles.syncActivity(input), titles.syncActivity(input)]);
    expect(editForumTopic.mock.calls.map(([payload]) => payload)).toEqual([
      { chat_id: 1001, message_thread_id: 42, name: "⏳" },
    ]);
  });

  it("repairs a manual rename that races an in-flight title request", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    const started = deferred<void>();
    const release = deferred<void>();
    editForumTopic.mockImplementationOnce(async () => { started.resolve(); await release.promise; return true; });
    const update = titles.syncActivity(input);
    await started.promise;
    await repos.threads.applyTelegramTopicTitle(thread.id, "My new title", false);
    await titles.observeTelegramTitle(1001, 42, "My new title");
    release.resolve();
    await update;
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "My new title" }), expect.any(AbortSignal));
  });

  it("retries a failed edit before remembering the title", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    editForumTopic.mockRejectedValueOnce(new Error("Telegram unavailable"));
    expect(await titles.syncActivity(input)).toBe(false);
    expect(await titles.syncActivity(input)).toBe(true);
    expect(await titles.syncActivity(input)).toBe(true);
    expect(editForumTopic).toHaveBeenCalledTimes(2);
    expect(editForumTopic).toHaveBeenLastCalledWith({ chat_id: 1001, message_thread_id: 42, name: "⏳" }, expect.any(AbortSignal));
  });

  it("respects an observed manual rename even when the saved title is unchanged", async () => {
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning", "placeholder");
    const input = { api, chatId: 1001, threadId: thread.id };
    await titles.syncActivity(input);
    await titles.observeTelegramTitle(1001, 42, "Planning");
    await titles.syncActivity(input);
    expect(editForumTopic).toHaveBeenCalledTimes(2);
    expect(editForumTopic).toHaveBeenLastCalledWith(expect.objectContaining({ name: "⏳" }), expect.any(AbortSignal));
  });

  it("preserves emoji in explicit topic names", async () => {
    const original = "🌲".repeat(128);
    const thread = await repos.threads.activeForUserTopic(1001, 42, original, "explicit");
    await titles.observeTelegramTitle(1001, 42, original);
    const input = { api, chatId: 1001, threadId: thread.id };
    await titles.syncActivity(input);
    expect(editForumTopic).not.toHaveBeenCalled();
    expect((await repos.threads.get(thread.id))?.title).toBe(original);
  });
});
