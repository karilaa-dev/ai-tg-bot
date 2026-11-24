import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";

export class TurnCancelledError extends Error {
  constructor() {
    super("Turn cancellation won the delivery transition.");
    this.name = "TurnCancelledError";
  }
}

type DeliveryOutcome = "confirmed" | "unknown" | "rejected";

export class TurnFinalizer {
  private phase: "running" | "cancelled" | "delivering" | DeliveryOutcome = "running";
  private persistence:
    | { phase: "clear" }
    | { phase: "pending"; write: () => Promise<void> }
    | { phase: "writing"; done: Promise<void> } = { phase: "clear" };
  private get hasDeliveryOutcome(): boolean {
    return this.phase === "confirmed" || this.phase === "unknown" || this.phase === "rejected";
  }
  get deliveryUnknown(): boolean { return this.phase === "unknown"; }
  get cancelRequested(): boolean { return this.phase === "cancelled"; }
  executionFailed = false;
  private deliveryRegistration?: { messageId: number; ready: Promise<void> };

  constructor(private readonly input: {
    repos: Repos;
    logger: Logger;
    turnRunId: number;
    threadId: string;
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
    if (this.cancelRequested) throw new TurnCancelledError();
    if (!this.beginDelivery()) throw new Error("Delivery already finalized.");
    // Notification of the same persisted reply can be repeated while the lease check is in flight.
    if (this.deliveryRegistration) {
      if (this.deliveryRegistration.messageId !== result.assistantMessageId) throw new Error("A different reply already started delivery.");
      return this.deliveryRegistration.ready;
    }
    const ready = this.input.repos.turnRuns.markAwaitingDelivery(this.input.turnRunId, {
      resultMessageId: result.assistantMessageId,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    }, this.input.ownerId).then(transitioned => {
      if (transitioned) return;
      if (!this.hasDeliveryOutcome) this.phase = "cancelled";
      throw new TurnCancelledError();
    });
    this.deliveryRegistration = { messageId: result.assistantMessageId, ready };
    try { await ready; }
    catch (error) {
      this.deliveryRegistration = undefined;
      throw error;
    }
  }

  confirmDelivery(assistantMessageId: number): Promise<void> {
    return this.settle("confirmed", () => this.executionFailed
      ? this.input.repos.turnRuns.markFailed(this.input.turnRunId, "agent_execution_failed", "delivered", this.input.ownerId)
      : this.input.repos.turnRuns.markSucceeded(this.input.turnRunId, assistantMessageId, this.input.ownerId));
  }

  unknownDelivery(_assistantMessageId: number, failureCode: string): Promise<void> {
    return this.settle("unknown", () =>
      this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "unknown", this.input.ownerId));
  }

  rejectDelivery(_assistantMessageId: number, failureCode: string): Promise<void> {
    return this.settle("rejected", () =>
      this.input.repos.turnRuns.markFailed(this.input.turnRunId, failureCode, "failed", this.input.ownerId));
  }

  private async settle(outcome: DeliveryOutcome, persist: () => Promise<void>): Promise<void> {
    if (this.cancelRequested) throw new TurnCancelledError();
    // The first reported send outcome is authoritative, including while its write is being retried.
    if (!this.hasDeliveryOutcome) {
      this.phase = outcome;
      this.persistence = { phase: "pending", write: persist };
    }
    await this.persistDeliveryOutcome();
  }

  recordExecutionFailure(): void {
    if (this.hasDeliveryOutcome) return;
    this.executionFailed = true;
  }

  private async persistDeliveryOutcome(): Promise<void> {
    // Keep the actual send outcome across a failed bookkeeping write. The engine
    // suppresses errors after delivery starts, so finalization must retry it.
    const pending = this.persistence;
    if (pending.phase === "clear") return;
    if (pending.phase === "writing") return pending.done;
    const done = pending.write().then(
      () => { this.persistence = { phase: "clear" }; },
      (error) => { this.persistence = pending; throw error; },
    );
    this.persistence = { phase: "writing", done };
    await done;
  }

  async finishEngine(): Promise<{ deliveredSuccessfully: boolean }> {
    await this.persistDeliveryOutcome();
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
    if (this.hasDeliveryOutcome) {
      await this.persistDeliveryOutcome().catch((error) => {
        this.input.logger.error("turn delivery outcome could not be persisted", {
          turnRunId: this.input.turnRunId,
          threadId: this.input.threadId,
          error: String(error),
        });
      });
    } else if (this.cancelRequested) {
      await this.input.repos.turnRuns.markCancelled(this.input.turnRunId, this.input.ownerId);
    } else {
      await this.input.repos.turnRuns.markFailed(
        this.input.turnRunId,
        "turn_execution_failed",
        "failed",
        this.input.ownerId,
      );
    }
  }
}
