import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
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

  it("commits attachment associations with acceptance and repairs them on a duplicate update", async () => {
    const { userId, threadId } = await ownership(repos, 805);
    const file = await repos.files.insertFile({
      userId,
      threadId,
      type: "pdf",
      mimeType: "application/pdf",
      extractionStatus: "source_only",
      name: "queued.pdf",
      size: 100,
      isInline: false,
    });
    const input = {
      ...request(userId, threadId, 5001, "inspect the PDF"),
      attachments: [{ fileId: file.id, displayName: "queued.pdf", caption: "inspect" }],
    };

    const accepted = await repos.turnRuns.accept(input);
    expect(await repos.files.listForMessage(accepted.userMessage.id)).toEqual([
      expect.objectContaining({ id: file.id }),
    ]);

    await db.db.execute(sql`delete from message_files where message_id = ${accepted.userMessage.id}`);
    await db.db.execute(sql`update files set message_id = null where id = ${file.id}`);
    const duplicate = await repos.turnRuns.accept(input);

    expect(duplicate.created).toBe(false);
    expect(await repos.files.listForMessage(accepted.userMessage.id)).toEqual([
      expect.objectContaining({ id: file.id }),
    ]);
  });

  it("does not claim a later or concurrent turn while a thread owner is active", async () => {
    const { userId, threadId } = await ownership(repos, 806);
    const first = await repos.turnRuns.accept(request(userId, threadId, 6001, "first"));
    const second = await repos.turnRuns.accept(request(userId, threadId, 6002, "second"));

    await expect(repos.turnRuns.claimRunning(second.turnRun.id)).resolves.toBeUndefined();
    await expect(repos.turnRuns.claimRunning(first.turnRun.id)).resolves.toMatchObject({ status: "running" });
    await expect(repos.turnRuns.claimRunning(second.turnRun.id)).resolves.toBeUndefined();
    await repos.turnRuns.markSucceeded(first.turnRun.id);
    await expect(repos.turnRuns.claimRunning(second.turnRun.id)).resolves.toMatchObject({ status: "running" });
  });

  it("rejects late cancellation once final delivery has acquired its barrier", async () => {
    const { userId, threadId } = await ownership(repos, 807);
    const deliveryStarted = deferred<void>();
    const release = deferred<void>();
    const coordinator = createCoordinator(db, repos, async (input) => {
      expect(input.onDeliveryStarting?.()).toBe(true);
      deliveryStarted.resolve();
      await release.promise;
      await confirmDelivery(input);
    });

    await coordinator.accept(request(userId, threadId, 7001, "deliver"));
    await deliveryStarted.promise;
    await expect(coordinator.cancelActive(threadId)).resolves.toBe(false);
    release.resolve();
    await coordinator.waitForIdle();

    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
    await coordinator.shutdown();
  });

  it("supervises a transient drain failure and later executes the queued turn", async () => {
    const { userId, threadId } = await ownership(repos, 808);
    const originalNextQueued = repos.turnRuns.nextQueued.bind(repos.turnRuns);
    let failOnce = true;
    vi.spyOn(repos.turnRuns, "nextQueued").mockImplementation(async (id) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("temporary database outage");
      }
      return originalNextQueued(id);
    });
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });

    await coordinator.accept(request(userId, threadId, 8001, "retry me"));
    await coordinator.waitForIdle();

    expect(executed).toEqual(["retry me"]);
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
    await coordinator.shutdown();
  });

  it("persists the new portion of a mixed duplicate and new-source batch", async () => {
    const { userId, threadId } = await ownership(repos, 809);
    const firstFile = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      name: "first.txt",
      size: 5,
      contentMd: "first",
      isInline: true,
    });
    const secondFile = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      name: "second.txt",
      size: 6,
      contentMd: "second",
      isInline: true,
    });
    const firstInput = {
      ...request(userId, threadId, 9001, "first"),
      attachments: [{ fileId: firstFile.id, telegramMessageId: 19_001 }],
    };
    const first = await repos.turnRuns.accept(firstInput);
    const mixed = await repos.turnRuns.accept({
      ...request(userId, threadId, 9002, "first\n\nsecond"),
      sources: [
        { updateId: 9001, messageId: 19_001 },
        { updateId: 9002, messageId: 19_002 },
      ],
      attachments: [
        { fileId: firstFile.id, telegramMessageId: 19_001 },
        { fileId: secondFile.id, telegramMessageId: 19_002 },
      ],
    });

    expect(first.created).toBe(true);
    expect(mixed.created).toBe(true);
    expect(mixed.turnRun.id).not.toBe(first.turnRun.id);
    expect(await repos.files.listForMessage(mixed.userMessage.id)).toEqual([
      expect.objectContaining({ id: secondFile.id }),
    ]);
    const sources = await db.db.query<{ turn_run_id: number; telegram_update_id: number }>(sql`
      select turn_run_id, telegram_update_id from turn_run_sources order by telegram_update_id
    `);
    expect(sources).toEqual([
      { turn_run_id: first.turnRun.id, telegram_update_id: 9001 },
      { turn_run_id: mixed.turnRun.id, telegram_update_id: 9002 },
    ]);
  });

  it("does not accept a turn after shutdown starts while recovery is pending", async () => {
    const { userId, threadId } = await ownership(repos, 810);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<void>();
    vi.spyOn(repos.turnRuns, "interruptStaleRunning").mockImplementationOnce(async () => {
      recoveryStarted.resolve();
      await releaseRecovery.promise;
      return 0;
    });
    const coordinator = createCoordinator(db, repos, async () => undefined);
    await recoveryStarted.promise;
    const accepting = coordinator.accept(request(userId, threadId, 10_001, "too late"));
    const shuttingDown = coordinator.shutdown();
    releaseRecovery.resolve();

    await expect(accepting).rejects.toThrow("shutting down");
    await shuttingDown;
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([]);
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
