import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTurnCoordinator } from "../../src/ai/threadTurnCoordinator.js";
import type { TurnInput } from "../../src/ai/run.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";

describe("ThreadTurnCoordinator", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    db = createDatabase(loadTestConfig());
    await db.initialize();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs identical messages with distinct update IDs FIFO and deduplicates a retried update", async () => {
    const { userId, threadId } = await ownership(repos, 801);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const executed: Array<{ text: string; messageId: number }> = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push({ text: input.text, messageId: input.userMessageId! });
      if (executed.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await confirmDelivery(input);
    });

    const first = await coordinator.accept(request(userId, threadId, 1001, "same text"));
    await firstStarted.promise;
    const second = await coordinator.accept(request(userId, threadId, 1002, "same text"));
    const duplicate = await coordinator.accept(request(userId, threadId, 1002, "same text"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.queuedBehind).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.turnRun.id).toBe(second.turnRun.id);
    expect(first.userMessage.id).not.toBe(second.userMessage.id);

    releaseFirst.resolve();
    await coordinator.waitForIdle();
    expect(executed).toEqual([
      { text: "same text", messageId: first.userMessage.id },
      { text: "same text", messageId: second.userMessage.id },
    ]);
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["succeeded", "succeeded"]);
    await coordinator.shutdown();
  });

  it("cancels only the active turn and continues with the queued turn", async () => {
    const { userId, threadId } = await ownership(repos, 802);
    const firstStarted = deferred<void>();
    const executed: string[] = [];
    const abort = vi.fn(async () => true);
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      if (input.text === "first") {
        firstStarted.resolve();
        await waitForAbort(input.signal!);
      } else {
        await confirmDelivery(input);
      }
    }, abort);

    await coordinator.accept(request(userId, threadId, 2001, "first"));
    await firstStarted.promise;
    await coordinator.accept(request(userId, threadId, 2002, "second"));
    await expect(coordinator.cancelActive(threadId)).resolves.toBe(true);
    await coordinator.waitForIdle();

    expect(abort).toHaveBeenCalledWith(threadId);
    expect(executed).toEqual(["first", "second"]);
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["cancelled", "succeeded"]);
    await coordinator.shutdown();
  });

  it("marks stale running work interrupted and resumes only queued work", async () => {
    const { userId, threadId } = await ownership(repos, 803);
    const stale = await repos.turnRuns.accept(request(userId, threadId, 3001, "stale"));
    const queued = await repos.turnRuns.accept(request(userId, threadId, 3002, "resume"));
    await repos.turnRuns.claimRunning(stale.turnRun.id);
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });

    await coordinator.waitForIdle();

    expect(executed).toEqual(["resume"]);
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["interrupted", "succeeded"]);
    expect(queued.turnRun.status).toBe("queued");
    await coordinator.shutdown();
  });

  it("records ambiguous Telegram delivery without replaying the accepted turn", async () => {
    const { userId, threadId } = await ownership(repos, 804);
    let executions = 0;
    const coordinator = createCoordinator(db, repos, async (input) => {
      executions += 1;
      await input.onAwaitingDelivery?.({ assistantMessageId: 77 });
      await input.onDeliveryUnknown?.({
        assistantMessageId: 77,
        failureCode: "telegram_delivery_unknown",
      });
    });

    await coordinator.accept(request(userId, threadId, 4001, "ambiguous"));
    await coordinator.waitForIdle();

    expect(executions).toBe(1);
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({
        status: "failed",
        delivery_status: "unknown",
        result_message_id: 77,
        failure_code: "telegram_delivery_unknown",
      }),
    ]);
    await coordinator.shutdown();
  });
});

function createCoordinator(
  db: AppDatabase,
  repos: Repos,
  runner: (input: TurnInput) => Promise<void>,
  abort = vi.fn(async () => false),
): ThreadTurnCoordinator {
  const config = loadTestConfig();
  return new ThreadTurnCoordinator({
    api: {} as never,
    config,
    db,
    repos,
    logger: createLogger({ ...config, LOG_LEVEL: "error" }),
    pi: { abort } as never,
    fileResolver: { resolveFile: vi.fn() } as never,
    turnRunner: runner,
    t: (_locale, key) => key,
  });
}

async function ownership(repos: Repos, id: number): Promise<{ userId: number; threadId: number }> {
  const user = await repos.users.ensure({ tgId: id, firstName: "Queue", lang: "en" });
  const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
  return { userId: user.tg_id, threadId: thread.id };
}

function request(userId: number, threadId: number, updateId: number, textPlain: string) {
  return {
    userId,
    threadId,
    chatId: userId,
    messageThreadId: null,
    locale: "en" as const,
    kind: "text" as const,
    content: { text: textPlain },
    textPlain,
    sources: [{ updateId, messageId: updateId + 10_000 }],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function confirmDelivery(input: TurnInput): Promise<void> {
  const assistantMessageId = input.userMessageId!;
  await input.onAwaitingDelivery?.({ assistantMessageId });
  await input.onDeliveryConfirmed?.({ assistantMessageId });
}
