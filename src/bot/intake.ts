import { ConversationError } from "../application/errors.js";
import { isAbortError } from "../files/cancel.js";

/**
 * Pauses between durable acceptance attempts: four attempts with 3.5 seconds of
 * waiting in total. Retrying is safe because Telegram update IDs deduplicate a
 * commit whose acknowledgement was lost. The retry budget lives in memory only;
 * an abrupt process exit still loses input that has not been accepted.
 */
export const INTAKE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];

export type IntakeOutcome<T> =
  | { status: "accepted"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown; attempts: number };

interface Acceptance {
  threadId: string;
  label: string;
  controller: AbortController;
}

/**
 * Owns Telegram work that holds input which is not yet durable, and other
 * detached Telegram work that must finish before the database closes.
 */
export class TelegramIntake {
  private readonly acceptances = new Set<Acceptance>();
  private readonly work = new Map<Promise<unknown>, string>();

  constructor(private readonly retryDelaysMs: readonly number[] = INTAKE_RETRY_DELAYS_MS) {}

  /** Keep shutdown waiting for this work. Rejections are observed here and stay with the caller. */
  track<T>(label: string, promise: Promise<T>): Promise<T> {
    const settled = promise.then(() => undefined, () => undefined);
    this.work.set(settled, label);
    void settled.finally(() => this.work.delete(settled));
    return promise;
  }

  /** Accept input durably, retrying transient failures until the budget runs out or the thread stops it. */
  accept<T>(
    threadId: string,
    label: string,
    attempt: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<IntakeOutcome<T>> {
    const acceptance: Acceptance = { threadId, label, controller: new AbortController() };
    const forward = () => acceptance.controller.abort(parent?.reason);
    if (parent?.aborted) forward();
    else parent?.addEventListener("abort", forward, { once: true });
    this.acceptances.add(acceptance);
    const run = this.retry(acceptance.controller.signal, attempt).finally(() => {
      parent?.removeEventListener("abort", forward);
      this.acceptances.delete(acceptance);
    });
    return this.track(label, run);
  }

  /** Stop input for one thread that has not been accepted yet. Other threads are untouched. */
  cancel(threadId: string): boolean {
    let cancelled = false;
    for (const acceptance of this.acceptances) {
      if (acceptance.threadId !== threadId || acceptance.controller.signal.aborted) continue;
      acceptance.controller.abort(cancelledError());
      cancelled = true;
    }
    return cancelled;
  }

  get pending(): number {
    return this.work.size;
  }

  /**
   * Wait for tracked work, calling `flush` before each wait so batches that are
   * still collecting are sent now. After the deadline, input that is still not
   * accepted is cancelled and its labels are returned.
   */
  async drain(timeoutMs: number, flush: () => void = () => undefined): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      flush();
      if (!this.work.size) return [];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.race(this.work.keys()),
        new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timer);
    }
    const residue = [...this.work.values()];
    for (const acceptance of this.acceptances) acceptance.controller.abort(cancelledError());
    return residue;
  }

  private async retry<T>(signal: AbortSignal, attempt: (signal: AbortSignal) => Promise<T>): Promise<IntakeOutcome<T>> {
    for (let attempts = 1; ; attempts++) {
      if (signal.aborted) return { status: "cancelled" };
      try {
        return { status: "accepted", value: await attempt(signal) };
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return { status: "cancelled" };
        const pause = this.retryDelaysMs[attempts - 1];
        if (pause === undefined || !isTransientAcceptanceError(error)) return { status: "failed", error, attempts };
        if (!await sleep(pause, signal)) return { status: "cancelled" };
      }
    }
  }
}

/** Refusals and shutdown are final. Everything else may be a passing database or network fault. */
export function isTransientAcceptanceError(error: unknown): boolean {
  if (error instanceof ConversationError || isAbortError(error)) return false;
  return !(error instanceof Error && error.message === "Turn coordinator is shutting down.");
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError(): Error {
  const error = new Error("Telegram input was cancelled before it was accepted.");
  error.name = "AbortError";
  return error;
}
