import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { GrammyError } from "grammy";
import { TurnActivityCoordinator } from "../../src/ai/turnActivity.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { deferred } from "../helpers/async.js";

describe("durable turn activity", () => {
  let db: AppDatabase;
  let repos: Repos;
  let runId: number;
  beforeEach(async () => {
    db = createDatabase(loadTestConfig());
    await db.initialize();
    repos = createRepos(db.db, db.search);
    await repos.users.ensure({ tgId: 1001, firstName: "Alice", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(1001, 42, "Planning");
    const accepted = await repos.turnRuns.accept({
      userId: 1001, threadId: thread.id, chatId: 1001, messageThreadId: 42,
      locale: "en", kind: "text", textPlain: "hello", content: { text: "hello" },
      sources: [{ updateId: 1, messageId: 1 }],
    });
    runId = accepted.turnRun.id;
  });
  afterEach(async () => { await db.destroy(); });

  function activity(setMessageReaction: (...args: any[]) => Promise<boolean>, syncThreadActivity = async () => true) {
    return new TurnActivityCoordinator({
      api: { raw: { setMessageReaction } } as never,
      repos, logger: createLogger(loadTestConfig()), syncThreadActivity,
    });
  }

  it.each([false, true])("corrects a delayed working reaction after peer cleanup, expired lease: %s", async (expireLease) => {
    const started = deferred<void>();
    const release = deferred<void>();
    let visibleReaction = false;
    let blocked = true;
    const setMessageReaction = vi.fn(async (payload: { reaction: unknown[] }) => {
      if (blocked && payload.reaction.length) {
        blocked = false;
        started.resolve();
        await release.promise;
      }
      visibleReaction = payload.reaction.length > 0;
      return true;
    });
    const first = activity(setMessageReaction);
    const peer = activity(setMessageReaction);
    first.schedule(runId);
    await started.promise;
    await repos.turnRuns.markFailed(runId, "generation_failed");
    if (expireLease) await db.db.execute(sql`update turn_activity_sync set lease_expires_at = 0 where turn_run_id = ${runId}`);
    peer.schedule(runId);
    await peer.waitForIdle();
    release.resolve();
    await first.waitForIdle();
    expect(visibleReaction).toBe(false);
    expect(await repos.turnActivity.pending(Date.now())).toEqual([]);
  });

  it("retains failed cleanup and retries it after restart", async () => {
    await repos.turnRuns.markFailed(runId, "generation_failed");
    const first = activity(vi.fn(async () => { throw new Error("Telegram unavailable"); }));
    first.schedule(runId);
    await first.waitForIdle();
    expect(await repos.turnActivity.pending(Date.now() + 6_000)).toEqual([runId]);
    await db.db.execute(sql`update turn_activity_sync set retry_at = 0 where turn_run_id = ${runId}`);
    const clear = vi.fn(async () => true);
    const restarted = activity(clear);
    await restarted.recover();
    await restarted.waitForIdle();
    expect(clear).toHaveBeenCalledWith({ chat_id: 1001, message_id: 1, reaction: [] }, expect.any(AbortSignal));
    expect(await repos.turnActivity.pending(Date.now())).toEqual([]);
  });

  it("retains cleanup when only the topic update fails", async () => {
    await repos.turnRuns.markFailed(runId, "generation_failed");
    const first = activity(vi.fn(async () => true), async () => false);
    first.schedule(runId);
    await first.waitForIdle();
    expect(await repos.turnActivity.pending(Date.now() + 6_000)).toEqual([runId]);
  });

  it("does not keep retrying cleanup for a deleted message", async () => {
    await repos.turnRuns.markFailed(runId, "generation_failed");
    const first = activity(vi.fn(async () => {
      throw new GrammyError("setMessageReaction", { ok: false, error_code: 400, description: "Bad Request: message to react not found" }, "setMessageReaction", {});
    }));
    first.schedule(runId);
    await first.waitForIdle();
    expect(await repos.turnActivity.pending(Date.now() + 6_000)).toEqual([]);
  });

  it("does not repeat confirmed cleanup after recovery", async () => {
    await repos.turnRuns.markFailed(runId, "generation_failed");
    const clear = vi.fn(async () => true);
    const first = activity(clear);
    first.schedule(runId);
    await first.waitForIdle();
    await db.initialize();
    const restarted = activity(clear);
    await restarted.recover();
    await restarted.waitForIdle();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
