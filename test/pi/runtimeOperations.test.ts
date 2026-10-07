import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
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

  it("keeps original and forked sessions independent when both conversations continue", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fork-isolation-"));
    try {
      const source = SessionManager.create(process.cwd(), directory);
      const branchPoint = source.appendMessage({ role: "user", content: "Shared request", timestamp: 1 });
      source.appendMessage({ role: "user", content: "Later original request", timestamp: 2 });
      const sourceFile = source.getSessionFile()!;
      const sourceId = source.getSessionId();
      const setPiSession = vi.fn(async () => {});
      const config = loadTestConfig();
      const manager = new PiRuntimeManager({
        config, logger: createLogger(config), db: undefined as never,
        repos: { threads: { setPiSession } } as never,
      });
      vi.spyOn(manager, "runtime").mockResolvedValue({ session: { sessionManager: source }, bridge: {}, lastUsedAt: 0 } as never);

      await manager.fork({ id: 1 } as never, { id: 2 } as never, {} as never, branchPoint);

      expect(source.getSessionFile()).toBe(sourceFile);
      expect(source.getSessionId()).toBe(sourceId);
      const [, targetFile, targetId] = setPiSession.mock.calls[0] as unknown as [number, string, string];
      const target = SessionManager.open(targetFile, directory);
      expect(targetId).not.toBe(sourceId);
      source.appendMessage({ role: "user", content: "Original continuation", timestamp: 3 });
      target.appendMessage({ role: "user", content: "Fork continuation", timestamp: 4 });
      const history = (file: string) => SessionManager.open(file, directory).buildSessionContext().messages
        .filter(message => message.role === "user").map(message => message.content);
      expect(history(sourceFile)).toEqual(["Shared request", "Later original request", "Original continuation"]);
      expect(history(targetFile)).toEqual(["Shared request", "Fork continuation"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("reloads current session history when thread ownership moves between workers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-handoff-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "missing-auth.json") });
    const db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 771, firstName: "Worker" });
    const staleThread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const requests: string[][] = [];
    const input: ConstructorParameters<typeof PiRuntimeManager>[0] = {
      config, db, repos, logger: createLogger(config),
      providerStreams: { openRouter: (model, context) => {
        requests.push(context.messages.filter(message => message.role === "user").map(message =>
          typeof message.content === "string" ? message.content : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("")));
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: {
          role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
          content: [{ type: "text", text: "Acknowledged" }], stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
        return stream;
      } },
    };
    const first = new PiRuntimeManager(input);
    const second = new PiRuntimeManager(input);
    try {
      const original = await first.runtime(staleThread, user);
      await original.session.prompt("Worker A");
      // The caller may have captured the row before waiting on a thread barrier.
      const remote = await second.runtime(staleThread, user);
      await remote.session.prompt("Worker B");
      const resumed = await first.runtime(staleThread, user);
      await resumed.session.prompt("Worker A again");
      await resumed.session.prompt("Same worker continues");
      const wake = expect.stringContaining('call memo with {"args":["wake"]}');
      expect(requests).toEqual([
        ["Worker A", wake],
        ["Worker A", wake, "Worker B", wake],
        ["Worker A", wake, "Worker B", wake, "Worker A again", wake],
        ["Worker A", wake, "Worker B", wake, "Worker A again", wake, "Same worker continues"],
      ]);
      expect(resumed.session.sessionId).toBe(remote.session.sessionId);
      expect(resumed.session).not.toBe(original.session);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await db.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
