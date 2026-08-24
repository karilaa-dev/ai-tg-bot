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
    vi.useRealTimers();
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
    await repos.turnRuns.claimRunning(stale.turnRun.id, "expired-owner", Date.now() - 1);
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

  it("does not recurse on a non-race failure in a mixed existing-source batch", async () => {
    const { userId, threadId } = await ownership(repos, 815);
    await repos.turnRuns.accept(request(userId, threadId, 15_001, "already accepted"));
    const transaction = vi.spyOn(db.db, "transaction");

    await expect(repos.turnRuns.accept({
      ...request(userId, threadId, 15_002, "already accepted\n\nmissing attachment"),
      sources: [
        { updateId: 15_001, messageId: 25_001 },
        { updateId: 15_002, messageId: 25_002 },
      ],
      attachments: [{ fileId: 999_999, telegramMessageId: 25_002 }],
    })).rejects.toThrow("does not exist");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await repos.turnRuns.listForThread(threadId)).toHaveLength(1);
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

  it("interrupts a crashed pre-lease owner after the rolling-deploy grace period", async () => {
    const { userId, threadId } = await ownership(repos, 814);
    const first = await repos.turnRuns.accept(request(userId, threadId, 14_001, "legacy active"));
    const second = await repos.turnRuns.accept(request(userId, threadId, 14_002, "resume after grace"));
    await repos.turnRuns.claimRunning(first.turnRun.id, "old-process", Date.now() + 60_000);
    await db.db.execute(sql`
      update turn_runs set owner_id = null, lease_expires_at = null, updated_at = 100
      where id = ${first.turnRun.id}
    `);

    await expect(repos.turnRuns.claimRunning(
      second.turnRun.id,
      "new-process",
      Date.now() + 60_000,
      101,
    )).resolves.toMatchObject({ status: "running", owner_id: "new-process" });
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["interrupted", "running"]);
  });

  it("fences terminal writes from an owner whose lease expired", async () => {
    const { userId, threadId } = await ownership(repos, 822);
    const accepted = await repos.turnRuns.accept(request(userId, threadId, 22_001, "expired owner"));
    await repos.turnRuns.claimRunning(accepted.turnRun.id, "expired-process", Date.now() - 1);

    await repos.turnRuns.markSucceeded(accepted.turnRun.id, accepted.userMessage.id, "expired-process");
    expect(await repos.turnRuns.get(accepted.turnRun.id)).toMatchObject({ status: "running" });
    await repos.turnRuns.interruptStaleRunning();
    await repos.turnRuns.markFailed(accepted.turnRun.id, "late_failure", "failed", "expired-process");

    expect(await repos.turnRuns.get(accepted.turnRun.id)).toMatchObject({
      status: "interrupted",
      owner_id: null,
      lease_expires_at: null,
      failure_code: "process_interrupted",
    });
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
        {
          updateId: 9001,
          messageId: 19_001,
          payload: {
            kind: "file",
            textPlain: "first",
            content: { text: "first", captions: [], files: [{ id: firstFile.id }] },
          },
        },
        {
          updateId: 9002,
          messageId: 19_002,
          payload: {
            kind: "file",
            textPlain: "second",
            content: { text: "second", captions: [], files: [{ id: secondFile.id }] },
          },
        },
      ],
      attachments: [
        { fileId: firstFile.id, telegramMessageId: 19_001 },
        { fileId: secondFile.id, telegramMessageId: 19_002 },
      ],
    });

    expect(first.created).toBe(true);
    expect(mixed.created).toBe(true);
    expect(mixed.turnRun.id).not.toBe(first.turnRun.id);
    expect(mixed.userMessage.text_plain).toBe("second");
    expect(JSON.parse(mixed.userMessage.content_json)).toEqual({
      text: "second",
      captions: [],
      files: [{ id: secondFile.id }],
    });
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

  it("retries transient startup recovery failures", async () => {
    const { userId, threadId } = await ownership(repos, 816);
    const recover = repos.turnRuns.interruptStaleRunning.bind(repos.turnRuns);
    const recovery = vi.spyOn(repos.turnRuns, "interruptStaleRunning")
      .mockRejectedValueOnce(new Error("temporary recovery outage"))
      .mockImplementation(recover);
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });

    await coordinator.accept(request(userId, threadId, 16_001, "accepted after recovery"));
    await coordinator.waitForIdle();

    expect(recovery.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(executed).toEqual(["accepted after recovery"]);
    await coordinator.shutdown();
  });

  it("preserves a live turn owned by an overlapping coordinator", async () => {
    const { userId, threadId } = await ownership(repos, 811);
    const active = await repos.turnRuns.accept(request(userId, threadId, 11_001, "active elsewhere"));
    await repos.turnRuns.accept(request(userId, threadId, 11_002, "queued here"));
    await repos.turnRuns.claimRunning(active.turnRun.id, "other-process", Date.now() + 60_000);
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toEqual([]);
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["running", "queued"]);
    await coordinator.shutdown();
  });

  it("aborts a local turn when its renewal remains pending past the owner lease", async () => {
    vi.useFakeTimers();
    const { userId, threadId } = await ownership(repos, 829);
    const started = deferred<void>();
    const aborted = deferred<void>();
    const abort = vi.fn(async () => true);
    vi.spyOn(repos.turnRuns, "renewLease").mockReturnValue(new Promise<boolean>(() => undefined));
    vi.spyOn(repos.turnRuns, "cancellationRequested").mockResolvedValue(false);
    const coordinator = createCoordinator(db, repos, async (input) => {
      started.resolve();
      await waitForAbort(input.signal!);
      aborted.resolve();
    }, abort);
    await coordinator.accept(request(userId, threadId, 29_001, "lease deadline"));
    await started.promise;

    await vi.advanceTimersByTimeAsync(60_000);
    await aborted.promise;

    expect(abort).toHaveBeenCalledWith(threadId);
    await coordinator.waitForIdle();
    await coordinator.shutdown();
  });

  it("waits for an externally owned turn before reporting a thread idle", async () => {
    const { userId, threadId } = await ownership(repos, 812);
    const active = await repos.turnRuns.accept(request(userId, threadId, 12_001, "external"));
    await repos.turnRuns.claimRunning(active.turnRun.id, "other-process", Date.now() + 60_000);
    const coordinator = createCoordinator(db, repos, async () => undefined);
    let settled = false;
    const waiting = coordinator.waitForIdle(threadId).then(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await repos.turnRuns.markSucceeded(active.turnRun.id);
    await waiting;
    expect(settled).toBe(true);
    await coordinator.shutdown();
  });

  it("reaps an expired external owner while waiting for a thread to become idle", async () => {
    const { userId, threadId } = await ownership(repos, 817);
    const active = await repos.turnRuns.accept(request(userId, threadId, 17_001, "owner will disappear"));
    await repos.turnRuns.claimRunning(active.turnRun.id, "other-process", Date.now() + 50);
    const coordinator = createCoordinator(db, repos, async () => undefined);

    await coordinator.waitForIdle(threadId);

    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ]);
    await coordinator.shutdown();
  });

  it("routes cancellation to the coordinator that owns the turn", async () => {
    const { userId, threadId } = await ownership(repos, 818);
    const started = deferred<void>();
    const abort = vi.fn(async () => true);
    const owner = createCoordinator(db, repos, async (input) => {
      started.resolve();
      await waitForAbort(input.signal!);
    }, abort);
    await owner.accept(request(userId, threadId, 18_001, "cancel across processes"));
    await started.promise;
    const receiver = createCoordinator(db, repos, async () => undefined);

    await expect(receiver.cancelActive(threadId)).resolves.toBe(true);
    await owner.waitForIdle();

    expect(abort).toHaveBeenCalledWith(threadId);
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "cancelled", cancel_requested_at: expect.any(Number) }),
    ]);
    await receiver.shutdown();
    await owner.shutdown();
  });

  it("rejects the delivery transition when persisted cancellation wins the race", async () => {
    const { userId, threadId } = await ownership(repos, 819);
    const deliveryStarting = deferred<void>();
    const releaseDelivery = deferred<void>();
    const owner = createCoordinator(db, repos, async (input) => {
      expect(input.onDeliveryStarting?.()).toBe(true);
      deliveryStarting.resolve();
      await releaseDelivery.promise;
      await input.onAwaitingDelivery?.({ assistantMessageId: input.userMessageId! });
    });
    await owner.accept(request(userId, threadId, 19_001, "cancel before delivery"));
    await deliveryStarting.promise;
    const receiver = createCoordinator(db, repos, async () => undefined);

    await expect(receiver.cancelActive(threadId)).resolves.toBe(true);
    releaseDelivery.resolve();
    await owner.waitForIdle();

    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({
        status: "cancelled",
        delivery_status: "pending",
        cancel_requested_at: expect.any(Number),
      }),
    ]);
    await receiver.shutdown();
    await owner.shutdown();
  });

  it("reports local cancellation accepted when its durable write wins delivery", async () => {
    const { userId, threadId } = await ownership(repos, 824);
    const runnerStarted = deferred<void>();
    const startDelivery = deferred<void>();
    const deliveryStarted = deferred<void>();
    const owner = createCoordinator(db, repos, async (input) => {
      runnerStarted.resolve();
      await startDelivery.promise;
      expect(input.onDeliveryStarting?.()).toBe(true);
      deliveryStarted.resolve();
      await input.onAwaitingDelivery?.({ assistantMessageId: input.userMessageId! });
    });
    await owner.accept(request(userId, threadId, 24_001, "local cancellation race"));
    await runnerStarted.promise;
    const requestCancellation = repos.turnRuns.requestCancellation.bind(repos.turnRuns);
    vi.spyOn(repos.turnRuns, "requestCancellation").mockImplementationOnce(async (id) => {
      const requested = await requestCancellation(id);
      startDelivery.resolve();
      await deliveryStarted.promise;
      return requested;
    });

    await expect(owner.cancelActive(threadId)).resolves.toBe(true);
    await owner.waitForIdle();
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "cancelled", cancel_requested_at: expect.any(Number) }),
    ]);
    await owner.shutdown();
  });

  it("schedules a queued successor exposed while waiting for idle", async () => {
    const { userId, threadId } = await ownership(repos, 820);
    const empty = await ownership(repos, 821);
    const active = await repos.turnRuns.accept(request(userId, threadId, 20_001, "external owner"));
    await repos.turnRuns.claimRunning(active.turnRun.id, "other-process", Date.now() + 50);
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });
    await coordinator.waitForIdle(empty.threadId);
    await repos.turnRuns.accept(request(userId, threadId, 20_002, "take over queued work"));

    await coordinator.waitForIdle(threadId);

    expect(executed).toEqual(["take over queued work"]);
    expect((await repos.turnRuns.listForThread(threadId)).map((run) => run.status))
      .toEqual(["interrupted", "succeeded"]);
    await coordinator.shutdown();
  });

  it("holds a thread barrier across an operation and snapshots its fork point", async () => {
    const { userId, threadId } = await ownership(repos, 823);
    const before = await repos.messages.insert({
      threadId,
      role: "assistant",
      content: { text: "stable fork point" },
      textPlain: "stable fork point",
      piEntryId: "pi-before",
    });
    const barrierStarted = deferred<void>();
    const releaseBarrier = deferred<void>();
    const executed: string[] = [];
    const coordinator = createCoordinator(db, repos, async (input) => {
      executed.push(input.text);
      await confirmDelivery(input);
    });
    const operation = coordinator.withThreadBarrier(threadId, "fork", async (snapshotMessageId) => {
      barrierStarted.resolve();
      await releaseBarrier.promise;
      return snapshotMessageId;
    });
    await barrierStarted.promise;

    const accepted = await coordinator.accept(request(userId, threadId, 23_001, "arrived during fork"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toEqual([]);
    releaseBarrier.resolve();

    await expect(operation).resolves.toBe(before.id);
    await coordinator.waitForIdle(threadId);
    expect(executed).toEqual(["arrived during fork"]);
    expect(accepted.userMessage.id).toBeGreaterThan(before.id);
    await coordinator.shutdown();
  });

  it("renews a thread barrier while the operation is still running", async () => {
    vi.useFakeTimers();
    const { threadId } = await ownership(repos, 825);
    const operationStarted = deferred<void>();
    const releaseOperation = deferred<void>();
    const renewBarrier = vi.spyOn(repos.turnRuns, "renewThreadBarrier");
    const coordinator = createCoordinator(db, repos, async (input) => {
      await confirmDelivery(input);
    });
    const operation = coordinator.withThreadBarrier(threadId, "compact", async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
    });
    await operationStarted.promise;
    const [beforeRenewal] = await db.db.query<{ lease_expires_at: number }>(sql`
      select lease_expires_at from thread_operation_barriers where thread_id = ${threadId}
    `);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(renewBarrier).toHaveBeenCalledOnce();
    expect(renewBarrier.mock.calls[0]?.[0]).toBe(threadId);
    const [afterRenewal] = await db.db.query<{ lease_expires_at: number }>(sql`
      select lease_expires_at from thread_operation_barriers where thread_id = ${threadId}
    `);
    expect(afterRenewal!.lease_expires_at).toBeGreaterThan(beforeRenewal!.lease_expires_at);

    releaseOperation.resolve();
    await operation;
    await coordinator.shutdown();
  });

  it("aborts a thread operation when barrier ownership is lost", async () => {
    vi.useFakeTimers();
    const { threadId } = await ownership(repos, 826);
    const operationStarted = deferred<void>();
    vi.spyOn(repos.turnRuns, "renewThreadBarrier").mockResolvedValue(false);
    const coordinator = createCoordinator(db, repos, async (input) => {
      await confirmDelivery(input);
    });
    const operation = coordinator.withThreadBarrier(threadId, "compact", async (_snapshot, signal) => {
      operationStarted.resolve();
      await waitForAbort(signal);
      signal.throwIfAborted();
    });
    const rejection = expect(operation).rejects.toThrow("barrier lease was lost");
    await operationStarted.promise;

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    await coordinator.shutdown();
  });

  it("aborts a thread operation when renewal remains pending past the lease", async () => {
    vi.useFakeTimers();
    const { threadId } = await ownership(repos, 828);
    const operationStarted = deferred<void>();
    vi.spyOn(repos.turnRuns, "renewThreadBarrier").mockReturnValue(new Promise<boolean>(() => undefined));
    const coordinator = createCoordinator(db, repos, async (input) => {
      await confirmDelivery(input);
    });
    const operation = coordinator.withThreadBarrier(threadId, "fork", async (_snapshot, signal) => {
      operationStarted.resolve();
      await waitForAbort(signal);
      signal.throwIfAborted();
    });
    const rejection = expect(operation).rejects.toThrow("barrier lease was lost");
    await operationStarted.promise;

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    await coordinator.shutdown();
  });

  it("retries a transient thread barrier release failure", async () => {
    const { threadId } = await ownership(repos, 827);
    const releaseBarrier = vi.spyOn(repos.turnRuns, "releaseThreadBarrier")
      .mockRejectedValueOnce(new Error("temporary database outage"));
    const coordinator = createCoordinator(db, repos, async (input) => {
      await confirmDelivery(input);
    });

    await expect(coordinator.withThreadBarrier(threadId, "fork", async () => "done"))
      .resolves.toBe("done");
    expect(releaseBarrier).toHaveBeenCalledTimes(2);
    await expect(db.db.query(sql`
      select thread_id from thread_operation_barriers where thread_id = ${threadId}
    `)).resolves.toEqual([]);
    await coordinator.shutdown();
  });

  it("retries FTS indexing before claiming a durably queued turn", async () => {
    const { userId, threadId } = await ownership(repos, 813);
    const originalIndex = db.search.indexMessage.bind(db.search);
    let failuresRemaining = 2;
    const index = vi.spyOn(db.search, "indexMessage").mockImplementation(async (...args) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary FTS outage");
      }
      return originalIndex(...args);
    });
    const coordinator = createCoordinator(db, repos, async (input) => {
      await confirmDelivery(input);
    });

    const accepted = await coordinator.accept(request(userId, threadId, 13_001, "searchable after retry"));
    await coordinator.waitForIdle();

    expect(index.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await repos.turnRuns.listForThread(threadId)).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
    await expect(db.search.searchMessages([threadId], "searchable", 5))
      .resolves.toEqual([expect.objectContaining({ id: accepted.userMessage.id })]);
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
