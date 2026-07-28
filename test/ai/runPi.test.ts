import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn, sendFinal } from "../../src/ai/run.js";
import { loadTestConfig, type AppConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import type { PiProviderStreamOverrides } from "../../src/pi/provider.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import {
  applySandboxCommandPreparation,
  runSandboxCommandLifecycle,
} from "../../src/sandbox/lifecycle.js";
import { botThreadWorkspace } from "../../src/sandbox/paths.js";
import type {
  CommandRuntime,
  SandboxCommandLifecycle,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileExportRequest,
} from "../../src/sandbox/types.js";
import { deferred } from "../helpers/async.js";

describe("runTurn with Pi", () => {
  let db: AppDatabase | undefined;
  let manager: PiRuntimeManager | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await manager?.dispose();
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("streams Pi events, persists Telegram rows, and maps both Pi entries", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7001, firstName: "Runner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi run" });
    const stream = ((model: Model<Api>) => textStream(model, "Pi answered the Telegram turn.")) as PiProviderStreamOverrides["openRouter"];
    const embed = vi.fn(async () => [new Float32Array([1, 0])]);
    const commandRuntime = new TestCommandRuntime(async () => successfulCommand());
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      embedder: { model: "test-embed", embed },
      commandRuntime,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const richMessages: unknown[] = [];
    const drafts: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 9001, date: 1, chat: { id: user.tg_id, type: "private", first_name: "Runner" } };
        },
        sendRichMessageDraft: async (payload: unknown) => {
          drafts.push(payload);
          return true;
        },
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "hello persistent Pi",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    });

    const messages = await repos.messages.listThread(thread.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text_plain).toBe("hello persistent Pi");
    expect(messages[0]?.pi_entry_id).toBeTruthy();
    expect(messages[1]?.text_plain).toBe("Pi answered the Telegram turn.");
    expect(messages[1]?.pi_entry_id).toBeTruthy();
    expect(messages[0]?.pi_entry_id).not.toBe(messages[1]?.pi_entry_id);
    expect(drafts.length).toBeGreaterThan(0);
    expect(richMessages).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
    expect(commandRuntime.activityLeaseAcquisitions).toBe(0);
  }, 20_000);

  it("finalizes collapsed thoughts and starts a separate answer draft when final text begins", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-split-final-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir, DRAFT_UPDATE_MS: 0 });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7010, firstName: "SplitFinal", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Split final" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return toolStream(model, {
          type: "toolCall",
          id: "split-final-bash",
          name: "bash",
          arguments: { script: "pwd", cwd: "/", stdin: "", args: [], input_file_ids: [] },
        });
      }
      return textStream(model, "This answer streams separately.");
    }) as PiProviderStreamOverrides["openRouter"];
    const commandRuntime = new TestCommandRuntime(async () => successfulCommand());
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      commandRuntime,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const events: Array<{ kind: "draft" | "message"; payload: Record<string, unknown> }> = [];
    const thinkingStarted = deferred<void>();
    const releaseThinking = deferred<void>();
    let messageId = 9100;
    const api = {
      raw: {
        sendRichMessage: async (payload: Record<string, unknown>) => {
          events.push({ kind: "message", payload });
          if (richMarkdown(payload).includes("<details>")) {
            thinkingStarted.resolve();
            await releaseThinking.promise;
          }
          messageId += 1;
          return { message_id: messageId, date: 1, chat: { id: user.tg_id, type: "private", first_name: "SplitFinal" } };
        },
        sendRichMessageDraft: async (payload: Record<string, unknown>) => {
          events.push({ kind: "draft", payload });
          return true;
        },
      },
    } as unknown as import("grammy").Api;

    const turn = runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "Run a check and answer.",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key, params) => {
        if (key === "thinking-placeholder") return "Thinking...";
        if (key === "thinking-summary-running") return `Thinking for ${params?.time}`;
        if (key === "thinking-summary-final") return `Thought for ${params?.time}`;
        if (key === "thinking-final-tool-calls") return `Tool calls: ${params?.count}`;
        if (key === "thinking-final-tools") return "Tools:";
        return key;
      },
    });
    await thinkingStarted.promise;
    expect(events.some((event) =>
      event.kind === "draft" && richMarkdown(event.payload).includes("This answer streams separately."))).toBe(false);
    releaseThinking.resolve();
    await turn;

    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(2);
    expect(richMarkdown(messages[0]!.payload)).toContain("<details>");
    expect(richMarkdown(messages[0]!.payload)).toContain("Thought for ");
    expect(richMarkdown(messages[0]!.payload)).not.toContain("This answer streams separately.");
    expect(richMarkdown(messages[1]!.payload)).toBe("This answer streams separately.");
    expect(richMarkdown(messages[1]!.payload)).not.toContain("<details>");

    const answerDraftIndex = events.findIndex((event) =>
      event.kind === "draft" && richMarkdown(event.payload).includes("This answer streams separately."));
    const thinkingMessageIndex = events.findIndex((event) =>
      event.kind === "message" && richMarkdown(event.payload).includes("<details>"));
    expect(thinkingMessageIndex).toBeGreaterThanOrEqual(0);
    expect(answerDraftIndex).toBeGreaterThan(thinkingMessageIndex);
    const thinkingDraft = events.find((event) => event.kind === "draft" && !richMarkdown(event.payload).includes("This answer streams separately."));
    const answerDraft = events[answerDraftIndex];
    expect(answerDraft?.payload.draft_id).not.toBe(thinkingDraft?.payload.draft_id);
    expect(richMarkdown(answerDraft!.payload)).not.toContain("Thought for ");
    expect(richMarkdown(answerDraft!.payload)).not.toContain("<details>");
  }, 20_000);

  it("refreshes finalized thoughts when a later tool call resumes reasoning", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-refresh-thinking-"));
    const config = loadTestConfig({ PI_CODING_AGENT_DIR: tempDir, DRAFT_UPDATE_MS: 0 });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7011, firstName: "RefreshThinking", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Refresh thinking" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return toolStream(model, {
          type: "toolCall",
          id: "refresh-first-bash",
          name: "bash",
          arguments: { script: "pwd", cwd: "/", stdin: "", args: [], input_file_ids: [] },
        });
      }
      if (providerCalls === 2) {
        return textThenToolStream(model, "I need one more check.", {
          type: "toolCall",
          id: "refresh-second-bash",
          name: "bash",
          arguments: { script: "ls", cwd: "/", stdin: "", args: [], input_file_ids: [] },
        });
      }
      return textStream(model, "The final checked answer.");
    }) as PiProviderStreamOverrides["openRouter"];
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      commandRuntime: new TestCommandRuntime(async () => successfulCommand()),
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    const events: Array<{ kind: "draft" | "edit" | "message"; payload: Record<string, unknown> }> = [];
    let messageId = 9200;
    const api = {
      raw: {
        sendRichMessage: async (payload: Record<string, unknown>) => {
          events.push({ kind: "message", payload });
          messageId += 1;
          return { message_id: messageId, date: 1, chat: { id: user.tg_id, type: "private", first_name: "RefreshThinking" } };
        },
        editMessageText: async (payload: Record<string, unknown>) => {
          events.push({ kind: "edit", payload });
          return true;
        },
        sendRichMessageDraft: async (payload: Record<string, unknown>) => {
          events.push({ kind: "draft", payload });
          return true;
        },
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "Check twice, then answer.",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key, params) => {
        if (key === "thinking-placeholder") return "Thinking...";
        if (key === "thinking-summary-running") return `Thinking for ${params?.time}`;
        if (key === "thinking-summary-final") return `Thought for ${params?.time}`;
        if (key === "thinking-final-tool-calls") return `Tool calls: ${params?.count}`;
        if (key === "thinking-final-tools") return "Tools:";
        return key;
      },
    });

    expect(providerCalls).toBe(3);
    const sentThinking = events.find((event) =>
      event.kind === "message" && richMarkdown(event.payload).includes("<details>"));
    const editedThinking = events.find((event) => event.kind === "edit");
    expect(richMarkdown(sentThinking!.payload)).toContain("Tool calls: 1");
    expect(richMarkdown(editedThinking!.payload)).toContain("Tool calls: 2");
    expect(events.filter((event) =>
      event.kind === "message" && richMarkdown(event.payload).includes("<details>"))).toHaveLength(1);
    expect(events.some((event) =>
      event.kind === "message" && richMarkdown(event.payload) === "The final checked answer.")).toBe(true);
    const messages = await repos.messages.listThread(thread.id);
    expect(messages.at(-1)?.thinking).toContain("Tool calls: 2");
  }, 20_000);

  it("reports Pi setup failures through the normal Telegram error boundary", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7002, firstName: "NoPi", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Missing Pi" });
    const richMessages: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richMessages.push(payload);
          return { message_id: 9002, date: 1, chat: { id: user.tg_id, type: "private", first_name: "NoPi" } };
        },
        sendRichMessageDraft: async () => true,
      },
    } as unknown as import("grammy").Api;

    await expect(runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "this setup must fail safely",
      t: (key) => key,
    })).resolves.toBeUndefined();

    expect(richMessages).toHaveLength(1);
    expect(JSON.stringify(richMessages[0])).toContain("Pi runtime is not configured");
  });

  it("lets Pi create and deliver a ZIP archive through bash and create_file", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-zip-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      MANAGED_FILE_ROOT: path.join(tempDir, "managed-files"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7006, firstName: "ZipRunner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi ZIP run" });
    let providerCalls = 0;
    const stream = ((model: Model<Api>) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return toolStream(model, {
          type: "toolCall",
          id: "zip-bash-call",
          name: "bash",
          arguments: {
            script: "mkdir -p zip-smoke/nested; printf alpha > zip-smoke/alpha.txt; printf beta > zip-smoke/nested/beta.txt; zip -rq zip-smoke.zip zip-smoke",
            cwd: "/",
            stdin: "",
            args: [],
            input_file_ids: [],
          },
        });
      }
      if (providerCalls === 2) {
        return toolStream(model, {
          type: "toolCall",
          id: "zip-create-file-call",
          name: "create_file",
          arguments: { path: "/zip-smoke.zip", name: "zip-smoke.zip", delivery: "document" },
        });
      }
      return textStream(model, "ZIP_TOOL_SMOKE_OK");
    }) as PiProviderStreamOverrides["openRouter"];
    const workspace = botThreadWorkspace(config, user.tg_id, thread.id);
    const commandRuntime = new TestCommandRuntime(async () => {
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "zip-smoke.zip"), zipSync({
        "zip-smoke/": new Uint8Array(),
        "zip-smoke/alpha.txt": Buffer.from("alpha"),
        "zip-smoke/nested/": new Uint8Array(),
        "zip-smoke/nested/beta.txt": Buffer.from("beta"),
      }));
      return successfulCommand();
    }, async (request) => {
      const destination = request.hostDestination;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(workspace, "zip-smoke.zip"), destination);
    });
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      commandRuntime,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    let documentCalls = 0;
    const api = {
      raw: {
        sendRichMessage: async () => ({
          message_id: 9040,
          date: 1,
          chat: { id: user.tg_id, type: "private", first_name: "ZipRunner" },
        }),
        sendRichMessageDraft: async () => true,
      },
      sendDocument: async () => {
        documentCalls += 1;
        return {
          message_id: 9041,
          document: { file_id: "BQAC-zip-smoke", file_unique_id: "unique-zip-smoke" },
        };
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "Create two files, archive them as ZIP with bash, and send the archive.",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key) => key,
    });

    expect(providerCalls).toBe(3);
    expect(commandRuntime.activityLeaseAcquisitions).toBe(1);
    expect(commandRuntime.activityLeaseReleases).toBe(1);
    expect(commandRuntime.activeActivityLeases).toBe(0);
    const runtime = await manager.runtime(thread, user);
    const toolResults = runtime.session.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => message.content);
    expect(runtime.bridge.attachments, JSON.stringify(toolResults)).toHaveLength(1);
    expect(documentCalls).toBe(1);
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "zip-smoke.zip", type: "other" });
    const archive = await fs.readFile(files[0]!.path!);
    const zipped = unzipSync(archive);
    expect(Object.keys(zipped).sort()).toEqual([
      "zip-smoke/",
      "zip-smoke/alpha.txt",
      "zip-smoke/nested/",
      "zip-smoke/nested/beta.txt",
    ]);
    expect(Buffer.from(zipped["zip-smoke/alpha.txt"]!).toString()).toBe("alpha");
    expect(Buffer.from(zipped["zip-smoke/nested/beta.txt"]!).toString()).toBe("beta");
    await expect(repos.files.listSources(files[0]!.id)).resolves.toMatchObject([{
      transport: "telegram",
      remote_key: "unique-zip-smoke",
    }]);
    const messages = await repos.messages.listThread(thread.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text_plain: "ZIP_TOOL_SMOKE_OK" });
  }, 20_000);

  it("preserves an image MIME type when Telegram receives it as a document", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-document-image-"));
    const config = loadTestConfig({ MANAGED_FILE_ROOT: path.join(tempDir, "managed-files") });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7004, firstName: "DocumentImage", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Document image" });
    const bytes = Buffer.from("png-original-bytes");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      mimeType: "image/png",
      name: "original.png",
      path: null,
      size: bytes.length,
      isInline: false,
    });
    const api = {
      raw: {
        sendRichMessage: async () => ({
          message_id: 9020,
          date: 1,
          chat: { id: user.tg_id, type: "private", first_name: "DocumentImage" },
        }),
      },
      sendDocument: async () => ({
        message_id: 9021,
        document: { file_id: "BQAC-original-png", file_unique_id: "unique-original-png" },
      }),
    } as unknown as import("grammy").Api;

    await sendFinal({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "",
      t: (key) => key,
    }, "", "Here is the original image.", 0, [{
      fileId: file.id,
      type: "image",
      name: file.name,
      mimeType: "image/png",
      data: bytes,
      size: bytes.length,
      inline: false,
      card: "original image",
      delivery: "document",
      origin: "created_file",
    }]);

    const [source] = await repos.files.listSources(file.id);
    expect(source).toMatchObject({ mime_type: "image/png", remote_key: "unique-original-png" });
    expect(JSON.parse(source!.locator_json)).toMatchObject({ file_id: "BQAC-original-png" });
  });

  it("sends 25 photos in Telegram-sized galleries with captions only on each first photo", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7025, firstName: "GalleryRunner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Gallery run" });
    const bytes = Buffer.from("photo-bytes");
    const attachments = [];
    for (let index = 0; index < 25; index += 1) {
      const file = await repos.files.insertFile({
        userId: user.tg_id,
        threadId: thread.id,
        type: "image",
        mimeType: "image/jpeg",
        name: `photo-${index + 1}.jpg`,
        path: null,
        size: bytes.length,
        isInline: false,
      });
      attachments.push({
        fileId: file.id,
        type: "image" as const,
        name: file.name,
        mimeType: "image/jpeg",
        data: bytes,
        size: bytes.length,
        caption: `Credit ${index + 1} <artist>`,
        inline: false,
        card: `photo ${index + 1}`,
        delivery: "photo" as const,
        origin: "created_file" as const,
      });
    }
    const galleries: Array<Array<Record<string, unknown>>> = [];
    let messageId = 9300;
    const api = {
      raw: {
        sendRichMessage: async () => ({
          message_id: 9299,
          date: 1,
          chat: { id: user.tg_id, type: "private", first_name: "GalleryRunner" },
        }),
      },
      sendMediaGroup: async (_chatId: number, media: Array<Record<string, unknown>>) => {
        galleries.push(media);
        return media.map(() => {
          messageId += 1;
          return {
            message_id: messageId,
            photo: [{
              file_id: `AgAC-gallery-${messageId}`,
              file_unique_id: `unique-gallery-${messageId}`,
              width: 10,
              height: 10,
            }],
          };
        });
      },
    } as unknown as import("grammy").Api;

    await sendFinal({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "",
      t: (key) => key,
    }, "", "Here are the photos.", 0, attachments);

    expect(galleries.map((gallery) => gallery.length)).toEqual([10, 10, 5]);
    for (const gallery of galleries) {
      expect(gallery[0]).toMatchObject({ parse_mode: "HTML" });
      expect(gallery[0]?.caption).toContain("<blockquote>Photo 1: Credit");
      expect(gallery[0]?.caption).toContain("&lt;artist&gt;");
      expect(gallery.slice(1).every((photo) => photo.caption === undefined)).toBe(true);
    }
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(25);
    const messages = await repos.messages.listThread(thread.id);
    const content = JSON.parse(messages.at(-1)!.content_json) as { files?: unknown[] };
    expect(content.files).toHaveLength(25);
  });

  it("rebalances 11 files into two valid media groups instead of leaving a singleton", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7026, firstName: "BatchRunner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Batch run" });
    const bytes = Buffer.from("document-bytes");
    const attachments = [];
    for (let index = 0; index < 11; index += 1) {
      const file = await repos.files.insertFile({
        userId: user.tg_id,
        threadId: thread.id,
        type: "other",
        name: `file-${index + 1}.txt`,
        path: null,
        size: bytes.length,
        isInline: false,
      });
      attachments.push({
        fileId: file.id,
        type: "other" as const,
        name: file.name,
        data: bytes,
        size: bytes.length,
        inline: false,
        card: `file ${index + 1}`,
        delivery: "document" as const,
        origin: "created_file" as const,
      });
    }
    const groupSizes: number[] = [];
    let messageId = 9400;
    const api = {
      raw: {
        sendRichMessage: async () => ({
          message_id: 9399,
          date: 1,
          chat: { id: user.tg_id, type: "private", first_name: "BatchRunner" },
        }),
      },
      sendMediaGroup: async (_chatId: number, media: unknown[]) => {
        groupSizes.push(media.length);
        return media.map(() => ({
          message_id: ++messageId,
          document: {
            file_id: `BQAC-batch-${messageId}`,
            file_unique_id: `unique-batch-${messageId}`,
          },
        }));
      },
    } as unknown as import("grammy").Api;

    await sendFinal({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "",
      t: (key) => key,
    }, "", "Here are the files.", 0, attachments);

    expect(groupSizes).toEqual([9, 2]);
  });

  it("removes an undelivered attachment that has no durable path or transport source", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7005, firstName: "FailedDelivery", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Failed delivery" });
    const bytes = Buffer.from("turn-local-only");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "other",
      name: "undelivered.bin",
      path: null,
      size: bytes.length,
      isInline: false,
    });
    const api = {
      raw: {
        sendRichMessage: async () => ({
          message_id: 9030,
          date: 1,
          chat: { id: user.tg_id, type: "private", first_name: "FailedDelivery" },
        }),
      },
      sendDocument: async () => { throw new Error("Telegram delivery failed"); },
    } as unknown as import("grammy").Api;

    await sendFinal({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "",
      t: (key) => key,
    }, "", "The attachment could not be delivered.", 0, [{
      fileId: file.id,
      type: "other",
      name: file.name,
      data: bytes,
      size: bytes.length,
      inline: false,
      card: "undelivered attachment",
      delivery: "document",
      origin: "created_file",
    }]);

    await expect(repos.files.get(file.id)).resolves.toBeUndefined();
  });

  it("sends a terminal generated image before final text and stores its Telegram file id once", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-pi-image-"));
    const config = loadTestConfig({
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      MANAGED_FILE_ROOT: path.join(tempDir, "managed-files"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7003, firstName: "ImageRunner", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pi image run" });
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
        : textStream(model, "unexpected follow-up");
    }) as PiProviderStreamOverrides["openRouter"];
    manager = new PiRuntimeManager({
      config,
      db,
      repos,
      logger,
      providerStreams: { openRouter: stream, codex: stream as PiProviderStreamOverrides["codex"] },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ b64_json: Buffer.from("generated-image-bytes").toString("base64"), media_type: "image/png" }],
    })));
    const events: string[] = [];
    let photoCalls = 0;
    const api = {
      raw: {
        sendRichMessage: async () => {
          events.push("final-text");
          return { message_id: 9010, date: 1, chat: { id: user.tg_id, type: "private", first_name: "ImageRunner" } };
        },
        sendRichMessageDraft: async () => {
          events.push("draft");
          return true;
        },
      },
      sendPhoto: async () => {
        photoCalls += 1;
        events.push("photo");
        return {
          message_id: 9011,
          photo: [{ file_id: "AgAC-sent-image", file_unique_id: "unique-sent-image", width: 10, height: 10, file_size: 21 }],
        };
      },
    } as unknown as import("grammy").Api;

    await runTurn({
      api,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger,
      user,
      thread,
      text: "generate a red square",
      pi: manager,
      resolveFile: async (file) => resolvedFile(Buffer.from("unused"), file.id),
      t: (key) => key === "image-generated-done" || key === "image-generated-ready"
        ? "Done — the image is ready."
        : key,
    });

    expect(providerCalls).toBe(1);
    expect(photoCalls).toBe(1);
    expect(events.indexOf("photo")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("photo")).toBeLessThan(events.indexOf("final-text"));
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      type: "image",
    });
    expect(files[0]?.path).toBe(path.join(config.MANAGED_FILE_ROOT, String(files[0]?.id), "content"));
    const sources = await repos.files.listSources(files[0]!.id);
    expect(sources).toMatchObject([{
      transport: "telegram",
      connection_key: "default",
      remote_key: "unique-sent-image",
    }]);
    expect(JSON.parse(sources[0]!.locator_json)).toMatchObject({ file_id: "AgAC-sent-image" });
    const messages = await repos.messages.listThread(thread.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
  }, 20_000);
});

function textStream(model: Model<Api>, text: string) {
  const stream = createAssistantMessageEventStream();
  const empty = assistant(model, "");
  stream.push({ type: "start", partial: empty });
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant(model, text) });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant(model, text) });
  stream.push({ type: "done", reason: "stop", message: assistant(model, text) });
  return stream;
}

function textThenToolStream(model: Model<Api>, text: string, toolCall: ToolCall) {
  const stream = createAssistantMessageEventStream();
  const start = assistant(model, "");
  const textMessage = assistant(model, text);
  const message: AssistantMessage = {
    ...textMessage,
    content: [...textMessage.content, toolCall],
    stopReason: "toolUse",
  };
  stream.push({ type: "start", partial: start });
  stream.push({ type: "text_start", contentIndex: 0, partial: start });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: textMessage });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: textMessage });
  stream.push({
    type: "toolcall_start",
    contentIndex: 1,
    partial: { ...textMessage, content: [...textMessage.content, { ...toolCall, arguments: {} }] },
  });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 1,
    delta: JSON.stringify(toolCall.arguments),
    partial: { ...textMessage, content: [...textMessage.content, { ...toolCall, arguments: {} }] },
  });
  stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
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

function resolvedFile(bytes: Buffer, fileId: number) {
  return {
    path: "",
    bytes,
    mimeType: null,
    size: bytes.length,
    contentSha256: "test-hash",
    expiresAt: Number.POSITIVE_INFINITY,
    source: { transport: "test", connectionKey: "default", remoteKey: String(fileId), locator: {} },
  };
}

function richMarkdown(payload: Record<string, unknown>): string {
  return ((payload.rich_message as { markdown?: string } | undefined)?.markdown) ?? "";
}

class TestCommandRuntime implements CommandRuntime {
  readonly requests: SandboxCommandRequest[] = [];
  activityLeaseAcquisitions = 0;
  activityLeaseReleases = 0;
  activeActivityLeases = 0;

  constructor(
    private readonly handler: (request: SandboxCommandRequest) => Promise<SandboxCommandResult>,
    private readonly exporter: (request: SandboxFileExportRequest) => Promise<void> = async () => {
      throw new Error("export not configured");
    },
  ) {}

  acquireActivityLease() {
    this.activityLeaseAcquisitions += 1;
    this.activeActivityLeases += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activityLeaseReleases += 1;
        this.activeActivityLeases -= 1;
      },
    };
  }

  async execute(
    request: SandboxCommandRequest,
    lifecycle?: SandboxCommandLifecycle,
  ): Promise<SandboxCommandResult> {
    return runSandboxCommandLifecycle(lifecycle, (preparation) => {
      const preparedRequest = applySandboxCommandPreparation(request, preparation);
      this.requests.push(preparedRequest);
      return this.handler(preparedRequest);
    });
  }

  exportFile(request: SandboxFileExportRequest): Promise<void> {
    return this.exporter(request);
  }

  async reconcile(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function successfulCommand(): SandboxCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
