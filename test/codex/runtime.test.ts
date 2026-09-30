import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { CodexRuntimeManager } from "../../src/codex/runtime.js";
import type { CodexClient, RpcNotification, RpcRequest } from "../../src/codex/appServer.js";
import { asRecord } from "../../src/util/records.js";
import { workspaceRuntime, TEST_PNG } from "../helpers/workspaceRuntime.js";

class MockClient implements CodexClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly notifications = new Set<(event: RpcNotification) => void>();
  readonly requests = new Set<(event: RpcRequest) => Promise<unknown>>();
  readonly disconnects = new Set<() => void>();
  failure?: (method: string, params: Record<string, unknown>) => Error | undefined;
  additionalItems: unknown[] = [];
  resumeItems: unknown[] = [];
  readonly rolloutPaths = new Map<string, string>();
  turnFailure?: { message: string; codexErrorInfo: unknown };
  compactEvent?: (threadId: string) => RpcNotification;
  readonly initialize = vi.fn(async () => {});
  readonly dispose = vi.fn(async () => {});
  private nextThread = 0;
  private nextTurn = 0;
  async request<T = Record<string, unknown>>(method: string, input: unknown = {}): Promise<T> {
    const params = asRecord(input) ?? {};
    this.calls.push({ method, params });
    const failure = this.failure?.(method, params);
    if (failure) throw failure;
    if (method === "thread/start" || method === "thread/fork") return { thread: { id: `native-${++this.nextThread}` } } as T;
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [{ items: this.resumeItems }] } } as T;
    if (method === "thread/read") return { thread: { id: params.threadId, ...(this.rolloutPaths.has(String(params.threadId)) ? { path: this.rolloutPaths.get(String(params.threadId)) } : {}), turns: [{ items: [{ type: "userMessage" }, { type: "agentMessage" }] }] } } as T;
    if (method === "thread/compact/start") {
      setTimeout(() => this.emit(this.compactEvent?.(String(params.threadId)) ?? { method: "item/completed", params: { threadId: params.threadId, item: { type: "contextCompaction", id: "compact" } } }), 0);
      return {} as T;
    }
    if (method === "turn/start") {
      const id = `turn-${++this.nextTurn}`;
      const items = this.additionalItems;
      this.additionalItems = [];
      setTimeout(() => {
        if (this.turnFailure) {
          this.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id, status: "failed", error: this.turnFailure } } });
          return;
        }
        for (const item of items) this.emit({ method: "item/completed", params: { threadId: params.threadId, turnId: id, item } });
        this.emit({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: id, delta: "Native reply" } });
        this.emit({ method: "item/completed", params: { threadId: params.threadId, turnId: id, item: { type: "agentMessage", id: `message-${id}`, phase: "final_answer", text: "Native reply" } } });
        this.emit({ method: "turn/completed", params: { threadId: params.threadId, turn: { id, status: "completed" } } });
      }, 0);
      return { turn: { id, status: "inProgress" } } as T;
    }
    return {} as T;
  }
  emit(event: RpcNotification): void { for (const listener of this.notifications) listener(event); }
  methods(method: string) { return this.calls.filter(call => call.method === method); }
  onNotification(listener: (event: RpcNotification) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest(handler: (event: RpcRequest) => Promise<unknown>): () => void { this.requests.add(handler); return () => { this.requests.delete(handler); }; }
  onDisconnect(listener: () => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
}

const databases: AppDatabase[] = [];
const roots: string[] = [];
const managers: CodexRuntimeManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(databases.splice(0).map(db => db.destroy()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function setup(configured = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-test-"));
  roots.push(root);
  const config = loadTestConfig({ CODEX_HOME: path.join(root, "codex"), DB_URL: "sqlite::memory:", CODEX_REQUEST_TIMEOUT_MS: 1000 });
  const db = createDatabase(config);
  databases.push(db);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 100, firstName: "Existing", lang: "en" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Conversation" });
  const client = new MockClient();
  const commandRuntime = Object.assign(workspaceRuntime(), { prepareRemoteExecutor: vi.fn(async () => ({ directory: "/home/user/telegram-files", available: 0, files: [] })) });
  const auth = vi.fn(async () => ({ home: config.CODEX_HOME, configured }));
  const create = (replacement = client) => {
    const manager = new CodexRuntimeManager({ config, db, repos, logger: createLogger(config), commandRuntime, client: replacement, auth });
    managers.push(manager);
    return manager;
  };
  const manager = create();
  return { root, config, db, repos, user, thread, client, commandRuntime, auth, manager, create };
}

async function accept(input: Awaited<ReturnType<typeof setup>>, text = "Current question", thread = input.thread, manager = input.manager) {
  const active = await input.repos.messages.insert({ threadId: thread.id, role: "user", content: { text }, textPlain: text });
  const runtime = await manager.runtime((await input.repos.threads.get(thread.id))!, input.user);
  await runtime.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No fixture attachments"); } });
  return { runtime, active };
}

describe("Codex runtime integration", () => {
  it.each(["inject", "database"] as const)("retries a native repair safely after an %s failure without changing the source history", async failure => {
    const input = await setup();
    const sourcePath = path.join(input.config.CODEX_HOME, "sessions", "retry-native.jsonl");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const callId = "r".repeat(83);
    const contents = [
      { type: "session_meta", payload: { id: "retry-native" } },
      { type: "response_item", payload: { type: "function_call", name: "read", arguments: "{}", call_id: callId } },
      { type: "response_item", payload: { type: "function_call_output", call_id: callId, output: "Preserved result [[chat-file:17]]" } },
    ].map(value => JSON.stringify(value)).join("\n");
    await fs.writeFile(sourcePath, contents);
    input.client.rolloutPaths.set("retry-native", sourcePath);
    await input.repos.threads.setCodexSession(input.thread.id, "retry-native");
    if (failure === "inject") {
      let attempts = 0;
      input.client.failure = method => method === "thread/inject_items" && attempts++ === 0 ? new Error("Simulated repair failure") : undefined;
    } else vi.spyOn(input.repos.threads, "setCodexSession").mockRejectedValueOnce(new Error("Simulated repair failure"));
    const { runtime } = await accept(input);
    await expect(runtime.session.prompt("Continue")).rejects.toThrow("Simulated repair failure");
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("retry-native");
    if (failure === "inject") {
      await runtime.session.prompt("Continue");
      expect(input.client.methods("thread/start")).toHaveLength(2);
      expect(input.client.methods("thread/unsubscribe").some(call => call.params.threadId === "native-1")).toBe(true);
      expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("native-2");
    } else {
      const checkpoint = JSON.parse(await fs.readFile(path.join(input.config.CODEX_HOME, "executor-metadata", `conversation-${input.thread.id}.json`), "utf8"));
      expect(checkpoint.nativeId).toBe("native-1");
      expect(checkpoint.historySources[0].nativeId).toBe("retry-native");
      const replacement = new MockClient();
      const restarted = input.create(replacement);
      const resumed = await accept(input, "Retry after restart", input.thread, restarted);
      await resumed.runtime.session.prompt("Retry after restart");
      expect(replacement.methods("thread/start")).toHaveLength(0);
      expect(replacement.methods("thread/resume")[0]!.params.threadId).toBe("native-1");
      expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("native-1");
    }
    expect(await fs.readFile(sourcePath, "utf8")).toBe(contents);
  });

  it.each(["before", "after"] as const)("repairs malformed native history with the checkpoint %s a failed turn, preserving users and old fork cutoffs", async checkpoint => {
    const input = await setup();
    const callId = "legacy-" + "x".repeat(76);
    const sourcePath = path.join(input.config.CODEX_HOME, "sessions", "old-native.jsonl");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const record = (type: string, payload: object) => ({ type, payload });
    const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
    const turn = (id: string, text: string, reply?: string) => [
      record("event_msg", { type: "task_started", turn_id: id }),
      record("response_item", message("user", text)),
      ...(reply ? [record("response_item", message("assistant", reply))] : []),
      record("event_msg", { type: "task_complete", turn_id: id, ...(reply ? {} : { error: { message: "Rejected before output" } }) }),
    ];
    const contents = [record("session_meta", { id: "old-native", history_mode: "paginated" }),
      record("response_item", message("user", "Legacy context [[chat-file:17]]")),
      record("response_item", { type: "function_call", name: "read", arguments: "{}", call_id: callId }),
      record("response_item", { type: "function_call_output", output: "Tool result [[chat-file:17]]", call_id: callId }),
      ...turn("old-first", "First native question", "First native answer"),
      ...turn("old-later", "Later native question", "Later native answer"),
      ...turn("old-failed", "Previously rejected question"),
    ].map(value => JSON.stringify(value)).join("\n");
    await fs.writeFile(sourcePath, contents);
    input.client.rolloutPaths.set("old-native", sourcePath);
    const first = await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "First native answer", piEntryId: "codex:old-first" });
    const later = await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Later native answer", piEntryId: "codex:old-later" });
    const failed = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Previously rejected question", piEntryId: "codex:old-failed" });
    await input.repos.threads.setCodexSession(input.thread.id, "old-native", Date.now(), checkpoint === "after" ? failed.id : later.id);
    const { runtime } = await accept(input);
    await runtime.session.prompt("Continue");
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("native-1");
    const injected = input.client.methods("thread/inject_items");
    expect(injected).toHaveLength(1);
    expect(JSON.stringify(injected[0]!.params.items)).toContain("Later native answer");
    expect(JSON.stringify(injected[0]!.params.items).match(/Previously rejected question/g)).toHaveLength(1);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(contents);
    const checkpointFile = path.join(input.config.CODEX_HOME, "executor-metadata", `conversation-${input.thread.id}.json`);
    expect(JSON.parse(await fs.readFile(checkpointFile, "utf8")).historySources).toEqual([{ nativeId: "old-native", rolloutPath: sourcePath, turnIds: ["old-first", "old-later", "old-failed"] }]);
    await runtime.bridge.endTurn();
    const replacement = new MockClient();
    const restarted = input.create(replacement);
    const child = await input.repos.threads.create({ userId: input.user.tg_id, topicId: 7, title: "Old native fork", parentThreadId: input.thread.id, forkPointMessageId: first.id });
    await restarted.fork((await input.repos.threads.get(input.thread.id))!, child, input.user, "codex:old-first");
    expect(replacement.methods("thread/resume")[0]!.params.threadId).toBe("native-1");
    expect(replacement.methods("thread/fork")).toHaveLength(0);
    const forkItems = replacement.methods("thread/inject_items").at(-1)!.params.items;
    expect(JSON.stringify(forkItems)).toContain("First native answer");
    expect(JSON.stringify(forkItems)).not.toContain("Later native answer");
    expect(JSON.stringify(forkItems)).not.toContain("Previously rejected question");
    const linked = (forkItems as Array<Record<string, unknown>>).filter(item => item.call_id);
    expect(String(linked[0]!.call_id).length).toBeLessThanOrEqual(64);
    expect(linked[0]!.call_id).toBe(linked[1]!.call_id);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });
  it("protects native commands after a bot tool acquired activity without prematurely releasing either lease", async () => {
    const input = await setup();
    const releases = [vi.fn(), vi.fn()];
    let acquired = 0;
    const acquireActivityLease = vi.fn((_userId: number, _threadId: number, _options?: { native?: boolean }) => ({ release: releases[acquired++]! }));
    Object.assign(input.commandRuntime, { acquireActivityLease });
    const { runtime } = await accept(input);
    runtime.bridge.holdCommandActivity();
    runtime.bridge.holdCommandActivity(true);
    runtime.bridge.holdCommandActivity(true);
    runtime.bridge.holdCommandActivity();
    expect(acquireActivityLease).toHaveBeenCalledTimes(2);
    expect(acquireActivityLease).toHaveBeenLastCalledWith(input.user.tg_id, input.thread.id, { native: true });
    expect(releases.every(release => release.mock.calls.length === 0)).toBe(true);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    await runtime.bridge.endTurn();
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
  });

  it("completes native compaction when persistent audit history retains its items without starting E2B", async () => {
    const input = await setup();
    const removed = await input.manager.compact(input.thread, input.user);
    expect(removed).toBe(0);
    expect(input.client.methods("thread/compact/start")).toHaveLength(1);
    expect(input.client.methods("thread/read")).toHaveLength(2);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
    expect(input.commandRuntime.materializeFiles).not.toHaveBeenCalled();
  });

  it.each(["error", "turn/completed"])("rejects failed native compaction promptly on %s and removes its wait listener", async method => {
    const input = await setup();
    input.client.compactEvent = threadId => ({ method, params: { threadId,
      ...(method === "error" ? { willRetry: false, error: { message: "Compaction fixture denied", codexErrorInfo: "usageLimitExceeded" } } : { turn: { status: "failed", error: { message: "Compaction fixture denied", codexErrorInfo: "usageLimitExceeded" } } }),
    } });
    await input.manager.runtime(input.thread, input.user);
    const before = input.client.notifications.size;
    await expect(input.manager.compact(input.thread, input.user)).rejects.toThrow("Compaction fixture denied");
    expect(input.client.methods("thread/read")).toHaveLength(1);
    expect(input.client.notifications.size).toBe(before);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("reports compaction unavailable when subscription authentication is missing", async () => {
    const input = await setup(false);
    await expect(input.manager.compact(input.thread, input.user)).rejects.toThrow("Codex memory compaction is temporarily unavailable");
    expect(input.client.methods("thread/compact/start")).toHaveLength(0);
    expect(input.client.methods("thread/start")).toHaveLength(0);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("uses the expanded Codex home consistently for runtime metadata and native artifacts", async () => {
    const input = await setup();
    const userHome = path.join(input.root, "user-home");
    const expanded = path.join(userHome, "bot-codex");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    input.config.CODEX_HOME = "~/bot-codex";
    const manager = input.create();
    await manager.initialize();
    expect((await fs.stat(path.join(expanded, "executor-metadata"))).isDirectory()).toBe(true);
    const artifact = path.join(expanded, "generated_images", "native-1", "image.png");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, TEST_PNG);
    const { runtime } = await accept(input, "Use a generated image", input.thread, manager);
    expect(() => runtime.bridge.registerNativeArtifact(artifact)).not.toThrow();
    expect((await runtime.bridge.outgoingFiles.workspace([{ path: artifact }])).errors).toEqual([]);
  });

  it("imports old Pi history before saving session metadata and keeps ordinary chats independent of E2B", async () => {
    const input = await setup();
    const oldFile = path.join(input.root, "old-pi.jsonl");
    const old = [{ type: "session", version: 3, id: "old-pi", timestamp: "2026-01-01T00:00:00Z", cwd: "/old" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Remember the old detail" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Old reply" }] } }].map(item => JSON.stringify(item)).join("\n") + "\n";
    await fs.writeFile(oldFile, old);
    await input.repos.threads.setPiSession(input.thread.id, oldFile, "old-pi");
    await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Remember the old detail", piEntryId: "u1" });
    await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Old reply", piEntryId: "a1" });
    const save = vi.spyOn(input.repos.threads, "setCodexSession");
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).toContain("Remember the old detail");
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).not.toContain("Current question");
    expect(save).toHaveBeenCalledTimes(1);
    expect(input.client.calls.findIndex(call => call.method === "thread/inject_items")).toBeLessThan(input.client.calls.findIndex(call => call.method === "turn/start"));
    const nativeId = (await input.repos.threads.get(input.thread.id))!.codex_thread_id;
    expect(nativeId).toBe("native-1");
    expect(await fs.readFile(oldFile, "utf8")).toBe(old);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.materializeFiles).not.toHaveBeenCalled();
    expect(input.commandRuntime.execute).not.toHaveBeenCalled();
  });

  it("keeps failed imports uncommitted and retries without duplicating history in a live thread", async () => {
    const input = await setup();
    await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Old context" });
    let failed = false;
    input.client.failure = method => method === "thread/inject_items" && !failed ? (failed = true, new Error("Invalid imported history")) : undefined;
    const { runtime } = await accept(input);
    await expect(runtime.session.prompt("Current question")).rejects.toThrow("Invalid imported history");
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBeNull();
    await runtime.session.prompt("Current question");
    await runtime.session.prompt("Follow-up");
    expect(input.client.methods("thread/start")).toHaveLength(2);
    expect(input.client.methods("thread/inject_items")).toHaveLength(2);
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("native-2");
  });

  it("resumes persistent threads after restart and injects only fallback messages after their checkpoint", async () => {
    const input = await setup();
    const old = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Already native" });
    await input.repos.threads.setCodexSession(input.thread.id, "persisted-native", Date.now(), old.id);
    await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Native answer with missed delivery checkpoint", piEntryId: "codex:previous-turn" });
    const fallback = await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "OpenRouter-only continuation" });
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    expect(input.client.methods("thread/start")).toHaveLength(0);
    expect(input.client.methods("thread/resume")).toHaveLength(1);
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).toContain("OpenRouter-only continuation");
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).not.toContain("Already native");
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).not.toContain("Native answer with missed delivery checkpoint");
    expect((await input.repos.threads.get(input.thread.id))!.codex_history_message_id).toBeGreaterThan(fallback.id);
    await input.manager.dispose();
    const restartedClient = new MockClient();
    const restarted = input.create(restartedClient);
    const next = await accept(input, "After restart", input.thread, restarted);
    await next.runtime.session.prompt("After restart");
    expect(restartedClient.methods("thread/resume")).toHaveLength(1);
    expect(restartedClient.methods("thread/start")).toHaveLength(0);
    expect(restartedClient.methods("thread/inject_items")).toHaveLength(0);
  });

  it("rebuilds a missing native rollout from durable database history", async () => {
    const input = await setup();
    const old = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Durable old context", piEntryId: "codex:lost-turn" });
    await input.repos.threads.setCodexSession(input.thread.id, "missing-rollout", Date.now(), old.id);
    input.client.failure = method => method === "thread/resume" ? new Error("thread not found: no rollout") : undefined;
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    expect(input.client.methods("thread/start")).toHaveLength(1);
    expect(JSON.stringify(input.client.methods("thread/inject_items"))).toContain("Durable old context");
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe("native-1");
  });

  it("does not replay a successful catch-up after its database checkpoint write fails", async () => {
    const input = await setup();
    const old = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Already native" });
    await input.repos.threads.setCodexSession(input.thread.id, "persisted-native", Date.now(), old.id);
    await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Fallback context to inject once" });
    vi.spyOn(input.repos.threads, "setCodexHistoryMessageId").mockRejectedValueOnce(new Error("Checkpoint write failed"));
    const { runtime } = await accept(input);
    await expect(runtime.session.prompt("Current question")).rejects.toThrow("Checkpoint write failed");
    await runtime.session.prompt("Current question");
    const injectedByThread = new Map<string, number>();
    for (const call of input.client.methods("thread/inject_items")) {
      const id = String(call.params.threadId);
      injectedByThread.set(id, (injectedByThread.get(id) ?? 0) + 1);
    }
    expect([...injectedByThread.values()].every(count => count === 1)).toBe(true);
  });

  it.each(["initial", "catchup"])("recovers a successful %s import after a failed checkpoint commit and manager restart", async kind => {
    const input = await setup();
    const old = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Durable context imported once" });
    if (kind === "catchup") {
      await input.repos.threads.setCodexSession(input.thread.id, "persisted-native", Date.now(), old.id);
      await input.repos.messages.insert({ threadId: input.thread.id, role: "assistant", content: {}, textPlain: "Fallback continuation imported once" });
    }
    const method = kind === "initial" ? "setCodexSession" : "setCodexHistoryMessageId";
    vi.spyOn(input.repos.threads, method).mockRejectedValueOnce(new Error("Checkpoint commit failed"));
    const { runtime, active } = await accept(input);
    await expect(runtime.session.prompt("Current question")).rejects.toThrow("Checkpoint commit failed");
    expect(input.client.methods("thread/inject_items")).toHaveLength(1);
    await input.manager.dispose();
    const client = new MockClient();
    const restarted = input.create(client);
    const recovered = await restarted.runtime((await input.repos.threads.get(input.thread.id))!, input.user);
    await recovered.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, userMessageId: active.id, resolveFile: async () => { throw new Error("No attachments"); } });
    await recovered.session.prompt("Current question");
    expect(client.methods("thread/start")).toHaveLength(0);
    expect(client.methods("thread/resume")).toHaveLength(1);
    expect(client.methods("thread/inject_items")).toHaveLength(0);
    expect((await input.repos.threads.get(input.thread.id))!.codex_thread_id).toBe(kind === "initial" ? "native-1" : "persisted-native");
  });

  it("uses OpenRouter with full old history when authentication is missing and never starts E2B", async () => {
    const input = await setup(false);
    await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Old context for fallback" });
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Fallback reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(JSON.stringify(request.messages)).toContain("Old context for fallback");
    expect(runtime.session.model.id).toBe(input.config.OPENROUTER_MAIN_MODEL);
    expect(input.client.methods("thread/start")).toHaveLength(0);
    expect(input.client.methods("environment/add")).toHaveLength(0);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it.each(["usageLimitExceeded", "rateLimitExceeded", "unauthorized", { httpConnectionFailed: { httpStatusCode: 401 } }])("falls back for a structured provider availability error %j", async codexErrorInfo => {
    const input = await setup();
    input.client.failure = method => method === "turn/start" ? Object.assign(new Error("Generation failed"), { codexErrorInfo }) : undefined;
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Fallback after unavailable provider"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runtime.session.model.id).toBe(input.config.OPENROUTER_MAIN_MODEL);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("does not switch providers for a structured sandbox failure", async () => {
    const input = await setup();
    input.client.failure = method => method === "turn/start" ? Object.assign(new Error("Generation failed"), { codexErrorInfo: "sandboxError" }) : undefined;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { runtime } = await accept(input);
    await expect(runtime.session.prompt("Current question")).rejects.toThrow("Generation failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs caption and title helpers without environments or sandbox startup", async () => {
    const input = await setup();
    expect(await input.manager.captionImage(TEST_PNG, "image/png", "My image")).toBe("Native reply");
    expect(await input.manager.generateThreadTitle({ userText: "Old and new chat", assistantText: "A reply" })).toBe("Native reply");
    expect(input.client.methods("thread/start")).toHaveLength(2);
    expect(input.client.methods("thread/start").every(call => Array.isArray(call.params.environments) && call.params.environments.length === 0 && call.params.ephemeral === true)).toBe(true);
    expect(input.client.methods("turn/start").every(call => Array.isArray(call.params.environments) && call.params.environments.length === 0)).toBe(true);
    expect(JSON.stringify(input.client.methods("turn/start")[0])).toContain("data:image/png;base64,");
    expect(input.client.methods("environment/add")).toHaveLength(0);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("falls back for a structured subscription failure in a helper turn", async () => {
    const input = await setup();
    input.client.turnFailure = { message: "Generation failed", codexErrorInfo: "usageLimitExceeded" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Fallback helper caption"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    expect(await input.manager.captionImage(TEST_PNG, "image/png")).toBe("Fallback helper caption");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("recovers helpers when their app-server disconnects while turn/start rejects", async () => {
    const input = await setup();
    input.client.failure = method => {
      if (method !== "turn/start") return undefined;
      for (const listener of input.client.disconnects) listener();
      return new Error("Codex app-server is disconnected.");
    };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Fallback helper title"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    expect(await input.manager.generateThreadTitle({ userText: "Title this" })).toBe("Fallback helper title");
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("binds a fork's first turn to its own executor environment", async () => {
    const input = await setup();
    const source = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Fork context" });
    const target = await input.repos.threads.create({ userId: input.user.tg_id, topicId: null, title: "Fork", parentThreadId: input.thread.id, forkPointMessageId: source.id });
    await input.manager.fork(input.thread, target, input.user);
    const { runtime } = await accept(input, "Question in fork", target);
    await runtime.session.prompt("Question in fork");
    const targetEnv = `telegram:${input.user.tg_id}:${target.id}`;
    expect(input.client.methods("environment/add").at(-1)!.params.environmentId).toBe(targetEnv);
    expect(input.client.methods("turn/start").at(-1)!.params.environments).toEqual([{ environmentId: targetEnv, cwd: "/home/user/workspace" }]);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
  });

  it("delivers native generated images from the bot host without creating a sandbox", async () => {
    const input = await setup();
    const generated = path.join(input.config.CODEX_HOME, "generated_images", "native-1", "image.png");
    await fs.mkdir(path.dirname(generated), { recursive: true });
    await fs.writeFile(generated, TEST_PNG);
    input.client.additionalItems = [{ type: "imageGeneration", id: "image-call", status: "completed", savedPath: generated }];
    const { runtime } = await accept(input, "Generate an image");
    await runtime.session.prompt("Generate an image");
    const result = await runtime.bridge.outgoingFiles.workspace([{ path: generated, delivery: "document" }]);
    expect(result.errors).toEqual([]);
    expect(result.prepared[0]!.attachment).toMatchObject({ origin: "generated_image", type: "image", delivery: "document" });
    expect((await input.repos.files.get(result.prepared[0]!.attachment.fileId))!.type).toBe("image");
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.readWorkspaceFile).not.toHaveBeenCalled();
    expect(input.commandRuntime.materializeFiles).not.toHaveBeenCalled();
  });

  it("recovers earlier native image artifacts when resuming an existing thread", async () => {
    const input = await setup();
    await input.repos.threads.setCodexSession(input.thread.id, "existing-native");
    const generated = path.join(input.config.CODEX_HOME, "generated_images", "existing-native", "old-image.png");
    await fs.mkdir(path.dirname(generated), { recursive: true });
    await fs.writeFile(generated, TEST_PNG);
    input.client.resumeItems = [{ type: "imageGeneration", id: "old-image-call", status: "completed", savedPath: generated }];
    const { runtime } = await accept(input);
    await runtime.session.prompt("Current question");
    expect(runtime.bridge.isNativeArtifact(generated)).toBe(true);
    expect((await runtime.bridge.outgoingFiles.workspace([{ path: generated }])).errors).toEqual([]);
    expect(input.commandRuntime.prepareRemoteExecutor).not.toHaveBeenCalled();
    expect(input.commandRuntime.readWorkspaceFile).not.toHaveBeenCalled();
  });
});
