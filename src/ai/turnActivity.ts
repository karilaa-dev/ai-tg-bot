import { randomUUID } from "node:crypto";
import { GrammyError, type Api } from "grammy";
import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";

export class TurnActivityCoordinator {
  private readonly jobs = new Map<number, { promise: Promise<void>; requested: boolean; threadId?: number }>();
  private readonly stopping = new AbortController();

  constructor(private readonly input: {
    api: Api;
    repos: Repos;
    logger: Logger;
    syncThreadActivity?(input: { threadId: number; chatId: number; signal?: AbortSignal }): Promise<boolean | void>;
  }) {}

  schedule(runId: number, threadId?: number): void {
    if (this.stopping.signal.aborted) return;
    const existing = this.jobs.get(runId);
    if (existing) {
      existing.requested = true;
      return;
    }
    const job = { promise: Promise.resolve(), requested: false, threadId };
    job.promise = this.reconcile(runId).then((again) => {
      job.requested ||= again;
    }).catch((error) => {
      this.input.logger.warn("turn activity synchronization failed", { turnRunId: runId, error: String(error) });
    }).finally(() => {
      this.jobs.delete(runId);
      if (job.requested) this.schedule(runId, threadId);
    });
    this.jobs.set(runId, job);
  }

  async recover(): Promise<void> {
    for (const runId of await this.input.repos.turnActivity.pending(Date.now())) {
      const run = await this.input.repos.turnRuns.get(runId);
      if (run) this.schedule(runId, run.thread_id);
    }
  }

  async waitForIdle(threadId?: number): Promise<void> {
    while (true) {
      const jobs = [...this.jobs.values()].filter((job) => threadId === undefined || job.threadId === undefined || job.threadId === threadId);
      if (!jobs.length) return;
      await Promise.all(jobs.map((job) => job.promise));
    }
  }

  async shutdown(): Promise<void> {
    this.stopping.abort();
    await this.waitForIdle();
  }

  private async reconcile(runId: number): Promise<boolean> {
    const ownerId = randomUUID();
    const repo = this.input.repos.turnActivity;
    const generation = await repo.claim(runId, ownerId, Date.now(), Date.now() + 60_000);
    if (generation === undefined) return false;
    let confirmed = false;
    let retryAt = Date.now() + 5_000;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.stopping.signal.throwIfAborted();
        const run = await this.input.repos.turnRuns.get(runId);
        if (!run) return false;
        const working = isWorking(run.status);
        const messageIds = await this.input.repos.turnRuns.telegramMessageIds(runId);
        const results = await Promise.allSettled([
          ...messageIds.map((messageId) => this.input.api.raw.setMessageReaction({
            chat_id: run.chat_id,
            message_id: messageId,
            reaction: working ? [{ type: "emoji", emoji: "👀" }] : [],
          }, AbortSignal.any([this.stopping.signal, AbortSignal.timeout(5_000)]) as Parameters<Api["raw"]["setMessageReaction"]>[1]).catch((error) => {
            // Deleted messages and chats that forbid reactions cannot be
            // reconciled; retrying those indefinitely would flood Telegram.
            if (error instanceof GrammyError && (error.error_code === 403
              || (error.error_code === 400 && /message.*not found|message_id_invalid|reaction_invalid|reactions?.*(?:not allowed|disabled)|can't be reacted/i.test(error.description)))) return true;
            throw error;
          })),
          this.input.syncThreadActivity?.({ threadId: run.thread_id, chatId: run.chat_id, signal: this.stopping.signal }),
        ]);
        // An accepted turn may finish while Telegram is processing the request.
        // Apply the latest state before acknowledging the durable sync record.
        const latest = await this.input.repos.turnRuns.get(runId);
        if (latest && isWorking(latest.status) !== working) continue;
        if (results.some((result) => result.status === "rejected" || result.value === false)) {
          await repo.invalidate(runId);
          this.input.logger.warn("turn activity update will be retried", { turnRunId: runId, working });
          return false;
        }
        confirmed = await repo.confirm(runId, ownerId, generation, working);
        if (confirmed) return false;
        // A lease may have expired while an API request was in flight. Dirty
        // the record even if another process already confirmed its cleanup.
        await repo.invalidate(runId);
        retryAt = 0;
        return true;
      }
      return false;
    } finally {
      if (!confirmed) await repo.release(runId, ownerId, retryAt);
    }
  }
}

function isWorking(status: string): boolean {
  return ["queued", "running", "awaiting_delivery"].includes(status);
}
