import { describe, expect, it, vi } from "vitest";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { deferred } from "../helpers/async.js";

describe("Pi runtime barrier operations", () => {
  it("aborts an in-flight compaction when its barrier signal is cancelled", async () => {
    const compaction = deferred<void>();
    const abortCompaction = vi.fn(() => compaction.reject(new Error("Compaction cancelled")));
    const session = {
      getSessionStats: vi.fn(() => ({ totalMessages: 4 })),
      compact: vi.fn(() => compaction.promise),
      abortCompaction,
    };
    const manager = Object.create(PiRuntimeManager.prototype) as PiRuntimeManager;
    vi.spyOn(manager, "runtime").mockResolvedValue({
      session,
      bridge: {},
      lastUsedAt: Date.now(),
    } as never);
    const controller = new AbortController();
    const execution = manager.compact({} as never, {} as never, controller.signal);
    await vi.waitFor(() => expect(session.compact).toHaveBeenCalledOnce());

    controller.abort(new Error("Thread operation barrier lease was lost."));

    await expect(execution).rejects.toThrow("Compaction cancelled");
    expect(abortCompaction).toHaveBeenCalledOnce();
  });

  it("does not fork a Pi session after its barrier signal is cancelled", async () => {
    const runtime = deferred<never>();
    const manager = Object.create(PiRuntimeManager.prototype) as PiRuntimeManager;
    vi.spyOn(manager, "runtime").mockReturnValue(runtime.promise);
    const controller = new AbortController();
    const execution = manager.fork({} as never, {} as never, {} as never, null, controller.signal);

    controller.abort(new Error("Thread operation barrier lease was lost."));
    runtime.resolve({
      session: {
        sessionManager: { getLeafId: vi.fn(() => "entry") },
      },
      bridge: {},
      lastUsedAt: Date.now(),
    } as never);

    await expect(execution).rejects.toThrow("barrier lease was lost");
  });
});
