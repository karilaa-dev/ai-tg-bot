import { afterEach, describe, expect, it, vi } from "vitest";
import { runPiPromptWithTimeout } from "../../src/ai/agentTurnEngine.js";
import { deferred } from "../helpers/async.js";
import { loadTestConfig } from "../../src/config.js";

afterEach(() => vi.useRealTimers());

describe("Pi prompt timeout", () => {
  it("has no default deadline and still waits for user cancellation to settle", async () => {
    vi.useFakeTimers();
    const prompt = deferred<void>();
    const abort = vi.fn(async () => undefined);
    const controller = new AbortController();
    const execution = runPiPromptWithTimeout({ prompt: vi.fn(() => prompt.promise), abort } as never,
      "work", loadTestConfig().PI_TURN_TIMEOUT_MS, controller.signal);
    let finished = false;
    const observed = execution.catch((error: unknown) => error).finally(() => { finished = true; });

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(abort).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    const reason = new Error("User stopped the turn");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    prompt.reject(new Error("prompt stopped"));
    expect(await observed).toBe(reason);
    expect(finished).toBe(true);
  });

  it("waits for the aborted prompt to settle before returning", async () => {
    const prompt = deferred<void>();
    const abort = vi.fn(async () => undefined);
    const execution = runPiPromptWithTimeout({
      prompt: vi.fn(() => prompt.promise),
      abort,
    } as never, "work", 10);
    let finished = false;
    const observed = execution.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    ).finally(() => { finished = true; });

    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    prompt.reject(new Error("prompt stopped"));

    const result = await observed;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("timed out after 10 ms");
    expect(finished).toBe(true);
  });
});
