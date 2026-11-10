import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationError } from "../../src/application/errors.js";
import { INTAKE_RETRY_DELAYS_MS, TelegramIntake, isTransientAcceptanceError } from "../../src/bot/intake.js";
import { deferred } from "../helpers/async.js";

afterEach(() => { vi.useRealTimers(); });

describe("Telegram intake", () => {
  it("documents a bounded retry budget", () => {
    expect(INTAKE_RETRY_DELAYS_MS).toEqual([500, 1_000, 2_000]);
  });

  it("retries transient failures with the configured backoff and stops after success", async () => {
    vi.useFakeTimers();
    const intake = new TelegramIntake([10, 20, 40]);
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue("turn");
    const outcome = intake.accept("thread-a", "update 1", attempt);
    await vi.advanceTimersByTimeAsync(10);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    await expect(outcome).resolves.toEqual({ status: "accepted", value: "turn" });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(intake.pending).toBe(0);
  });

  it("reports failure after the budget is exhausted", async () => {
    vi.useFakeTimers();
    const intake = new TelegramIntake([5, 5]);
    const error = new Error("database is down");
    const outcome = intake.accept("thread-a", "update 1", vi.fn().mockRejectedValue(error));
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toEqual({ status: "failed", error, attempts: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry refusals or shutdown", async () => {
    const intake = new TelegramIntake([5]);
    for (const error of [new ConversationError(409, "archived"), new Error("Turn coordinator is shutting down.")]) {
      const attempt = vi.fn().mockRejectedValue(error);
      await expect(intake.accept("thread-a", "update", attempt)).resolves.toMatchObject({ status: "failed", attempts: 1 });
      expect(attempt).toHaveBeenCalledOnce();
      expect(isTransientAcceptanceError(error)).toBe(false);
    }
    expect(isTransientAcceptanceError(new Error("ECONNRESET"))).toBe(true);
  });

  it("cancels input waiting to retry for one thread only and clears its timer", async () => {
    vi.useFakeTimers();
    const intake = new TelegramIntake([60_000]);
    const stopped = intake.accept("thread-a", "a", vi.fn().mockRejectedValue(new Error("transient")));
    const otherAttempt = deferred<string>();
    const other = intake.accept("thread-b", "b", () => otherAttempt.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(intake.cancel("thread-a")).toBe(true);
    await expect(stopped).resolves.toEqual({ status: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    expect(intake.cancel("thread-a")).toBe(false);
    otherAttempt.resolve("other");
    await expect(other).resolves.toEqual({ status: "accepted", value: "other" });
  });

  it("passes cancellation to an attempt in progress and follows its caller's signal", async () => {
    const intake = new TelegramIntake([5]);
    let seen: AbortSignal | undefined;
    const running = intake.accept("thread-a", "a", (signal) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    intake.cancel("thread-a");
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(seen?.aborted).toBe(true);

    const parent = new AbortController();
    parent.abort(new Error("file job cancelled"));
    const attempt = vi.fn();
    await expect(intake.accept("thread-a", "b", attempt, parent.signal)).resolves.toEqual({ status: "cancelled" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("drains tracked work, flushing collecting batches first", async () => {
    const intake = new TelegramIntake([5]);
    const release = deferred<void>();
    void intake.track("update", release.promise);
    const flush = vi.fn(() => {
      if (flush.mock.calls.length === 1) void intake.track("batch", Promise.resolve());
    });
    const draining = intake.drain(1_000, flush);
    release.resolve();
    await expect(draining).resolves.toEqual([]);
    expect(flush).toHaveBeenCalled();
    expect(intake.pending).toBe(0);
  });

  it("cancels and reports input that is still not accepted at the deadline", async () => {
    const intake = new TelegramIntake([60_000]);
    const outcome = intake.accept("thread-a", "telegram updates 7", vi.fn().mockRejectedValue(new Error("transient")));
    await expect(intake.drain(20)).resolves.toEqual(["telegram updates 7"]);
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(intake.pending).toBe(0);
  });

  it("returns tracked rejections to the caller without leaving them unobserved", async () => {
    const intake = new TelegramIntake();
    const failure = intake.track("update", Promise.reject(new Error("boom")));
    await expect(failure).rejects.toThrow("boom");
    await expect(intake.drain(100)).resolves.toEqual([]);
  });
});
