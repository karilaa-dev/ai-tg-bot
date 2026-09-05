import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";

export class TurnFinalizer {
  private phase: "running" | "cancelled" | "delivering" | "confirmed" | "unknown" | "rejected" = "running";
  get deliveryUnknown(): boolean { return this.phase === "unknown"; }
  get cancelRequested(): boolean { return this.phase === "cancelled"; }
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
    return this.phase === "running";
  }

  requestCancellation(): boolean {
    if (!this.canCancel()) return false;
    this.phase = "cancelled";
    return true;
  }

  beginDelivery(): boolean {
    if (this.phase !== "running" && this.phase !== "delivering") return false;
    this.phase = "delivering";
    return true;
  }

  async awaitingDelivery(result: {
    assistantMessageId: number;
    provider?: string;
    model?: string;
    usage?: unknown;
  }): Promise<void> {
    this.phase = "delivering";
    this.resultMessageId = result.assistantMessageId;
    const transitioned = await this.input.repos.turnRuns.markAwaitingDelivery(this.input.turnRunId, {
      resultMessageId: result.assistantMessageId,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    }, this.input.ownerId);
    if (!transitioned) {
      // A remote /stop and this delivery transition compete on the same row.
      // If cancellation won, no Telegram delivery may start.
      this.phase = "cancelled";
      throw new Error("Turn cancellation won the delivery transition.");
    }
  }

  async confirmDelivery(assistantMessageId: number): Promise<void> {
    this.resultMessageId = assistantMessageId;
    // Set the in-memory terminal outcome before the database round trip so a
    // concurrent /stop cannot overwrite an already confirmed Telegram send.
    this.phase = "confirmed";
    await this.persistConfirmed();
  }

  private persistConfirmed(): Promise<void> {
    return this.executionFailed
      ? this.input.repos.turnRuns.markFailed(this.input.turnRunId, "agent_execution_failed", "delivered", this.input.ownerId)
      : this.input.repos.turnRuns.markSucceeded(this.input.turnRunId, this.resultMessageId, this.input.ownerId);
  }

  async unknownDelivery(assistantMessageId: number, failureCode: string): Promise<void> {
    this.resultMessageId = assistantMessageId;
    this.phase = "unknown";
    await this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "unknown", this.input.ownerId);
  }

  async rejectDelivery(assistantMessageId: number, failureCode: string): Promise<void> {
    this.resultMessageId = assistantMessageId;
    this.phase = "rejected";
    await this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "failed", this.input.ownerId);
  }

  recordExecutionFailure(): void {
    this.executionFailed = true;
  }

  async finishEngine(): Promise<{ deliveredSuccessfully: boolean }> {
    if (this.phase === "confirmed") {
      return { deliveredSuccessfully: !this.executionFailed };
    }
    if (this.cancelRequested) {
      await this.input.repos.turnRuns.markCancelled(this.input.turnRunId, this.input.ownerId);
    } else if (this.phase === "unknown" || this.phase === "rejected") {
      // Delivery callbacks already persisted their authoritative outcomes.
    } else if (this.executionFailed) {
      await this.input.repos.turnRuns.markFailed(this.input.turnRunId, "agent_execution_failed", "failed", this.input.ownerId);
    } else {
      await this.input.repos.turnRuns.markFailed(this.input.turnRunId, "turn_finished_without_delivery", "failed", this.input.ownerId);
    }
    return { deliveredSuccessfully: false };
  }

  async finishException(): Promise<void> {
    if (this.phase === "confirmed") {
      await this.persistConfirmed().catch((error) => {
        this.input.logger.error("confirmed turn outcome could not be persisted", {
          turnRunId: this.input.turnRunId,
          threadId: this.input.threadId,
          error: String(error),
        });
      });
    } else if (this.cancelRequested) {
      await this.input.repos.turnRuns.markCancelled(this.input.turnRunId, this.input.ownerId);
    } else if (this.phase !== "unknown" && this.phase !== "rejected") {
      await this.input.repos.turnRuns.markFailed(
        this.input.turnRunId,
        "turn_execution_failed",
        "failed",
        this.input.ownerId,
      );
    }
  }
}
