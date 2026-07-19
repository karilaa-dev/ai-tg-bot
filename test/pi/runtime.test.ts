import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import type { PiProviderStreamOverrides } from "../../src/pi/provider.js";

describe("PiRuntimeManager", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists, reopens, maps, and forks text-only Pi sessions", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9123, firstName: "PiTest", lang: "en" });
    const parent = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Parent" });
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const image = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: parent.id,
      type: "image",
      name: "telegram.png",
      path: null,
      size: imageBytes.length,
      mimeType: "image/png",
      summary: "a Telegram image marker",
      isInline: true,
    });
    let providerImageCount = 0;
    const streams = echoStreams((context) => {
      providerImageCount = context.messages.flatMap((message) =>
        message.role === "user" && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image")
          : []).length;
    });

    const firstManager = new PiRuntimeManager({ config, db, repos, logger, providerStreams: streams });
    const first = await firstManager.runtime(parent, user);
    expect(first.session.model?.contextWindow).toBe(config.MODEL_CONTEXT_TOKENS);
    expect(first.session.settingsManager.getCompactionSettings().enabled).toBe(true);
    let telegramDownloads = 0;
    first.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      currentFileIds: [image.id],
      resolveFile: async (file) => {
        telegramDownloads += 1;
        expect(file.id).toBe(image.id);
        return resolvedFile(imageBytes, "image/png", image.id);
      },
    });
    await first.session.prompt(`persist this marker [[chat-file:${image.id}]]`, { expandPromptTemplates: false, source: "extension" });
    const appended = first.session.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "message" ? [{ id: entry.id, role: entry.message.role }] : []);

    expect(appended.some((entry) => entry.role === "user")).toBe(true);
    expect(appended.some((entry) => entry.role === "assistant")).toBe(true);
    expect(providerImageCount).toBe(1);
    const bash = first.session.getToolDefinition("bash")!;
    const bashResult = await bash.execute("mounted-image", {
      script: `wc -c /attachments/${image.id}`,
      input_file_ids: [image.id],
    }, undefined, undefined, {} as never);
    expect(bashResult.details).toMatchObject({ exit_code: 0, input_files: [{ file_id: image.id }] });
    expect(telegramDownloads).toBe(1);
    const storedParent = await repos.threads.get(parent.id);
    expect(storedParent?.pi_session_file).toBeTruthy();
    const sessionText = await fs.readFile(storedParent!.pi_session_file!, "utf8");
    expect(sessionText).toContain("persist this marker");
    expect(sessionText).not.toContain("data:image/");
    expect(sessionText).not.toContain(imageBytes.toString("base64"));
    expect(sessionText).not.toMatch(/[A-Za-z0-9+/]{500,}={0,2}/);
    await firstManager.dispose();

    const secondManager = new PiRuntimeManager({ config, db, repos, logger, providerStreams: streams });
    const reopened = await secondManager.runtime(storedParent!, user);
    expect(userText(reopened.session.messages)).toContain("persist this marker");

    const child = await repos.threads.create({
      userId: user.tg_id,
      topicId: 99,
      title: "Child",
      parentThreadId: parent.id,
      forkPointMessageId: null,
    });
    await secondManager.fork(storedParent!, child, user, reopened.session.sessionManager.getLeafId());
    const storedChild = await repos.threads.get(child.id);
    expect(storedChild?.pi_session_file).toBeTruthy();
    const childRuntime = await secondManager.runtime(storedChild!, user);
    let historicalLoads = 0;
    childRuntime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => {
        historicalLoads += 1;
        return resolvedFile(Buffer.from("unused"), null, -1);
      },
    });
    expect(userText(childRuntime.session.messages)).toContain("persist this marker");
    providerImageCount = 0;
    await childRuntime.session.prompt("child-only marker", { expandPromptTemplates: false, source: "extension" });
    expect(historicalLoads).toBe(0);
    expect(providerImageCount).toBe(0);
    expect(userText(childRuntime.session.messages)).toContain("child-only marker");
    expect(userText(reopened.session.messages)).not.toContain("child-only marker");
    await secondManager.dispose();
  }, 20_000);

  it("continues the Pi loop after executing a project-scoped tool", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-tools-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9124, firstName: "ToolTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Tools" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>, context: Context) => {
      providerCalls += 1;
      const hasToolResult = context.messages.some((message) => message.role === "toolResult");
      return hasToolResult
        ? successStream(model, "Tool loop complete")
        : toolStream(model, { type: "toolCall", id: "bash-call", name: "bash", arguments: { script: "echo pi-tool-ok" } });
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => resolvedFile(Buffer.from("unused"), null, -1),
    });

    await runtime.session.prompt("run the bash tool", { expandPromptTemplates: false, source: "extension" });

    expect(providerCalls).toBe(2);
    const toolResult = runtime.session.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.role === "toolResult" ? toolResult.content[0] : undefined).toMatchObject({ type: "text" });
    expect(toolResult?.role === "toolResult" ? toolResult.content[0]?.type === "text" && toolResult.content[0].text : "")
      .toContain("pi-tool-ok");
    expect(runtime.session.messages.at(-1)?.role).toBe("assistant");
    expect(userText(runtime.session.messages)).toContain("run the bash tool");
    await manager.dispose();
  }, 20_000);

  it("verifies and materializes an inline remote document only in live provider context", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-inline-file-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9129, firstName: "InlineFile", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Inline file" });
    const bytes = Buffer.from("portable extracted document bytes");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      contentSha256: "test-hash",
      mimeType: "text/plain",
      name: "portable.txt",
      path: null,
      size: bytes.length,
      contentMd: "portable extracted document text",
      summary: "portable extracted document text",
      isInline: true,
    });
    let liveText = "";
    const stream = ((model: Model<Api>, context: Context) => {
      liveText = context.messages.flatMap((entry) => entry.role === "user" && Array.isArray(entry.content)
        ? entry.content.filter((part) => part.type === "text").map((part) => part.text)
        : []).join("\n");
      return successStream(model, "Document inspected");
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    let remoteLoads = 0;
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      currentFileIds: [file.id],
      resolveFile: async () => {
        remoteLoads += 1;
        return resolvedFile(bytes, "text/plain", file.id);
      },
    });

    await runtime.session.prompt(`inspect [[chat-file:${file.id}]]`, { expandPromptTemplates: false, source: "extension" });

    expect(remoteLoads).toBe(1);
    expect(liveText).toContain('<attachment id="');
    expect(liveText).toContain("portable extracted document text");
    const sessionText = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(sessionText).not.toContain("portable extracted document text");
    expect(sessionText).not.toContain(bytes.toString("base64"));
    await manager.dispose();
  }, 20_000);

  it("uses durable extracted document text when the remote source is unavailable", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-durable-file-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9130, firstName: "DurableFile", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Durable file" });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      contentSha256: "durable-hash",
      mimeType: "text/plain",
      name: "durable.txt",
      path: null,
      size: 20,
      contentMd: "durable extracted text remains available",
      summary: "durable extracted text",
      isInline: true,
    });
    let liveText = "";
    const stream = ((model: Model<Api>, context: Context) => {
      liveText = context.messages.flatMap((entry) => entry.role === "user" && Array.isArray(entry.content)
        ? entry.content.filter((part) => part.type === "text").map((part) => part.text)
        : []).join("\n");
      return successStream(model, "Durable document inspected");
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    let remoteLoads = 0;
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      currentFileIds: [file.id],
      resolveFile: async () => {
        remoteLoads += 1;
        throw new Error("Telegram is unavailable");
      },
    });

    await runtime.session.prompt(`inspect [[chat-file:${file.id}]]`, { expandPromptTemplates: false, source: "extension" });

    expect(remoteLoads).toBe(1);
    expect(liveText).toContain("durable extracted text remains available");
    expect(liveText).not.toContain("currently unavailable from its chat source");
    await manager.dispose();
  }, 20_000);

  it("does not inject stale extracted content when a changed document refresh fails", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-refresh-failure-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir, FILE_INLINE_TOKENS: 1 });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9131, firstName: "RefreshFailure", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Refresh failure" });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      contentSha256: "old-hash",
      mimeType: "text/plain",
      name: "changing.txt",
      path: null,
      size: 10,
      contentMd: "stale extracted content",
      summary: "stale summary",
      isInline: true,
    });
    let liveText = "";
    const stream = ((model: Model<Api>, context: Context) => {
      liveText = context.messages.flatMap((entry) => entry.role === "user" && Array.isArray(entry.content)
        ? entry.content.filter((part) => part.type === "text").map((part) => part.text)
        : []).join("\n");
      return successStream(model, "Refresh failure handled");
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      embedder: { embed: async () => { throw new Error("embedding unavailable"); } },
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    const changedBytes = Buffer.from("# Changed\n\n" + "new content ".repeat(300));
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      currentFileIds: [file.id],
      resolveFile: async () => resolvedFile(changedBytes, "text/plain", file.id),
    });

    await runtime.session.prompt(`inspect [[chat-file:${file.id}]]`, { expandPromptTemplates: false, source: "extension" });

    expect(liveText).toContain(`Attachment #${file.id} could not be refreshed`);
    expect(liveText).not.toContain("stale extracted content");
    await expect(repos.files.get(file.id)).resolves.toMatchObject({
      content_sha256: "old-hash",
      extraction_status: "ready",
      content_md: "stale extracted content",
    });
    await manager.dispose();
  }, 20_000);

  it("rehydrates a compacted-away image when load_message restores its marker", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-reload-file-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9128, firstName: "ReloadTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Reload attachment" });
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "an older image" },
      textPlain: "an older image",
    });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const image = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      contentSha256: "test-hash",
      mimeType: "image/png",
      name: "older.png",
      path: null,
      size: bytes.length,
      summary: "an older image",
      isInline: true,
    });
    await repos.files.attachToMessage(message.id, image.id);
    let providerCalls = 0;
    let rehydratedImages = 0;
    const stream = ((model: Model<Api>, context: Context) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return toolStream(model, {
          type: "toolCall",
          id: "load-old-message",
          name: "load_message",
          arguments: { message_id: message.id, file_ids: [image.id] },
        });
      }
      rehydratedImages = context.messages.flatMap((entry) =>
        entry.role === "toolResult" ? entry.content.filter((part) => part.type === "image") : []).length;
      return successStream(model, "Older image loaded");
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    let remoteLoads = 0;
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async (file) => {
        remoteLoads += 1;
        expect(file.id).toBe(image.id);
        return resolvedFile(bytes, "image/png", image.id);
      },
    });

    const loadMessage = runtime.session.getToolDefinition("load_message")!;
    const metadataOnly = await loadMessage.execute("metadata-only", {
      message_id: message.id,
    }, undefined, undefined, {} as never);
    expect(metadataOnly.details).toMatchObject({ materialized_file_ids: [] });
    expect(remoteLoads).toBe(0);

    await runtime.session.prompt("Load that old image", { expandPromptTemplates: false, source: "extension" });

    expect(providerCalls).toBe(2);
    expect(rehydratedImages).toBe(1);
    expect(remoteLoads).toBe(1);
    const toolResult = runtime.session.messages.find((entry) => entry.role === "toolResult");
    expect(toolResult?.role === "toolResult" && toolResult.content[0]?.type === "text"
      ? toolResult.content[0].text
      : "").toContain(`[[chat-file:${image.id}]]`);
    const sessionText = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(sessionText).not.toContain(bytes.toString("base64"));
    await manager.dispose();
  }, 20_000);

  it("terminates after successful image generation without a follow-up provider call", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-terminal-image-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9127, firstName: "ImageTool", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Terminal image" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>) => {
      providerCalls += 1;
      return providerCalls === 1
        ? toolStream(model, {
            type: "toolCall",
            id: "generate-call",
            name: "generate_image",
            arguments: { prompt: "a red square", output_format: "png" },
          })
        : successStream(model, "unexpected follow-up");
    }) as PiProviderStreamOverrides["openRouter"];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ b64_json: Buffer.from("generated-image").toString("base64"), media_type: "image/png" }],
    })));
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => resolvedFile(Buffer.from("unused"), null, -1),
    });

    await runtime.session.prompt("generate the image", { expandPromptTemplates: false, source: "extension" });

    expect(providerCalls).toBe(1);
    expect(runtime.bridge.attachments).toHaveLength(1);
    expect(runtime.bridge.attachments[0]).toMatchObject({ origin: "generated_image", data: Buffer.from("generated-image") });
    const sessionText = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(sessionText).not.toContain(Buffer.from("generated-image").toString("base64"));
    await manager.dispose();
  }, 20_000);

  it("cancels an active Pi provider turn", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-abort-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9125, firstName: "AbortTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Abort" });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const stream = ((model: Model<Api>, _context: Context, options?: { signal?: AbortSignal }) => {
      const events = createAssistantMessageEventStream();
      events.push({ type: "start", partial: assistant(model, "") });
      options?.signal?.addEventListener("abort", () => {
        events.push({
          type: "error",
          reason: "aborted",
          error: { ...assistant(model, ""), stopReason: "aborted", errorMessage: "operation aborted" },
        });
      }, { once: true });
      markStarted?.();
      return events;
    }) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => resolvedFile(Buffer.from("unused"), null, -1),
    });
    const prompt = runtime.session.prompt("start a cancellable turn", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await started;
    expect(await manager.abort(thread.id)).toBe(true);
    await prompt;

    const assistants = runtime.session.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-1)?.stopReason).toBe("aborted");
    await manager.dispose();
  }, 20_000);

  it("uses Pi's built-in manual compaction and persists its entry", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-pi-compact-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9126, firstName: "CompactTest", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Compact" });
    const stream = ((model: Model<Api>, context: Context) => successStream(
      model,
      /summari/i.test(context.systemPrompt ?? "") ? "Pi manual compact summary" : "acknowledged",
    )) as PiProviderStreamOverrides["openRouter"];
    const manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const runtime = await manager.runtime(thread, user);
    runtime.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
    runtime.bridge.beginTurn({
      api: {} as never,
      chatId: user.tg_id,
      resolveFile: async () => resolvedFile(Buffer.from("unused"), null, -1),
    });
    await runtime.session.prompt(`durable-start ${"context ".repeat(100)} durable-end`, {
      expandPromptTemplates: false,
      source: "extension",
    });

    await manager.compact((await repos.threads.get(thread.id))!, user);

    const entries = runtime.session.sessionManager.getEntries();
    const compaction = entries.find((entry) => entry.type === "compaction");
    expect(compaction?.type === "compaction" ? compaction.summary : "").toContain("Pi manual compact summary");
    const sessionText = await fs.readFile(runtime.session.sessionFile!, "utf8");
    expect(sessionText).toContain('"type":"compaction"');
    await manager.dispose();
  }, 20_000);
});

function echoStreams(onContext?: (context: Context) => void): PiProviderStreamOverrides {
  const stream = ((model: Model<Api>, context: Context) => {
    onContext?.(context);
    const latest = [...context.messages].reverse().find((message) => message.role === "user");
    const input = latest?.role !== "user"
      ? ""
      : typeof latest.content === "string"
        ? latest.content
        : latest.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    return successStream(model, `Echo: ${input}`);
  }) as PiProviderStreamOverrides["openRouter"];
  return { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] };
}

function successStream(model: Model<Api>, text: string) {
  const stream = createAssistantMessageEventStream();
  const empty = assistant(model, "");
  stream.push({ type: "start", partial: empty });
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant(model, text) });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant(model, text) });
  stream.push({ type: "done", reason: "stop", message: assistant(model, text) });
  return stream;
}

function toolStream(model: Model<Api>, toolCall: ToolCall) {
  const stream = createAssistantMessageEventStream();
  const start = assistant(model, "");
  const message: AssistantMessage = { ...start, content: [toolCall], stopReason: "toolUse" };
  stream.push({ type: "start", partial: start });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...start, content: [{ ...toolCall, arguments: {} }] } });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(toolCall.arguments),
    partial: { ...start, content: [{ ...toolCall, arguments: {} }] },
  });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  return stream;
}

function assistant(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function userText(messages: AgentMessage[]): string {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string") return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
      ? [String((part as { text?: unknown }).text ?? "")]
      : []);
  }).join("\n");
}

function resolvedFile(bytes: Buffer, mimeType: string | null, fileId: number) {
  return {
    path: "",
    bytes,
    mimeType,
    size: bytes.length,
    contentSha256: "test-hash",
    expiresAt: Number.POSITIVE_INFINITY,
    source: { transport: "test", connectionKey: "default", remoteKey: String(fileId), locator: {} },
  };
}
