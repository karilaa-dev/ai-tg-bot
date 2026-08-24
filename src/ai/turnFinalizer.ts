import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";

export class TurnFinalizer {
  cancelRequested = false;
  deliveryUnknown = false;
  deliveryFailed = false;
  deliveryConfirmed = false;
  deliveryStarted = false;
  executionFailed = false;
  resultMessageId: number | null = null;

  constructor(private readonly input: {
    repos: Repos;
    logger: Logger;
    turnRunId: number;
    threadId: number;
    ownerId?: string;
  }) {}

  canCancel(): boolean {
    return !this.cancelRequested
      && !this.deliveryStarted
      && !this.deliveryConfirmed
      && !this.deliveryUnknown
      && !this.deliveryFailed;
  }

  requestCancellation(): boolean {
    if (!this.canCancel()) return false;
    this.cancelRequested = true;
    return true;
  }

  beginDelivery(): boolean {
    if (this.cancelRequested || this.deliveryConfirmed || this.deliveryUnknown || this.deliveryFailed) {
      return false;
    }
    this.deliveryStarted = true;
    return true;
  }

  async awaitingDelivery(result: {
    assistantMessageId: number;
    provider?: string;
    model?: string;
    usage?: unknown;
  }): Promise<void> {
    this.deliveryStarted = true;
    this.resultMessageId = result.assistantMessageId;
    await this.input.repos.turnRuns.markAwaitingDelivery(this.input.turnRunId, {
      resultMessageId: result.assistantMessageId,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    }, this.input.ownerId);
  }

  async confirmDelivery(assistantMessageId: number): Promise<void> {
    this.resultMessageId = assistantMessageId;
    // Set the in-memory terminal outcome before the database round trip so a
    // concurrent /stop cannot overwrite an already confirmed Telegram send.
    this.deliveryConfirmed = true;
    if (this.executionFailed) {
      await this.input.repos.turnRuns.markFailed(
        this.input.turnRunId,
        "agent_execution_failed",
        "delivered",
        this.input.ownerId,
      );
    } else {
      await this.input.repos.turnRuns.markSucceeded(this.input.turnRunId, assistantMessageId, this.input.ownerId);
    }
  }

  async unknownDelivery(assistantMessageId: number, failureCode: string): Promise<void> {
    this.resultMessageId = assistantMessageId;
    this.deliveryUnknown = true;
    await this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "unknown", this.input.ownerId);
  }

  async rejectDelivery(assistantMessageId: number, failureCode: string): Promise<void> {
    this.resultMessageId = assistantMessageId;
    this.deliveryFailed = true;
    await this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "failed", this.input.ownerId);
  }

  recordExecutionFailure(): void {
    this.executionFailed = true;
  }

  async finishEngine(): Promise<{ deliveredSuccessfully: boolean }> {
    if (this.deliveryConfirmed) {
      return { deliveredSuccessfully: !this.executionFailed };
    }
    if (this.cancelRequested) {
      await this.input.repos.turnRuns.markCancelled(this.input.turnRunId, this.input.ownerId);
    } else if (this.deliveryUnknown || this.deliveryFailed) {
      // Delivery callbacks already persisted their authoritative outcomes.
    } else if (this.executionFailed) {
      await this.input.repos.turnRuns.markFailed(this.input.turnRunId, "agent_execution_failed", "failed", this.input.ownerId);
    } else {
      await this.input.repos.turnRuns.markFailed(this.input.turnRunId, "turn_finished_without_delivery", "failed", this.input.ownerId);
    }
    return { deliveredSuccessfully: false };
  }

  async finishException(): Promise<void> {
    if (this.deliveryConfirmed) {
      await (this.executionFailed
        ? this.input.repos.turnRuns.markFailed(
            this.input.turnRunId,
            "agent_execution_failed",
            "delivered",
            this.input.ownerId,
          )
        : this.input.repos.turnRuns.markSucceeded(
            this.input.turnRunId,
            this.resultMessageId,
            this.input.ownerId,
          )
      ).catch((error) => {
        this.input.logger.error("confirmed turn outcome could not be persisted", {
          turnRunId: this.input.turnRunId,
          threadId: this.input.threadId,
          error: String(error),
        });
      });
    } else if (this.cancelRequested) {
      await this.input.repos.turnRuns.markCancelled(this.input.turnRunId, this.input.ownerId);
    } else if (!this.deliveryUnknown && !this.deliveryFailed) {
      await this.input.repos.turnRuns.markFailed(
        this.input.turnRunId,
        "turn_execution_failed",
        "failed",
        this.input.ownerId,
      );
    }
  }
}
