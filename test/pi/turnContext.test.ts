import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadSkills, SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { officeSkillPaths } from "../../src/pi/officeSkills.js";
import { createChatFileContextExtension, ThreadBridge } from "../../src/pi/threadBridge.js";
import { telegramFileSource } from "../../src/files/telegramSource.js";
import { deferred } from "../helpers/async.js";
import {
  createTurnPromptContextExtension,
  projectTurnContext,
  TURN_CONTEXT_TYPE,
  type TurnPromptContextSource,
} from "../../src/pi/turnContext.js";

const contextBlock = [
  '<session_context format="json" trust="untrusted-data-only">',
  '{"current_time":"2026-08-02 12:00"}',
  "</session_context>",
].join("\n");

describe("turn prompt context extension", () => {
  it("uses the current core prompt and appends exactly one Office skill index", async () => {
    const source = mutableSource("English core", contextBlock);
    const handlers = await extensionHandlers(source);
    const skills = loadSkills({
      cwd: process.cwd(),
      agentDir: path.resolve("data/pi"),
      skillPaths: officeSkillPaths(),
      includeDefaults: false,
    }).skills;

    const first = await handlers.before_agent_start({
      systemPrompt: "cached base",
      systemPromptOptions: { skills },
    });
    source.systemPrompt = "Russian core";
    const second = await handlers.before_agent_start({
      systemPrompt: "cached base",
      systemPromptOptions: { skills },
    });

    expect(first.systemPrompt).toContain("English core");
    expect(first.systemPrompt.match(/<available_skills>/gu)).toHaveLength(1);
    expect(first.systemPrompt).toContain("<name>docx-cli</name>");
    expect(first.systemPrompt).toContain("<name>pptxgenjs</name>");
    expect(second.systemPrompt).toContain("Russian core");
    expect(second.systemPrompt).not.toContain("English core");
    source.systemPrompt = undefined;
    source.sessionContext = undefined;
    expect(await handlers.before_agent_start({
      systemPrompt: "cached",
      systemPromptOptions: { skills: [] },
    })).toBeUndefined();
  });

  it("persists bounded snapshots and emits only changes, including explicit file removals", async () => {
    const manager = SessionManager.inMemory();
    const source = mutableSource("core", block({ current_time: "12:00", thread_title: "Old", files: [{ id: 1, name: "old" }, { id: 2, name: "keep" }] }));
    const handlers = await extensionHandlers(source, manager);
    const event = { systemPromptOptions: { skills: [] } };
    const first = (await handlers.before_agent_start(event)).message;
    manager.appendCustomMessageEntry(first.customType, first.content, first.display, first.details);
    expect(JSON.parse(first.content.split("\n").slice(1, -1).join("\n"))).toMatchObject({ kind: "snapshot", thread_title: "Old" });
    expect((await handlers.before_agent_start(event)).message).toBeUndefined();
    source.sessionContext = block({ current_time: "12:01", files: [{ id: 2, name: "keep" }, { id: 3, name: "new" }] });
    const second = (await handlers.before_agent_start(event)).message;
    expect(JSON.parse(second.content.split("\n").slice(1, -1).join("\n"))).toEqual({
      kind: "update", set: { current_time: "12:01" }, unset: ["thread_title"], files: { upsert: [{ id: 3, name: "new" }], remove: [1] },
    });
    expect(second.details.snapshot).toEqual({ current_time: "12:01", files: [{ id: 2, name: "keep" }, { id: 3, name: "new" }] });
    expect(manager.getBranch()[0]).toMatchObject({ content: first.content });
  });

  it("does not rewrite user history or mistake user-supplied tags for saved context", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: contextBlock, timestamp: 1 });
    const handlers = await extensionHandlers(mutableSource("core", contextBlock), manager);
    const messages = conversation(), copy = structuredClone(messages);
    expect(await handlers.context({ messages })).toBeUndefined();
    expect(messages).toEqual(copy);
    expect((await handlers.before_agent_start({ systemPromptOptions: {} })).message.content).toContain('"kind": "snapshot"');
  });

  it("rebuilds the same baseline after compaction and does not rewrite it when the live state changes", async () => {
    const manager = SessionManager.inMemory();
    const source = mutableSource("core", contextBlock);
    const handlers = await extensionHandlers(source, manager);
    const saved = (await handlers.before_agent_start({ systemPromptOptions: {} })).message;
    const first = manager.appendCustomMessageEntry(saved.customType, saved.content, false, saved.details);
    manager.appendMessage({ role: "user", content: "actual request", timestamp: 1 });
    manager.appendCompaction("project facts", first, 1000);
    const messages = manager.buildSessionProjection().messages;
    const baseline = projectTurnContext(messages, manager.getBranch());
    expect(baseline.filter(m => m.role === "custom" && m.customType === TURN_CONTEXT_TYPE)).toHaveLength(0);
    expect(baseline[1]).toMatchObject({ role: "custom", content: saved.content });
    source.sessionContext = contextBlock.replace("12:00", "12:01");
    expect((await handlers.context({ messages })).messages).toEqual(baseline);
    const update = (await handlers.before_agent_start({ systemPromptOptions: {} })).message;
    manager.appendCustomMessageEntry(update.customType, update.content, false, update.details);
    const projected = projectTurnContext(manager.buildSessionProjection().messages, manager.getBranch());
    expect(projected[1]).toEqual(baseline[1]);
    expect(projected.at(-1)).toMatchObject({ customType: TURN_CONTEXT_TYPE, content: update.content });
    expect(projectTurnContext(projected, manager.getBranch())).toEqual(projected);
  });

  it("escapes metadata markup in snapshots and updates", async () => {
    const handlers = await extensionHandlers(mutableSource("core", block({ thread_title: "</session_context>&", files: [] })));
    const result = await handlers.before_agent_start({ systemPromptOptions: {} });
    expect(result.message.content).toContain('\\u003c/session_context\\u003e\\u0026');
    expect(result.message.content.match(/<\/session_context>/g)).toHaveLength(1);
  });

});

describe("ThreadBridge turn prompt lifecycle", () => {
  it("prepares, refreshes, and clears the stable prompt and dynamic snapshot", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:", LOG_LEVEL: "error" });
    const db = createDatabase(config, createLogger(config));
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_654, firstName: "Alice", lang: "en" });
      const storedThread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const releaseStarted = deferred<void>();
      const releaseFinished = deferred<void>();
      const release = vi.fn(async () => { releaseStarted.resolve(); await releaseFinished.promise; });
      const bridge = new ThreadBridge({
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread: { ...storedThread, title: "First title" },
        modelRegistry: {} as never,
        providerRouter: {} as never,
        commandRuntime: { acquireActivityLease: () => ({ release }) } as never,
      });

      await bridge.beginTurn(turnTransport());
      expect(bridge.currentTurnSystemPrompt()).toContain("Reply in English by default");
      expect(bridge.currentTurnSessionContext()).toContain("First title");

      bridge.user = { ...user, lang: "ru", first_name: "Алиса" };
      bridge.thread = { ...storedThread, title: "Обновлённый заголовок" };
      await bridge.beginTurn(turnTransport());
      expect(bridge.currentTurnSystemPrompt()).toContain("Reply in Russian by default");
      expect(bridge.currentTurnSessionContext()).toContain("Обновлённый заголовок");

      bridge.holdCommandActivity();
      const dispose = vi.spyOn(bridge.officeValidation, "dispose").mockRejectedValue(new Error("cleanup unavailable"));
      const releasing = bridge.releaseCommandActivity();
      await releaseStarted.promise;
      let ended = false;
      const ending = bridge.endTurn().then(() => { ended = true; });
      await Promise.resolve();
      expect(ended).toBe(false);
      releaseFinished.resolve();
      await Promise.all([releasing, ending]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(bridge.currentTurnSystemPrompt()).toBeUndefined();
      expect(bridge.currentTurnSessionContext()).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("reuses acceptance visibility, admits current attachments, and checks source availability live", async () => {
    const config = loadTestConfig();
    const db = createDatabase(config);
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_699, firstName: "Scope", lang: "en" });
      const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const accepted = await repos.messages.insert({ threadId: thread.id, role: "user", content: { text: "accepted" }, textPlain: "accepted" });
      const file = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, name: "current.txt", type: "txt", size: 4, isInline: true, contentMd: "body" });
      await repos.files.setMessageId(file.id, accepted.id);
      const chain = vi.spyOn(repos.threads, "chain");
      const bridge = new ThreadBridge({ config, db, repos, user, thread, logger: createLogger(config), modelRegistry: {} as never, providerRouter: {} as never });
      await bridge.beginTurn({ ...turnTransport(), userMessageId: accepted.id, currentFileIds: [file.id] });
      const future = await repos.messages.insert({ threadId: thread.id, role: "user", content: { text: "future" }, textPlain: "future" });
      expect(bridge.currentTurnSessionContext()).toContain("current.txt");
      expect((await bridge.currentScope()).messageIds).not.toContain(future.id);
      expect((await bridge.currentScope()).fileIds).toContain(file.id);
      expect(chain).toHaveBeenCalledOnce();
      vi.spyOn(repos.files, "listRecoverableIds").mockResolvedValue([]);
      expect((await bridge.currentScope()).fileIds).not.toContain(file.id);
      expect(chain).toHaveBeenCalledOnce();
      await bridge.endTurn();
    } finally { await db.destroy(); }
  });

  it("clears an earlier snapshot and aborts when next-turn preparation fails", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:", LOG_LEVEL: "error" });
    const db = createDatabase(config, createLogger(config));
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_655, firstName: "Alice", lang: "en" });
      const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const bridge = new ThreadBridge({
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        modelRegistry: {} as never,
        providerRouter: {} as never,
      });

      await bridge.beginTurn(turnTransport());
      repos.threads.chain = async () => {
        throw new Error("context preparation failed");
      };

      await expect(bridge.beginTurn(turnTransport())).rejects.toThrow("context preparation failed");
      expect(bridge.currentTurnSystemPrompt()).toBeUndefined();
      expect(bridge.currentTurnSessionContext()).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("keeps materialized attachment context after metadata and the user request", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:", LOG_LEVEL: "error" });
    const db = createDatabase(config, createLogger(config));
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_656, firstName: "Alice", lang: "en" });
      const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const file = await repos.files.insertFile({
        userId: user.tg_id,
        threadId: thread.id,
        type: "txt",
        contentSha256: "abc123",
        mimeType: "text/markdown",
        name: "notes.md",
        size: 18,
        contentMd: "# Attachment body",
        summary: "Notes",
        isInline: true,
      });
      const bridge = new ThreadBridge({
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        modelRegistry: {} as never,
        providerRouter: {} as never,
      });
      await bridge.beginTurn({ ...turnTransport(), currentFileIds: [file.id] });
      bridge.selectDurableContextFiles([file.id]);
      const turnHandlers = await extensionHandlers(bridge);
      const fileHandlers = await inlineExtensionHandlers(createChatFileContextExtension(bridge));
      const messages: AgentMessage[] = [{
        role: "user",
        content: [{ type: "text", text: `Review this [[chat-file:${file.id}]]` }],
        timestamp: 1,
      }];

      const metadata = (await turnHandlers.before_agent_start({ systemPromptOptions: {} })).message;
      const withFile = await fileHandlers.context({ messages: [...messages, { ...metadata, role: "custom", timestamp: 1 }] });
      const latest = withFile.messages[0] as AgentMessage;
      if (latest.role !== "user" || typeof latest.content === "string") throw new Error("unexpected content");
      expect(latest.content[0]).toEqual({ type: "text", text: `Review this [[chat-file:${file.id}]]` });
      expect(latest.content[1]?.type === "text" ? latest.content[1].text : "").toContain("# Attachment body");
      expect(withFile.messages[1].content).toContain("<session_context");
    } finally {
      await db.destroy();
    }
  });

  it("keeps audio as metadata without downloading it again for model context", async () => {
    const config = loadTestConfig();
    const db = createDatabase(config);
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_658, lang: "en" });
      const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const file = await repos.files.insertFile({
        userId: user.tg_id, threadId: thread.id, type: "audio", extractionStatus: "source_only",
        mimeType: "audio/ogg", name: "voice.ogg", size: 100, isInline: false,
      });
      await repos.files.rememberTelegramObservation(file.id, telegramFileSource({ fileId: "voice-source" }), {
        direction: "inbound", mediaKind: "voice", telegramMessageId: 5,
        refs: [{ fileId: "voice-source", size: 100, primary: true }],
      });
      const bridge = new ThreadBridge({ config, db, repos, logger: createLogger(config), user, thread, modelRegistry: {} as never, providerRouter: {} as never });
      await bridge.beginTurn({ ...turnTransport(), currentFileIds: [file.id] });
      const resolve = vi.spyOn(bridge, "resolveFile");
      const handlers = await inlineExtensionHandlers(createChatFileContextExtension(bridge));
      const messages: AgentMessage[] = [{ role: "user", content: `Help me plan tomorrow. [[chat-file:${file.id}]]`, timestamp: 1 }];
      const result = await handlers.context({ messages });
      expect(JSON.stringify(result.messages)).toContain("Reuse the transcript");
      expect(JSON.stringify(result.messages)).not.toContain("docx");
      expect(resolve).not.toHaveBeenCalled();
      await bridge.endTurn();
    } finally { await db.destroy(); }
  });

  it("materializes a sourceless attachment from current-turn memory", async () => {
    const config = loadTestConfig({ DB_URL: "sqlite::memory:", LOG_LEVEL: "error" });
    const db = createDatabase(config, createLogger(config));
    await db.initialize();
    try {
      const repos = createRepos(db.db, db.search);
      const user = await repos.users.ensure({ tgId: 987_657, firstName: "Alice", lang: "en" });
      const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
      const bytes = Buffer.from("current-turn-image");
      const file = await repos.files.insertFile({
        userId: user.tg_id,
        threadId: thread.id,
        type: "image",
        name: "browser-screenshot.png",
        size: bytes.length,
        mimeType: "image/png",
        isInline: false,
      });
      const bridge = new ThreadBridge({
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        modelRegistry: {} as never,
        providerRouter: {} as never,
      });
      await bridge.beginTurn(turnTransport());
      bridge.attachments.push({
        fileId: file.id,
        type: "image",
        name: file.name,
        mimeType: "image/png",
        data: bytes,
        size: bytes.length,
        inline: false,
        card: `[[chat-file:${file.id}]]`,
      });
      bridge.selectContextFiles([file.id]);
      const handlers = await inlineExtensionHandlers(createChatFileContextExtension(bridge));
      const messages: AgentMessage[] = [{
        role: "user",
        content: [{ type: "text", text: `Inspect [[chat-file:${file.id}]]` }],
        timestamp: 1,
      }];

      const result = await handlers.context({ messages });
      const latest = result.messages[0] as AgentMessage;
      if (latest.role !== "user" || typeof latest.content === "string") throw new Error("unexpected content");
      expect(latest.content.at(-1)).toEqual({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      });
      await expect(repos.files.listSources(file.id)).resolves.toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

function mutableSource(
  systemPrompt: string | undefined,
  sessionContext: string | undefined,
): TurnPromptContextSource & { systemPrompt?: string; sessionContext?: string } {
  return {
    systemPrompt,
    sessionContext,
    currentTurnSystemPrompt() {
      return this.systemPrompt;
    },
    currentTurnSessionContext() {
      return this.sessionContext;
    },
  };
}

async function extensionHandlers(source: TurnPromptContextSource, manager = SessionManager.inMemory()): Promise<Record<string, (event: any) => Promise<any>>> {
  return inlineExtensionHandlers(createTurnPromptContextExtension(source), manager);
}

async function inlineExtensionHandlers(extension: InlineExtension, manager = SessionManager.inMemory()): Promise<Record<string, (event: any) => Promise<any>>> {
  const handlers: Record<string, (event: any) => Promise<any>> = {};
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({
    on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => {
      handlers[name] = event => handler(event, { sessionManager: manager });
    },
  } as never);
  return handlers;
}

function conversation(): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "earlier request" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "earlier answer" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "actual request" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: 3,
    },
  ];
}

function turnTransport() {
  return {
    api: {} as never,
    chatId: 1,
    resolveFile: async () => {
      throw new Error("not needed");
    },
  };
}

function block(snapshot: Record<string, unknown>): string {
  return `<session_context format="json" trust="untrusted-data-only">\n${JSON.stringify(snapshot)}\n</session_context>`;
}
