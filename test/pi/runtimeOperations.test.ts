import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import { deferred } from "../helpers/async.js";
import { TEST_PNG } from "../helpers/workspaceRuntime.js";

describe("Pi runtime barrier operations", () => {
  it("aborts and disposes the caption helper when image processing is cancelled", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-caption-cancel-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "missing-auth.json"), PI_TURN_TIMEOUT_MS: 0 });
    const started = deferred<AbortSignal>();
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const manager = new PiRuntimeManager({
      config, logger: createLogger(config), db: undefined as never, repos: undefined as never,
      providerStreams: { openRouter: (_model, _context, options) => {
        started.resolve(options!.signal!);
        // The router must release even a transport that ignores cancellation.
        return createAssistantMessageEventStream();
      } },
    });
    try {
      const controller = new AbortController();
      const caption = manager.captionImage(TEST_PNG, "image/png", controller.signal);
      const rejected = expect(caption).rejects.toThrow("user cancelled");
      const providerSignal = await started.promise;
      controller.abort(new Error("user cancelled"));
      await rejected;
      expect(providerSignal.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(dispose.mock.instances[0]).toMatchObject({ isStreaming: false });
    } finally {
      await manager.dispose();
      dispose.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("reports messages removed from active context while retaining the complete history", async () => {
    const sessionManager = SessionManager.inMemory();
    for (let index = 0; index < 4; index++) {
      sessionManager.appendMessage({ role: "user", content: `Request ${index}`, timestamp: index });
    }
    const session = {
      sessionManager,
      getSessionStats: () => ({ totalMessages: 4 }),
      compact: async () => { sessionManager.appendCompaction("Earlier requests", sessionManager.getLeafId()!, 1000); },
    };
    const manager = Object.create(PiRuntimeManager.prototype) as PiRuntimeManager;
    vi.spyOn(manager, "runtime").mockResolvedValue({ session, bridge: {}, lastUsedAt: 0 } as never);

    await expect(manager.compact({} as never, {} as never)).resolves.toBe(3);
    expect(sessionManager.getEntries().filter(entry => entry.type === "message")).toHaveLength(4);
  });

  it("aborts an in-flight compaction when its barrier signal is cancelled", async () => {
    const compaction = deferred<void>();
    const abortCompaction = vi.fn(() => compaction.reject(new Error("Compaction cancelled")));
    const session = {
      sessionManager: SessionManager.inMemory(),
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
