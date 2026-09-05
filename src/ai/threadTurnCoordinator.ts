import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { AcceptedTurnRun, DurableTurnAttachment, TelegramTurnSource } from "../db/repos/turnRuns.js";
import type { Locale, MessageKind, TurnRunRow } from "../db/types.js";
import type { FileResolver } from "../files/resolver.js";
import type { Logger } from "../logger.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import type { TurnRunner } from "./types.js";
import { TurnFinalizer } from "./turnFinalizer.js";

interface ActiveTurn {
  run: TurnRunRow;
  controller: AbortController;
  finalizer: TurnFinalizer;
}

export class ThreadTurnCoordinator {
  private readonly draining = new Map<number, Promise<void>>();
  private readonly active = new Map<number, ActiveTurn>();
  private readonly recovery: Promise<number[]>;
  private readonly ownerId = randomUUID();
  private readonly lifecycle = new AbortController();
  private recoveryPollTimer: NodeJS.Timeout | undefined;
  private recoveryScan: Promise<void> | undefined;
  private accepting = true;

  private static readonly CLAIM_RETRY_MS = 1_000;
  private static readonly FAILURE_RETRY_MAX_MS = 30_000;
  private static readonly OWNER_LEASE_MS = 60_000;
  private static readonly OWNER_RENEW_MS = 10_000;
  private static readonly BARRIER_LEASE_MS = 60_000;
  private static readonly BARRIER_RENEW_MS = 10_000;
  private static readonly BARRIER_RELEASE_ATTEMPTS = 5;
  private static readonly BARRIER_RELEASE_RETRY_MS = 100;
  private static readonly CANCELLATION_POLL_MS = 500;
  private static readonly RECOVERY_POLL_MS = 5_000;

  constructor(private readonly input: {
    api: Api;
    config: AppConfig;
    db: AppDatabase;
    repos: Repos;
    logger: Logger;
    pi: PiRuntimeService;
    fileResolver: FileResolver;
    turnRunner: TurnRunner;
    t(locale: Locale, key: string, params?: Record<string, string | number>): string;
    scheduleThreadTitle?(input: { threadId: number; chatId: number }): void;
    awaitProcessingOnAccept?: boolean;
  }) {
    this.recovery = this.recoverUntilReady();
    void this.recovery.then((threadIds) => {
      for (const threadId of threadIds) this.schedule(threadId);
      this.armRecoveryPoll();
    }).catch((error) => {
      this.input.logger.error("turn coordinator recovery failed", { error: String(error) });
    });
  }

  async accept(input: {
    userId: number;
    threadId: number;
    chatId: number;
    messageThreadId: number | null;
    locale: Locale;
    kind: MessageKind;
    content: unknown;
    textPlain: string;
    sources: TelegramTurnSource[];
    attachments?: DurableTurnAttachment[];
  }): Promise<AcceptedTurnRun> {
    if (!this.accepting) throw new Error("Turn coordinator is shutting down.");
    await this.recovery;
    if (!this.accepting) throw new Error("Turn coordinator is shutting down.");
    const accepted = await this.input.repos.turnRuns.accept(input);
    if (accepted.created) {
      this.input.logger.info("turn accepted", {
        turnRunId: accepted.turnRun.id,
        threadId: accepted.turnRun.thread_id,
        userMessageId: accepted.userMessage.id,
        sourceCount: input.sources.length,
        queuedBehind: accepted.queuedBehind,
      });
    } else {
      this.input.logger.info("duplicate Telegram update resolved to existing turn", {
        turnRunId: accepted.turnRun.id,
        threadId: accepted.turnRun.thread_id,
      });
    }
    if (accepted.turnRun.status === "queued") this.schedule(accepted.turnRun.thread_id);
    if (this.input.awaitProcessingOnAccept) await this.waitForIdle(accepted.turnRun.thread_id);
    return accepted;
  }

  async cancelActive(threadId: number): Promise<boolean> {
    await this.recovery;
    const active = this.active.get(threadId);
    if (active && !active.finalizer.canCancel()) return false;
    const requested = await this.input.repos.turnRuns.requestCancellation(threadId);
    if (!requested) return false;
    if (requested.status === "cancelled") this.schedule(threadId);
    if (active) {
      if (active.finalizer.requestCancellation()) {
        active.controller.abort(new Error("Turn cancelled by user."));
        await this.input.pi.abort(threadId);
      }
    }
    this.input.logger.info(requested.status === "cancelled"
      ? "queued head turn cancelled"
      : active
        ? "active turn cancellation requested"
        : "remote turn cancellation requested", {
      turnRunId: requested.id,
      threadId,
    });
    return true;
  }

  async waitForIdle(threadId?: number): Promise<void> {
    await this.recovery;
    while (true) {
      const tasks = threadId === undefined
        ? [...this.draining.values()]
        : [this.draining.get(threadId)].filter((task): task is Promise<void> => Boolean(task));
      if (tasks.length) {
        await Promise.allSettled(tasks);
        continue;
      }
      if (threadId !== undefined) {
        const now = Date.now();
        await this.input.repos.turnRuns.interruptStaleRunning({
          now,
          legacyStaleBefore: this.legacyStaleBefore(now),
          threadId,
        });
      }
      if (threadId !== undefined && await this.input.repos.turnRuns.hasUnfinished(threadId)) {
        if (!this.draining.has(threadId) && await this.input.repos.turnRuns.nextQueued(threadId)) {
          this.schedule(threadId);
        }
        await delay(ThreadTurnCoordinator.CLAIM_RETRY_MS);
        continue;
      }
      return;
    }
  }

  async withThreadBarrier<T>(
    threadId: number,
    operation: "fork" | "compact",
    callback: (snapshotMessageId: number | null, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.recovery;
    const barrierOwnerId = `${this.ownerId}:${randomUUID()}`;
    while (this.accepting) {
      await this.waitForIdle(threadId);
      if (!this.accepting) break;
      const barrierLeaseExpiresAt = Date.now() + ThreadTurnCoordinator.BARRIER_LEASE_MS;
      const barrier = await this.input.repos.turnRuns.tryAcquireThreadBarrier({
        threadId,
        ownerId: barrierOwnerId,
        operation,
        leaseExpiresAt: barrierLeaseExpiresAt,
      });
      if (!barrier) {
        await delay(ThreadTurnCoordinator.CLAIM_RETRY_MS);
        continue;
      }
      this.input.logger.info("thread operation barrier acquired", {
        threadId,
        operation,
        snapshotMessageId: barrier.snapshotMessageId,
      });
      let renewingBarrier: Promise<void> | undefined;
      let barrierMonitoring = true;
      const operationController = new AbortController();
      const onShutdown = () => operationController.abort(new Error("Turn coordinator is shutting down."));
      this.lifecycle.signal.addEventListener("abort", onShutdown, { once: true });
      const abortBarrierOperation = (message: string) => {
        if (operationController.signal.aborted || !barrierMonitoring) return;
        this.input.logger.error(message, { threadId, operation });
        operationController.abort(new Error("Thread operation barrier lease was lost."));
      };
      const barrierDeadline = new LeaseDeadline(barrierLeaseExpiresAt, () => {
        abortBarrierOperation("thread operation barrier lease expired locally");
      });
      const renewalTimer = setInterval(() => {
        if (renewingBarrier) return;
        const renewedLeaseExpiresAt = Date.now() + ThreadTurnCoordinator.BARRIER_LEASE_MS;
        renewingBarrier = this.input.repos.turnRuns.renewThreadBarrier(
          threadId,
          barrierOwnerId,
          renewedLeaseExpiresAt,
        ).then((renewed) => {
          if (!barrierMonitoring) return;
          if (renewed) {
            barrierDeadline.confirm(renewedLeaseExpiresAt);
            return;
          }
          abortBarrierOperation("thread operation barrier lease was lost");
        }).catch((error) => {
          if (!barrierMonitoring) return;
          this.input.logger.warn("thread operation barrier renewal failed", {
            threadId,
            operation,
            error: String(error),
          });
        }).finally(() => {
          renewingBarrier = undefined;
        });
      }, ThreadTurnCoordinator.BARRIER_RENEW_MS);
      renewalTimer.unref();
      let result!: T;
      let operationError: unknown;
      let operationFailed = false;
      try {
        result = await callback(barrier.snapshotMessageId, operationController.signal);
        operationController.signal.throwIfAborted();
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        barrierMonitoring = false;
        clearInterval(renewalTimer);
        barrierDeadline.stop();
        this.lifecycle.signal.removeEventListener("abort", onShutdown);
        const released = await this.releaseThreadBarrierWithRetry(threadId, barrierOwnerId, operation);
        if (released === false) {
          this.input.logger.error("thread operation barrier ownership was lost", {
            threadId,
            operation,
          });
        } else if (released) {
          this.input.logger.info("thread operation barrier released", { threadId, operation });
        }
        try {
          if (this.accepting && await this.input.repos.turnRuns.nextQueued(threadId)) this.schedule(threadId);
        } catch (error) {
          this.input.logger.warn("queued turn lookup after thread operation failed", {
            threadId,
            operation,
            error: String(error),
          });
        }
      }
      if (operationFailed) throw operationError;
      operationController.signal.throwIfAborted();
      return result;
    }
    throw new Error("Turn coordinator is shutting down.");
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.accepting = false;
    this.lifecycle.abort();
    if (this.recoveryPollTimer) clearTimeout(this.recoveryPollTimer);
    this.recoveryPollTimer = undefined;
    await this.recovery.catch(() => undefined);
    await Promise.all([...this.active.keys()].map((threadId) => this.cancelActive(threadId)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.waitForIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async recoverUntilReady(): Promise<number[]> {
    let consecutiveFailures = 0;
    while (this.accepting) {
      try {
        return await this.recover();
      } catch (error) {
        consecutiveFailures += 1;
        const retryMs = Math.min(
          ThreadTurnCoordinator.FAILURE_RETRY_MAX_MS,
          ThreadTurnCoordinator.CLAIM_RETRY_MS * 2 ** Math.min(5, consecutiveFailures - 1),
        );
        this.input.logger.error("turn coordinator recovery failed; retrying", {
          consecutiveFailures,
          retryMs,
          error: String(error),
        });
        await delay(retryMs, this.lifecycle.signal);
      }
    }
    return [];
  }

  private async recover(): Promise<number[]> {
    const now = Date.now();
    const interrupted = await this.input.repos.turnRuns.interruptStaleRunning({
      now,
      // Pre-lease deployments cannot heartbeat. Preserve their possible live
      // work for at least the maximum turn window during a rolling rollout.
      legacyStaleBefore: this.legacyStaleBefore(now),
    });
    const threadIds = await this.input.repos.turnRuns.queuedThreadIds();
    const metadata = { interruptedTurns: interrupted, queuedThreads: threadIds.length };
    if (interrupted || threadIds.length) {
      this.input.logger.info("turn coordinator discovered durable work", metadata);
    } else {
      this.input.logger.debug("turn coordinator recovery scan complete", metadata);
    }
    return threadIds;
  }

  private armRecoveryPoll(): void {
    if (!this.accepting || this.recoveryPollTimer || this.recoveryScan) return;
    this.recoveryPollTimer = setTimeout(() => {
      this.recoveryPollTimer = undefined;
      const scan = this.scanForDurableWork();
      this.recoveryScan = scan;
      void scan.finally(() => {
        if (this.recoveryScan === scan) this.recoveryScan = undefined;
        this.armRecoveryPoll();
      });
    }, ThreadTurnCoordinator.RECOVERY_POLL_MS);
    this.recoveryPollTimer.unref();
  }

  private async scanForDurableWork(): Promise<void> {
    try {
      const threadIds = await this.recover();
      if (!this.accepting) return;
      for (const threadId of threadIds) this.schedule(threadId);
    } catch (error) {
      this.input.logger.warn("turn coordinator periodic recovery failed", {
        error: String(error),
      });
    }
  }

  private schedule(threadId: number): void {
    if (this.draining.has(threadId)) return;
    const task = this.drainThread(threadId);
    this.draining.set(threadId, task);
    void task.then(
      () => this.finishDrain(threadId),
      (error) => {
        // drainThread is defensive and should not reject. Keep this terminal
        // guard so a future regression still cannot become an unhandled rejection.
        this.input.logger.error("turn drain escaped its supervisor", { threadId, error: String(error) });
        return this.finishDrain(threadId, true);
      },
    ).catch((error) => {
      this.input.logger.error("turn drain completion handler failed", {
        threadId,
        error: String(error),
      });
      setTimeout(() => {
        if (this.accepting) this.schedule(threadId);
      }, ThreadTurnCoordinator.CLAIM_RETRY_MS).unref();
    });
  }

  private async drainThread(threadId: number): Promise<void> {
    let consecutiveFailures = 0;
    while (this.accepting) {
      try {
        const queued = await this.input.repos.turnRuns.nextQueued(threadId);
        if (!queued) return;
        await this.input.repos.turnRuns.indexMessageForRun(queued);
        const now = Date.now();
        const run = await this.input.repos.turnRuns.claimRunning(
          queued.id,
          this.ownerId,
          now + ThreadTurnCoordinator.OWNER_LEASE_MS,
          this.legacyStaleBefore(now),
        );
        if (!run) {
          // Another process owns this thread or is ahead of us in the FIFO.
          await delay(ThreadTurnCoordinator.CLAIM_RETRY_MS);
          continue;
        }
        consecutiveFailures = 0;
        await this.execute(run);
      } catch (error) {
        consecutiveFailures += 1;
        const retryMs = Math.min(
          ThreadTurnCoordinator.FAILURE_RETRY_MAX_MS,
          ThreadTurnCoordinator.CLAIM_RETRY_MS * 2 ** Math.min(5, consecutiveFailures - 1),
        );
        this.input.logger.error("turn drain operation failed; retrying", {
          threadId,
          consecutiveFailures,
          retryMs,
          error: String(error),
        });
        await delay(retryMs);
      }
    }
  }

  private async finishDrain(threadId: number, retry = false): Promise<void> {
    this.draining.delete(threadId);
    if (!this.accepting) return;
    try {
      if (retry || await this.input.repos.turnRuns.nextQueued(threadId)) this.schedule(threadId);
    } catch (error) {
      this.input.logger.error("failed to verify turn queue after drain; rescheduling", {
        threadId,
        retryMs: ThreadTurnCoordinator.CLAIM_RETRY_MS,
        error: String(error),
      });
      setTimeout(() => {
        if (this.accepting) this.schedule(threadId);
      }, ThreadTurnCoordinator.CLAIM_RETRY_MS).unref();
    }
  }

  private async execute(run: TurnRunRow): Promise<void> {
    const controller = new AbortController();
    const finalizer = new TurnFinalizer({
      repos: this.input.repos,
      logger: this.input.logger,
      turnRunId: run.id,
      threadId: run.thread_id,
      ownerId: this.ownerId,
    });
    const active: ActiveTurn = {
      run,
      controller,
      finalizer,
    };
    this.active.set(run.thread_id, active);
    let renewingLease = false;
    let leaseMonitoring = true;
    const abortOwnedTurn = (message: string) => {
      if (controller.signal.aborted || !leaseMonitoring) return;
      this.input.logger.error(message, {
        turnRunId: run.id,
        threadId: run.thread_id,
      });
      controller.abort(new Error("Turn owner lease was lost."));
      void this.input.pi.abort(run.thread_id);
    };
    const leaseDeadline = new LeaseDeadline(
      run.lease_expires_at ?? Date.now() + ThreadTurnCoordinator.OWNER_LEASE_MS,
      () => abortOwnedTurn("turn owner lease expired locally; aborting local execution"),
    );
    const leaseTimer = setInterval(() => {
      if (renewingLease) return;
      renewingLease = true;
      const renewedLeaseExpiresAt = Date.now() + ThreadTurnCoordinator.OWNER_LEASE_MS;
      void this.input.repos.turnRuns.renewLease(
        run.id,
        this.ownerId,
        renewedLeaseExpiresAt,
      ).then((renewed) => {
        if (!leaseMonitoring) return;
        if (renewed) {
          leaseDeadline.confirm(renewedLeaseExpiresAt);
          return;
        }
        abortOwnedTurn("turn owner lease was lost; aborting local execution");
      }).catch((error) => {
        if (!leaseMonitoring) return;
        this.input.logger.warn("turn owner lease renewal failed", {
          turnRunId: run.id,
          threadId: run.thread_id,
          error: String(error),
        });
      }).finally(() => {
        renewingLease = false;
      });
    }, ThreadTurnCoordinator.OWNER_RENEW_MS);
    leaseTimer.unref();
    let pollingCancellation = false;
    const cancellationTimer = setInterval(() => {
      if (pollingCancellation || finalizer.cancelRequested) return;
      pollingCancellation = true;
      void this.input.repos.turnRuns.cancellationRequested(run.id, this.ownerId).then((requested) => {
        if (!requested || !leaseMonitoring || !finalizer.requestCancellation()) return;
        this.input.logger.info("remote turn cancellation received", {
          turnRunId: run.id,
          threadId: run.thread_id,
        });
        controller.abort(new Error("Turn cancelled by user."));
        void this.input.pi.abort(run.thread_id);
      }).catch((error) => {
        if (!leaseMonitoring) return;
        this.input.logger.warn("turn cancellation polling failed", {
          turnRunId: run.id,
          threadId: run.thread_id,
          error: String(error),
        });
      }).finally(() => {
        pollingCancellation = false;
      });
    }, ThreadTurnCoordinator.CANCELLATION_POLL_MS);
    cancellationTimer.unref();
    const queueWaitMs = Math.max(0, (run.started_at ?? Date.now()) - run.accepted_at);
    const startedAt = Date.now();
    this.input.logger.info("queued turn execution starting", {
      turnRunId: run.id,
      threadId: run.thread_id,
      queueWaitMs,
    });
    try {
      const [user, thread, message] = await Promise.all([
        this.input.repos.users.get(run.user_id),
        this.input.repos.threads.get(run.thread_id),
        this.input.repos.messages.get(run.user_message_id),
      ]);
      if (!user || !thread || !message) throw new Error("Durable turn ownership records are incomplete.");
      let content: unknown = { text: message.text_plain };
      try {
        content = JSON.parse(message.content_json) as unknown;
      } catch {
        // Keep the plain-text fallback; malformed historical JSON must not strand FIFO.
      }
      await this.input.turnRunner({
        api: this.input.api,
        chatId: run.chat_id,
        messageThreadId: run.message_thread_id ?? undefined,
        config: this.input.config,
        db: this.input.db,
        repos: this.input.repos,
        logger: this.input.logger,
        user,
        thread,
        text: message.text_plain,
        userMessageKind: message.kind,
        userMessageContent: content,
        userMessageId: message.id,
        turnRunId: run.id,
        signal: controller.signal,
        resolveFile: (file, signal) => this.input.fileResolver.resolveFile(file, signal),
        pi: this.input.pi,
        t: (key, params) => this.input.t(run.locale, key, params),
        onAwaitingDelivery: (result) => finalizer.awaitingDelivery(result),
        onDeliveryStarting: () => finalizer.beginDelivery(),
        onDeliveryConfirmed: (result) => finalizer.confirmDelivery(result.assistantMessageId),
        onDeliveryUnknown: (result) => finalizer.unknownDelivery(result.assistantMessageId, result.failureCode),
        onDeliveryFailed: (result) => finalizer.rejectDelivery(result.assistantMessageId, result.failureCode),
        onExecutionFailure: async () => finalizer.recordExecutionFailure(),
      });
      const outcome = await finalizer.finishEngine();
      if (outcome.deliveredSuccessfully) {
        this.input.scheduleThreadTitle?.({ threadId: run.thread_id, chatId: run.chat_id });
      }
    } catch (error) {
      await finalizer.finishException();
      this.input.logger.error("queued turn execution failed", {
        turnRunId: run.id,
        threadId: run.thread_id,
        error: String(error),
      });
    } finally {
      leaseMonitoring = false;
      clearInterval(leaseTimer);
      leaseDeadline.stop();
      clearInterval(cancellationTimer);
      this.active.delete(run.thread_id);
      this.input.logger.info("queued turn execution finished", {
        turnRunId: run.id,
        threadId: run.thread_id,
        runMs: Date.now() - startedAt,
        cancelled: finalizer.cancelRequested || undefined,
        deliveryUnknown: finalizer.deliveryUnknown || undefined,
      });
    }
  }

  private legacyStaleBefore(now: number): number | undefined {
    if (this.input.config.PI_TURN_TIMEOUT_MS === 0) return undefined;
    return now - Math.max(this.input.config.PI_TURN_TIMEOUT_MS, 60_000) - 60_000;
  }

  private async releaseThreadBarrierWithRetry(
    threadId: number,
    ownerId: string,
    operation: "fork" | "compact",
  ): Promise<boolean | undefined> {
    for (let attempt = 1; attempt <= ThreadTurnCoordinator.BARRIER_RELEASE_ATTEMPTS; attempt += 1) {
      try {
        return await this.input.repos.turnRuns.releaseThreadBarrier(threadId, ownerId);
      } catch (error) {
        if (attempt === ThreadTurnCoordinator.BARRIER_RELEASE_ATTEMPTS) {
          this.input.logger.error("thread operation barrier release failed", {
            threadId,
            operation,
            attempts: attempt,
            error: String(error),
          });
          return undefined;
        }
        this.input.logger.warn("thread operation barrier release failed; retrying", {
          threadId,
          operation,
          attempt,
          error: String(error),
        });
        await delay(ThreadTurnCoordinator.BARRIER_RELEASE_RETRY_MS * 2 ** (attempt - 1));
      }
    }
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

class LeaseDeadline {
  private timer: NodeJS.Timeout | undefined;

  constructor(expiresAt: number, private readonly onExpired: () => void) {
    this.confirm(expiresAt);
  }

  confirm(expiresAt: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpired();
    }, Math.max(0, expiresAt - Date.now()));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
