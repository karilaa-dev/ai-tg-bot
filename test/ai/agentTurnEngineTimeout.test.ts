import { describe, expect, it, vi } from "vitest";
import { runPiPromptWithTimeout } from "../../src/ai/agentTurnEngine.js";
import { deferred } from "../helpers/async.js";

describe("Pi prompt timeout", () => {
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
