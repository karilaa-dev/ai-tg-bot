import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { isContextLengthError, runTurn, sendFinal } from "../../src/ai/run.js";
import {
  setCodexTransportFactoryForTests,
  type CodexTransport,
  type JsonRpcMessage,
} from "../../src/ai/codexAppServer.js";

describe("runTurn", () => {
  let db: AppDatabase;
  let repos: Repos;
  let codexParts: unknown[];
  let tempDirs: string[];

  beforeEach(async () => {
    codexParts = [];
    tempDirs = [];
    setCodexTransportFactoryForTests(() => new ScriptedCodexTransport(codexParts));
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    setCodexTransportFactoryForTests(undefined);
    vi.useRealTimers();
    await db.destroy();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("does not duplicate an already persisted latest user message on retry", async () => {
    const config = loadTestConfig({ CONTEXT_WARN_RATIO: 0.000001 });
    const user = await repos.users.ensure({ tgId: 99, firstName: "Retry", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const api = {
      sendMessage: async () => ({ message_id: 1 }),
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "same saved turn",
      t: (key) => key,
    });
    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "same saved turn",
      t: (key) => key,
    });

    const rows = await repos.messages.listThread(thread.id);
    expect(rows.filter((row) => row.role === "user" && row.text_plain === "same saved turn")).toHaveLength(1);
  }, 30_000);

  it("does not duplicate a user message when retrying after an empty assistant row", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 96, firstName: "EmptyRetry", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "retry after empty" },
      textPlain: "retry after empty",
    });
    await repos.messages.insert({
      threadId: thread.id,
      role: "assistant",
      content: { text: "" },
      textPlain: "",
      thinking: "tool work",
    });
    codexParts = [{ type: "text-delta", text: "Recovered answer." }];
    const api = {
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 1, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      raw: {
        sendRichMessage: async () => ({ message_id: 2, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "retry after empty",
      t: testT,
    });

    const rows = await repos.messages.listThread(thread.id);
    expect(rows.filter((row) => row.role === "user" && row.text_plain === "retry after empty")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ role: "assistant", text_plain: "Recovered answer." });
  });

  it("persists user message embeddings on over-budget turns when an embedder is provided", async () => {
    const config = loadTestConfig({ CONTEXT_WARN_RATIO: 0.000001 });
    const user = await repos.users.ensure({ tgId: 98, firstName: "Embed", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const api = {
      sendMessage: async () => ({ message_id: 1 }),
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "embed this user turn",
      embedder: fakeEmbedder(),
      t: (key) => key,
    });

    const latest = await repos.messages.latest(thread.id);
    const embeddings = await repos.embeddings.list("message", [latest!.id]);
    expect(embeddings[0]?.decoded[0]).toBe("embed this user turn".length);
  });

  it("sends and persists a localized notice when the model returns no final answer", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 95, firstName: "EmptyFinal", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "chapter-notes.txt",
      path: "data/files/chapter-notes.txt",
      size: 12,
      summary: "chapter notes",
      isInline: false,
    });
    codexParts = [
      { type: "tool-call", toolName: "search_in_file", input: { file_id: file.id, query: "chapter 5" } },
      { type: "tool-result", toolName: "search_in_file", output: { results: [] } },
    ];
    const richPayloads: unknown[] = [];
    const api = {
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 1, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 2, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "summarize chapter 5",
      t: testT,
    });

    expect(JSON.stringify(richPayloads)).toContain("No final answer returned.");
    expect(JSON.stringify(richPayloads)).toContain("Tool calls: 1");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "⚠️ No final answer returned." });
    expect(latest?.thinking).toContain("Tool calls: 1");
    expect(latest?.thinking).toContain("- 📄 Searching file: 1");
    expect(latest?.thinking).not.toContain("<code>chapter-notes.txt</code>");
    expect(latest?.thinking).not.toContain("0 results");
  });

  it("edits a regular HTML status message with readable tool subjects when streaming is off", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 97, firstName: "Status", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      { type: "tool-call", toolName: "web_search", input: { query: "alpha" } },
      { type: "tool-result", toolName: "web_search", output: { results: [{}, {}, {}, {}, {}] } },
      { type: "tool-call", toolName: "web_search", input: { query: "beta" } },
      { type: "tool-result", toolName: "web_search", output: { results: [{}, {}] } },
      { type: "text-delta", text: "Final answer." },
    ];
    const sentMessages: Array<{ text: string; other?: Record<string, unknown> }> = [];
    const editedMessages: Array<{ text: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async (_chatId: number, text: string, other?: Record<string, unknown>) => {
        sentMessages.push({ text, other });
        return { message_id: 10, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string, other?: Record<string, unknown>) => {
        editedMessages.push({ text, other });
        return { message_id: 10, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
      sendChatAction: async () => true,
      raw: {
        sendRichMessage: async () => ({ message_id: 20, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "use search",
      t: testT,
    });

    const sentTexts = sentMessages.map((message) => message.text);
    const editedTexts = editedMessages.map((message) => message.text);
    expect(sentTexts).toEqual(["💭 Thinking..."]);
    expect(sentMessages[0]?.other?.parse_mode).toBe("HTML");
    expect(editedMessages.every((message) => message.other?.parse_mode === "HTML")).toBe(true);
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎 Searching web <code>alpha</code>");
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎 Searching web <code>alpha</code> (5 results)");
    expect(editedTexts).toContain([
      "💭 Thinking...",
      "",
      "🔎 Searching web <code>alpha</code> (5 results)",
      "🔎 Searching web <code>beta</code>",
    ].join("\n"));
    expect(editedTexts).toContain([
      "💭 Thinking...",
      "",
      "🔎 Searching web <code>alpha</code> (5 results)",
      "🔎 Searching web <code>beta</code> (2 results)",
    ].join("\n"));
    expect(editedTexts.at(-1)).toBe([
      "✅ Done.",
      "",
      "🔎 Searching web <code>alpha</code> (5 results)",
      "🔎 Searching web <code>beta</code> (2 results)",
    ].join("\n"));
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Final answer." });
    expect(latest?.thinking).toContain("Tool calls: 2");
    expect(latest?.thinking).toContain("- 🔎 Searching web: 2");
    expect(latest?.thinking).not.toContain("🔎 Searching web <code>alpha</code>");
    expect(latest?.thinking).not.toContain("🔎 Searching web <code>beta</code>");
    expect(latest?.thinking).not.toContain("x2");
    expect(latest?.thinking).not.toContain("↳");
    expect(latest?.thinking).not.toContain("web_search");
  });

  it("sends an immediate thinking draft and streams raw partial text before the final rich message", async () => {
    const config = loadTestConfig({ DRAFT_UPDATE_MS: 0 });
    const user = await repos.users.ensure({ tgId: 94, firstName: "Stream", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    codexParts = [{ type: "text-delta", text: "First partial" }];
    const events: string[] = [];
    const draftPayloads: unknown[] = [];
    const api = {
      raw: {
        sendRichMessageDraft: async (payload: unknown) => {
          draftPayloads.push(payload);
          events.push(`draft:${richMarkdownOf(payload)}`);
          return true;
        },
        sendRichMessage: async (payload: unknown) => {
          events.push(`final:${richMarkdownOf(payload)}`);
          return { message_id: 30, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "stream answer",
      t: testT,
    });

    expect(draftPayloads).toHaveLength(2);
    expect(richMarkdownOf(draftPayloads[0])).toBe("💭 Thinking...");
    expect(richMarkdownOf(draftPayloads[0])).not.toContain("<details>");
    expect(richMarkdownOf(draftPayloads[0])).not.toContain("First partial");
    expect(richMarkdownOf(draftPayloads[1])).toContain("First partial");
    expect(events.at(-1)?.startsWith("final:")).toBe(true);
    expect(events.findIndex((event) => event.startsWith("final:"))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith("draft:")),
    );
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "First partial" });
  });

  it("streams full reasoning drafts and compacts final reasoning to titles", async () => {
    const config = loadTestConfig({ DRAFT_UPDATE_MS: 0, REASONING_SUMMARY: "detailed" });
    const user = await repos.users.ensure({ tgId: 109, firstName: "CompactDraft", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    codexParts = [
      {
        type: "reasoning-delta",
        text: [
          "Evaluating technical options",
          "I need to figure out the best way to perform an explicit internet search.",
          "",
          "Planning file creation for Pi calculation",
          "Since I am responding within Telegram, I will use available tools.",
        ].join("\n"),
      },
      {
        type: "reasoning-delta",
        text: [
          "",
          "",
          "Considering pi verification process",
          "I need to use a combined bash command to create both source files.",
        ].join("\n"),
      },
      {
        type: "reasoning-delta",
        text: [
          "",
          "",
          "Evaluating pi digit sources",
          "For an exact machine comparison of pi digits, I should fetch a reliable reference.",
        ].join("\n"),
      },
      { type: "text-delta", text: "Answer after compact reasoning." },
    ];
    const draftPayloads: string[] = [];
    const api = {
      raw: {
        sendRichMessageDraft: async (payload: unknown) => {
          draftPayloads.push(richMarkdownOf(payload));
          return true;
        },
        sendRichMessage: async () => ({ message_id: 32, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "stream long reasoning",
      t: testT,
    });

    const reasoningDraft = draftPayloads.find((markdown) => markdown.includes("Evaluating pi digit sources"));
    expect(reasoningDraft).toBeDefined();
    expect(reasoningDraft!).toContain("Considering pi verification process");
    expect(reasoningDraft!).toContain("Evaluating pi digit sources");
    expect(reasoningDraft!).toContain("explicit internet search");
    expect(reasoningDraft!).toContain("Planning file creation");
    expect(reasoningDraft!).toContain("combined bash command");
    expect(reasoningDraft!).not.toContain("\n\n...");
    const latest = await repos.messages.latest(thread.id);
    expect(latest?.thinking).toContain("Reasoning blocks: 3");
    expect(latest?.thinking).toContain("Evaluating technical options");
    expect(latest?.thinking).toContain("Considering pi verification process");
    expect(latest?.thinking).toContain("Evaluating pi digit sources");
    expect(latest?.thinking).not.toContain("explicit internet search");
    expect(latest?.thinking).not.toContain("Planning file creation");
    expect(latest?.thinking).not.toContain("combined bash command");
    expect(latest?.thinking).not.toContain("reliable reference");
  });

  it("persists the completed Codex agentMessage instead of provisional streamed text after tools", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 104, firstName: "CompletedFinal", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const finalAnswer = "JS, Python, and curl verification all matched the first 100 Pi digits.";
    codexParts = [
      { type: "text-delta", text: "I will calculate this first, then verify it." },
      { type: "tool-call", toolName: "bash", input: { script: "node -e 'console.log(Math.PI)'" } },
      { type: "tool-result", toolName: "bash", output: { stderr: "this sandbox uses js-exec instead of node", exit_code: 1, timed_out: false } },
      {
        type: "tool-call",
        toolName: "bash",
        input: { script: "js-exec -c 'console.log(42)'; python3 -c 'print(42)'; curl -fsSL http://93.184.216.34/api/pi | jq -r .digits" },
      },
      { type: "tool-result", toolName: "bash", output: { stdout: "{\"equal\":true,\"digits\":100}\n", exit_code: 0, timed_out: false } },
      { type: "text-final", text: finalAnswer },
    ];
    const richPayloads: unknown[] = [];
    const api = {
      sendMessage: async () => ({ message_id: 41, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 41, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 42, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "calculate pi with tools",
      t: testT,
    });

    expect(JSON.stringify(richPayloads)).toContain(finalAnswer);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: finalAnswer });
    expect(latest?.text_plain).not.toContain("I will calculate this first");
    expect(latest?.thinking).toContain("Tool calls: 2");
    expect(latest?.thinking).not.toContain("I will calculate this first, then verify it.");
    expect(latest?.thinking).toContain("- 🐚 Running bash: 2");
    expect(latest?.thinking).not.toContain("node -e");
    expect(latest?.thinking).not.toContain("python3");
    expect(latest?.thinking).not.toContain("(exit 0)");
  });

  it("sends and links files created by the create_file dynamic tool", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-create-file-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 105, firstName: "FileFinal", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "answer.txt"), "generated file body");
    codexParts = [
      { type: "server-tool-call", toolName: "create_file", input: { path: "/answer.txt", caption: "Generated file" } },
      { type: "text-final", text: "I made the file." },
    ];
    const events: string[] = [];
    const documents: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 61, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 61, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async (_chatId: number, document: { filename?: string }, other?: Record<string, unknown>) => {
        events.push("document");
        documents.push({ filename: document.filename, other });
        return {
          message_id: 63,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          document: { file_id: "telegram-created-file-id", file_unique_id: "telegram-created-file-unique" },
        };
      },
      sendMediaGroup: async () => {
        throw new Error("single file should not use sendMediaGroup");
      },
      raw: {
        sendRichMessage: async () => {
          events.push("rich");
          return { message_id: 62, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "make a file",
      t: testT,
    });

    expect(events).toEqual(["rich", "document"]);
    expect(documents).toEqual([{ filename: "answer.txt", other: { message_thread_id: undefined, caption: "Generated file" } }]);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "I made the file." });
    expect(latest?.thinking).toContain("Tool calls: 1");
    expect(latest?.thinking).toContain("- 📎 Creating file: 1");
    expect(latest?.thinking).toContain("Files sent: 1");
    expect(latest?.thinking).toContain("<code>answer.txt</code>");
    expect(latest?.thinking).not.toContain("<code>/answer.txt</code>");
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({
      name: "answer.txt",
      type: "txt",
      telegram_file_id: "telegram-created-file-id",
      telegram_file_unique_id: "telegram-created-file-unique",
    });
  });

  it("sends image files created by create_file as Telegram photos by default", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-create-image-photo-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 116, firstName: "ImageFilePhoto", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "preview.png"), pngBytes());
    codexParts = [
      { type: "server-tool-call", toolName: "create_file", input: { path: "/preview.png", caption: "Preview image" } },
      { type: "text-final", text: "I made the image file." },
    ];
    const events: string[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 64, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 64, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async () => {
        throw new Error("default image create_file delivery should use sendPhoto");
      },
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        events.push("photo");
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 66,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "created-photo-id", file_unique_id: "created-photo-unique", width: 1024, height: 1024 }],
        };
      },
      raw: {
        sendRichMessage: async () => {
          events.push("rich");
          return { message_id: 65, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "make an image file",
      t: testT,
    });

    expect(events).toEqual(["rich", "photo"]);
    expect(photoCalls).toEqual([{ filename: "preview.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "I made the image file." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      name: "preview.png",
      type: "image",
      telegram_file_id: "created-photo-id",
      telegram_file_unique_id: "created-photo-unique",
    });
  });

  it("sends image files created by create_file as uncompressed documents when requested", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-create-image-document-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 117, firstName: "ImageFileDocument", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "source.png"), pngBytes());
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "create_file",
        input: { path: "/source.png", caption: "Exact source image", delivery: "document" },
      },
      { type: "text-final", text: "I made the exact image file." },
    ];
    const events: string[] = [];
    const documents: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 67, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 67, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async (_chatId: number, document: { filename?: string }, other?: Record<string, unknown>) => {
        events.push("document");
        documents.push({ filename: document.filename, other });
        return {
          message_id: 69,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          document: { file_id: "created-document-id", file_unique_id: "created-document-unique" },
        };
      },
      sendPhoto: async () => {
        throw new Error("explicit document delivery should not use sendPhoto");
      },
      raw: {
        sendRichMessage: async () => {
          events.push("rich");
          return { message_id: 68, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "make an exact image file",
      t: testT,
    });

    expect(events).toEqual(["rich", "document"]);
    expect(documents).toEqual([{ filename: "source.png", other: { message_thread_id: undefined, caption: "Exact source image" } }]);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "I made the exact image file." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      name: "source.png",
      type: "image",
      telegram_file_id: "created-document-id",
      telegram_file_unique_id: "created-document-unique",
    });
  });

  it("sends generated images as separate captionless Telegram photos and preserves model text", async () => {
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 110, firstName: "ImageFinal", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple blue square", caption: "Blue square" },
      },
      { type: "text-final", text: "Here is the image." },
    ];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 101, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 101, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async () => {
        throw new Error("generated images should not be sent as documents");
      },
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 103,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [
            { file_id: "small-photo-id", file_unique_id: "small-photo-unique", width: 90, height: 90, file_size: 100 },
            { file_id: "large-photo-id", file_unique_id: "large-photo-unique", width: 1024, height: 1024, file_size: 2000 },
          ],
        };
      },
      sendMediaGroup: async () => {
        throw new Error("single generated image should not use sendMediaGroup");
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 102, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate an image",
      imageGenerator: async ({ prompt, model, quality, size, mode, references }) => {
        expect(prompt).toBe("draw a simple blue square");
        expect(model).toBe("gpt-image-2");
        expect(quality).toBe("low");
        expect(size).toBe("1024x1024");
        expect(mode).toBe("auto");
        expect(references).toEqual([]);
        return {
          imageBase64: imageBytes.toString("base64"),
          revisedPrompt: "A simple blue square.",
          mediaType: "image/png",
        };
      },
      t: testT,
    });

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("Here is the image.");
    expect(richMarkdownOf(richPayloads[0])).not.toContain("![");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Here is the image." });
    expect(latest?.thinking).toContain("Tool calls: 1");
    expect(latest?.thinking).toContain("- 🖼️ Generating image: 1");
    expect(latest?.thinking).toContain("Files sent: 1");
    expect(latest?.thinking).toContain("<code>generated-image.png</code>");
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({
      name: "generated-image.png",
      type: "image",
      telegram_file_id: "large-photo-id",
      telegram_file_unique_id: "large-photo-unique",
      summary: "A simple blue square.",
    });
    await expect(fs.readFile(attached[0]!.path)).resolves.toEqual(imageBytes);
  });

  it("acknowledges generated-image tool calls before slow image generation finishes", async () => {
    let transport: ScriptedCodexTransport | undefined;
    setCodexTransportFactoryForTests(() => {
      transport = new ScriptedCodexTransport(codexParts);
      return transport;
    });
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 118, firstName: "ImageAsync", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple purple square", caption: "Purple square" },
      },
      { type: "text-final", text: "Here is the follow-up image." },
    ];
    let resolveImage!: (value: { imageBase64: string; revisedPrompt: string; mediaType: string }) => void;
    const imagePromise = new Promise<{ imageBase64: string; revisedPrompt: string; mediaType: string }>((resolve) => {
      resolveImage = resolve;
    });
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 112, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 112, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 114,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "purple-photo-id", file_unique_id: "purple-photo-unique", width: 1024, height: 1024 }],
        };
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 113, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    const runPromise = runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate a follow-up image",
      imageGenerator: async () => imagePromise,
      t: testT,
    });

    await waitUntil(() => Boolean(transport?.sent.some((message) => (
      message.id === 1001
      && JSON.stringify(message.result).includes("pending")
    ))));
    expect(richPayloads).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);

    resolveImage({
      imageBase64: imageBytes.toString("base64"),
      revisedPrompt: "A simple purple square.",
      mediaType: "image/png",
    });
    await runPromise;

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("Here is the follow-up image.");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Here is the follow-up image." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      telegram_file_id: "purple-photo-id",
      telegram_file_unique_id: "purple-photo-unique",
    });
  });

  it("hides generated-image final text from streaming drafts until the image is ready", async () => {
    let transport: ScriptedCodexTransport | undefined;
    setCodexTransportFactoryForTests(() => {
      transport = new ScriptedCodexTransport(codexParts);
      return transport;
    });
    const imageBytes = pngBytes();
    const config = loadTestConfig({ DRAFT_UPDATE_MS: 0 });
    const user = await repos.users.ensure({ tgId: 120, firstName: "ImageDraft", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw Hatsune Miku", caption: "Hatsune Miku" },
      },
      { type: "text-final", text: "Done — generated Hatsune Miku." },
    ];
    let resolveImage!: (value: { imageBase64: string; revisedPrompt: string; mediaType: string }) => void;
    const imagePromise = new Promise<{ imageBase64: string; revisedPrompt: string; mediaType: string }>((resolve) => {
      resolveImage = resolve;
    });
    const draftPayloads: string[] = [];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 123,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "miku-photo-id", file_unique_id: "miku-photo-unique", width: 1024, height: 1536 }],
        };
      },
      raw: {
        sendRichMessageDraft: async (payload: unknown) => {
          draftPayloads.push(richMarkdownOf(payload));
          return true;
        },
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 122, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    const runPromise = runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "generate Hatsune Miku image",
      imageGenerator: async () => imagePromise,
      t: testT,
    });

    await waitUntil(() => Boolean(transport?.sent.some((message) => (
      message.id === 1001
      && JSON.stringify(message.result).includes("pending")
    ))));
    await delay(20);

    const latestDraft = draftPayloads.at(-1) ?? "";
    expect(latestDraft).toContain("🖼️ Generating image for");
    expect(latestDraft).toContain("🖼️ Generating image");
    expect(latestDraft).not.toContain("Done — generated Hatsune Miku.");
    expect(richPayloads).toHaveLength(0);
    expect(photoCalls).toHaveLength(0);

    resolveImage({
      imageBase64: imageBytes.toString("base64"),
      revisedPrompt: "Generated Hatsune Miku.",
      mediaType: "image/png",
    });
    await runPromise;

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("Done — generated Hatsune Miku.");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Done — generated Hatsune Miku." });
  });

  it("sends Done before a generated image when the model returns no final text", async () => {
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 115, firstName: "ImageDone", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple yellow square", caption: "Yellow square" },
      },
      { type: "text-final", text: "" },
    ];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 109, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 109, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async () => {
        throw new Error("generated images should not be sent as documents");
      },
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 111,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "yellow-photo-id", file_unique_id: "yellow-photo-unique", width: 1024, height: 1024 }],
        };
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 110, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate an image",
      imageGenerator: async () => ({
        imageBase64: imageBytes.toString("base64"),
        revisedPrompt: "A simple yellow square.",
        mediaType: "image/png",
      }),
      t: testT,
    });

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("Done — the image is ready.");
    expect(richMarkdownOf(richPayloads[0])).not.toContain("![");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      telegram_file_id: "yellow-photo-id",
      telegram_file_unique_id: "yellow-photo-unique",
    });
  });

  it("sends meaningful generated-image text separately while keeping the photo captionless", async () => {
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 114, firstName: "ImageText", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple green square", caption: "Green square" },
      },
      { type: "text-final", text: "I used a flat green fill with a thin border." },
    ];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 106, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 106, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 108,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "green-photo-id", file_unique_id: "green-photo-unique", width: 1024, height: 1024 }],
        };
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 107, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate an image and describe it",
      imageGenerator: async () => ({
        imageBase64: imageBytes.toString("base64"),
        revisedPrompt: "A simple green square.",
        mediaType: "image/png",
      }),
      t: testT,
    });

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("I used a flat green fill with a thin border.");
    expect(richMarkdownOf(richPayloads[0])).not.toContain("![");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "I used a flat green fill with a thin border." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      telegram_file_id: "green-photo-id",
      telegram_file_unique_id: "green-photo-unique",
    });
  });

  it("demotes generated-image tool usage text into final thinking instead of the visible answer", async () => {
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 121, firstName: "ImageToolText", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const toolUsageText = "Using imagegen to edit the existing image and change only her hair to red.";
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "change only her hair to red", caption: "Edited hair color" },
      },
      { type: "text-final", text: toolUsageText },
    ];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 124, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 124, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 126,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "tool-text-photo-id", file_unique_id: "tool-text-photo-unique", width: 1024, height: 1536 }],
        };
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 125, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "change her hair to red",
      imageGenerator: async () => ({
        imageBase64: imageBytes.toString("base64"),
        revisedPrompt: "Only her hair was changed to red.",
        mediaType: "image/png",
      }),
      t: testT,
    });

    expect(richPayloads).toHaveLength(1);
    const markdown = richMarkdownOf(richPayloads[0]);
    expect(markdown).toContain(`- ${toolUsageText}`);
    expect(markdown).toContain("Done — the image is ready.");
    const answerAfterThinking = markdown.slice(markdown.indexOf("</details>") + "</details>".length);
    expect(answerAfterThinking).toContain("Done — the image is ready.");
    expect(answerAfterThinking).not.toContain(toolUsageText);
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
    expect(latest?.thinking).toContain(toolUsageText);
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      telegram_file_id: "tool-text-photo-id",
      telegram_file_unique_id: "tool-text-photo-unique",
    });
  });

  it("replaces stale in-progress generated-image text after the photo is ready", async () => {
    const imageBytes = pngBytes();
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 119, firstName: "ImageReady", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple orange square", caption: "Orange square" },
      },
      { type: "text-final", text: "Done — generating the image now." },
    ];
    const richPayloads: unknown[] = [];
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 116, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 116, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        return {
          message_id: 118,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "orange-photo-id", file_unique_id: "orange-photo-unique", width: 1024, height: 1024 }],
        };
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 117, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate an image",
      imageGenerator: async () => ({
        imageBase64: imageBytes.toString("base64"),
        revisedPrompt: "A simple orange square.",
        mediaType: "image/png",
      }),
      t: testT,
    });

    expect(richPayloads).toHaveLength(1);
    const markdown = richMarkdownOf(richPayloads[0]);
    expect(markdown).toContain("Done — the image is ready.");
    expect(markdown).not.toContain("Done — generating the image now.");
    expect(markdown).not.toContain("![");
    expect(photoCalls).toEqual([{ filename: "generated-image.png", other: { message_thread_id: undefined } }]);
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached[0]).toMatchObject({
      telegram_file_id: "orange-photo-id",
      telegram_file_unique_id: "orange-photo-unique",
    });
  });

  it("does not persist a fake Done answer when image generation produces no attachment", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 113, firstName: "ImageFailure", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    codexParts = [
      {
        type: "server-tool-call",
        toolName: "generate_image",
        input: { prompt: "draw a simple blue square", caption: "Blue square" },
      },
      { type: "text-final", text: "Done." },
    ];
    const richPayloads: unknown[] = [];
    let imageGeneratorCalled = false;
    const api = {
      sendMessage: async () => ({ message_id: 104, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 104, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendPhoto: async () => {
        throw new Error("failed generated images must not be sent as photos");
      },
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 105, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "generate an image",
      imageGenerator: async () => {
        imageGeneratorCalled = true;
        return { imageBase64: "", mediaType: "image/png" };
      },
      t: testT,
    });

    expect(imageGeneratorCalled).toBe(true);
    expect(richPayloads).toHaveLength(1);
    const markdown = richMarkdownOf(richPayloads[0]);
    expect(markdown).toContain("⚠️ Something went wrong.");
    expect(markdown).toContain("no base64 image data");
    expect(markdown).not.toContain("Done.");
    const latest = await repos.messages.latest(thread.id);
    expect(latest?.role).toBe("assistant");
    expect(latest?.text_plain).toContain("⚠️ Something went wrong.");
    expect(latest?.text_plain).toContain("no base64 image data");
    expect(latest?.text_plain).not.toBe("Done.");
    await expect(repos.files.listForMessage(latest!.id)).resolves.toEqual([]);
  });

  it("sends multiple files created by create_file as one Telegram media group", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-create-files-group-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 107, firstName: "FileGroupFinal", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "first.txt"), "first generated file");
    await fs.writeFile(path.join(threadRoot, "second.txt"), "second generated file");
    codexParts = [
      { type: "server-tool-call", toolName: "create_file", input: { path: "/first.txt", caption: "First caption" } },
      { type: "server-tool-call", toolName: "create_file", input: { path: "/second.txt", caption: "Second caption" } },
      { type: "text-final", text: "I made the files." },
    ];
    const events: string[] = [];
    const mediaGroups: Array<{
      media: Array<{ type?: string; filename?: string; caption?: string }>;
      other?: Record<string, unknown>;
    }> = [];
    const api = {
      sendMessage: async () => ({ message_id: 81, date: 1, chat: { id: user.tg_id, type: "private" } }),
      editMessageText: async () => ({ message_id: 81, date: 1, chat: { id: user.tg_id, type: "private" } }),
      sendChatAction: async () => true,
      sendDocument: async () => {
        throw new Error("multiple files should use sendMediaGroup");
      },
      sendMediaGroup: async (_chatId: number, media: Array<Record<string, unknown>>, other?: Record<string, unknown>) => {
        events.push("media-group");
        mediaGroups.push({
          media: media.map((item) => ({
            type: item.type as string | undefined,
            filename: (item.media as { filename?: string } | undefined)?.filename,
            caption: item.caption as string | undefined,
          })),
          other,
        });
        return media.map((_item, index) => ({
          message_id: 83 + index,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          document: { file_id: `telegram-group-file-${index + 1}`, file_unique_id: `telegram-group-unique-${index + 1}` },
        }));
      },
      raw: {
        sendRichMessage: async () => {
          events.push("rich");
          return { message_id: 82, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    await runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user: streamOffUser,
      thread,
      text: "make files",
      t: testT,
    });

    expect(events).toEqual(["rich", "media-group"]);
    expect(mediaGroups).toEqual([{
      media: [
        { type: "document", filename: "first.txt", caption: "First caption" },
        { type: "document", filename: "second.txt", caption: "Second caption" },
      ],
      other: { message_thread_id: undefined },
    }]);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "I made the files." });
    expect(latest?.thinking).toContain("Tool calls: 2");
    expect(latest?.thinking).toContain("- 📎 Creating file: 2");
    expect(latest?.thinking).toContain("Files sent: 2");
    expect(latest?.thinking).toContain("<code>first.txt</code>, <code>second.txt</code>");
    const attached = await repos.files.listForMessage(latest!.id);
    expect(attached).toHaveLength(2);
    expect(attached[0]).toMatchObject({
      name: "first.txt",
      type: "txt",
      telegram_file_id: "telegram-group-file-1",
      telegram_file_unique_id: "telegram-group-unique-1",
    });
    expect(attached[1]).toMatchObject({
      name: "second.txt",
      type: "txt",
      telegram_file_id: "telegram-group-file-2",
      telegram_file_unique_id: "telegram-group-unique-2",
    });
  });

  it("keeps the streaming draft alive during quiet provider pauses without tool calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const config = loadTestConfig({ DRAFT_UPDATE_MS: 0 });
    const user = await repos.users.ensure({ tgId: 95, firstName: "Keepalive", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    codexParts = [{ type: "delay", ms: 21_000 }, { type: "text-delta", text: "After quiet wait." }];
    const draftPayloads: string[] = [];
    let resolveFirstDraft: () => void = () => {};
    const firstDraft = new Promise<void>((resolve) => {
      resolveFirstDraft = resolve;
    });
    const api = {
      raw: {
        sendRichMessageDraft: async (payload: unknown) => {
          draftPayloads.push(richMarkdownOf(payload));
          if (draftPayloads.length === 1) resolveFirstDraft();
          return true;
        },
        sendRichMessage: async () => ({ message_id: 31, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
    };

    const turn = runTurn({
      api: api as never,
      chatId: user.tg_id,
      config,
      db,
      repos,
      logger: createLogger(config),
      user,
      thread,
      text: "wait before answer",
      t: testT,
    });
    let completed = false;
    try {
      await firstDraft;
      expect(draftPayloads).toHaveLength(1);
      expect(draftPayloads[0]).toBe("💭 Thinking...");

      await vi.advanceTimersByTimeAsync(20_000);
      expect(draftPayloads.length).toBeGreaterThanOrEqual(2);
      expect(draftPayloads[1]).toBe("💭 Thinking...");
      expect(draftPayloads.every((markdown) => !markdown.includes("After quiet wait."))).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await turn;
      completed = true;
      expect(draftPayloads.some((markdown) => markdown.includes("After quiet wait."))).toBe(true);
    } finally {
      if (!completed) {
        await vi.advanceTimersByTimeAsync(21_000);
        await turn.catch(() => undefined);
      }
    }
  });

  it("repairs and retries rich markdown parse errors before persisting", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 100, firstName: "Repair", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    let rawCalls = 0;
    const api = {
      raw: {
        sendRichMessage: async () => {
          rawCalls += 1;
          if (rawCalls === 1) throw parseError();
          return { message_id: 22, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
      sendMessage: async () => {
        throw new Error("plain fallback should not be used");
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        embedder: fakeEmbedder(),
        t: (key) => key,
      },
      "",
      "<unknown>tag</unknown>",
    );

    expect(rawCalls).toBe(2);
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", tg_message_id: 22 });
    const embeddings = await repos.embeddings.list("message", [latest!.id]);
    expect(embeddings[0]?.decoded[0]).toBe("<unknown>tag</unknown>".length);
  });

  it("falls back to chunked plain sendMessage if every rich repair variant fails", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 101, firstName: "Plain", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const plainTexts: string[] = [];
    const api = {
      raw: {
        sendRichMessage: async () => {
          throw parseError();
        },
      },
      sendMessage: async (_chatId: number, text: string) => {
        plainTexts.push(text);
        return { message_id: 30 + plainTexts.length, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
    };
    const answer = `Start ${"x".repeat(5000)} end`;

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: (key) => key,
      },
      "",
      answer,
    );

    expect(plainTexts.length).toBeGreaterThan(1);
    expect(plainTexts.every((text) => text.length <= 4096)).toBe(true);
    expect(plainTexts.join("")).toContain("Start");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", tg_message_id: 31 });
  });

  it("retries rich final sends without message_thread_id when Telegram rejects the topic", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 102, firstName: "Thread", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, 42, "Topic 42");
    const payloads: Array<Record<string, unknown>> = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: Record<string, unknown>) => {
          payloads.push(payload);
          if (payload.message_thread_id === 42) throw threadError();
          return { message_id: 44, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
      sendMessage: async () => {
        throw new Error("plain fallback should not be used");
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        messageThreadId: 42,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: (key) => key,
      },
      "",
      "thread answer",
    );

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.message_thread_id).toBe(42);
    expect(payloads[1]?.message_thread_id).toBeUndefined();
    expect(JSON.stringify(payloads[1]?.rich_message)).toContain("Topic 42");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", tg_message_id: 44 });
  });

  it("retries plain fallback sends without message_thread_id when Telegram rejects the topic", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 103, firstName: "PlainThread", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, 42, "Topic 42");
    const plainCalls: Array<{ text: string; other?: Record<string, unknown> }> = [];
    const api = {
      raw: {
        sendRichMessage: async () => {
          throw parseError();
        },
      },
      sendMessage: async (_chatId: number, text: string, other?: Record<string, unknown>) => {
        plainCalls.push({ text, other });
        if (other?.message_thread_id === 42) throw threadError();
        return { message_id: 55, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        messageThreadId: 42,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: (key) => key,
      },
      "",
      "plain fallback answer",
    );

    expect(plainCalls).toHaveLength(2);
    expect(plainCalls[0]?.other?.message_thread_id).toBe(42);
    expect(plainCalls[1]?.other?.message_thread_id).toBeUndefined();
    expect(plainCalls[1]?.text).toContain("[Topic 42]");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", tg_message_id: 55 });
  });

  it("retries outbound document sends without message_thread_id when Telegram rejects the topic", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 106, firstName: "DocThread", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, 42, "Topic 42");
    const filePath = path.join(os.tmpdir(), `ai-tg-bot-doc-thread-${Date.now()}.txt`);
    tempDirs.push(filePath);
    await fs.writeFile(filePath, "document content");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "topic-file.txt",
      path: filePath,
      size: "document content".length,
      contentMd: "document content",
      summary: "document content",
      isInline: true,
    });
    const documentCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const api = {
      raw: {
        sendRichMessage: async () => ({ message_id: 70, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
      sendDocument: async (_chatId: number, document: { filename?: string }, other?: Record<string, unknown>) => {
        documentCalls.push({ filename: document.filename, other });
        if (other?.message_thread_id === 42) throw threadError();
        return {
          message_id: 71,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          document: { file_id: "topic-doc-file-id", file_unique_id: "topic-doc-unique-id" },
        };
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        messageThreadId: 42,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: (key) => key,
      },
      "",
      "answer with document",
      0,
      [{
        fileId: file.id,
        type: "txt",
        name: file.name,
        path: file.path,
        size: file.size,
        caption: "Document caption",
        inline: true,
        card: "document content",
      }],
    );

    expect(documentCalls).toHaveLength(2);
    expect(documentCalls[0]).toMatchObject({ filename: "topic-file.txt", other: { message_thread_id: 42, caption: "Document caption" } });
    expect(documentCalls[1]?.other?.message_thread_id).toBeUndefined();
    expect(documentCalls[1]?.other?.caption).toContain("[Topic 42]");
    const latest = await repos.messages.latest(thread.id);
    expect(await repos.files.listForMessage(latest!.id)).toMatchObject([{ id: file.id }]);
    await expect(repos.files.get(file.id)).resolves.toMatchObject({
      telegram_file_id: "topic-doc-file-id",
      telegram_file_unique_id: "topic-doc-unique-id",
    });
  });

  it("retries generated image photo sends without message_thread_id and without captions when Telegram rejects the topic", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 111, firstName: "PhotoThread", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, 42, "Topic 42");
    const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-photo-thread-"));
    tempDirs.push(fileDir);
    const filePath = path.join(fileDir, "topic-image.png");
    await fs.writeFile(filePath, pngBytes());
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      name: "topic-image.png",
      path: filePath,
      size: pngBytes().length,
      summary: "topic image",
      isInline: true,
    });
    const photoCalls: Array<{ filename?: string; other?: Record<string, unknown> }> = [];
    const richPayloads: unknown[] = [];
    const api = {
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 111, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
      sendPhoto: async (_chatId: number, photo: { filename?: string }, other?: Record<string, unknown>) => {
        photoCalls.push({ filename: photo.filename, other });
        if (other?.message_thread_id === 42) throw threadError();
        return {
          message_id: 112,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          photo: [{ file_id: "topic-photo-id", file_unique_id: "topic-photo-unique", width: 1024, height: 1024 }],
        };
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        messageThreadId: 42,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: testT,
      },
      "",
      "",
      0,
      [{
        fileId: file.id,
        type: "image",
        name: file.name,
        path: file.path,
        size: file.size,
        caption: "Image caption",
        inline: true,
        card: "topic image",
        delivery: "photo",
        origin: "generated_image",
      }],
    );

    expect(richPayloads).toHaveLength(1);
    expect(richMarkdownOf(richPayloads[0])).toContain("Done — the image is ready.");
    expect(richMarkdownOf(richPayloads[0])).not.toContain("![");
    expect(photoCalls).toHaveLength(2);
    expect(photoCalls[0]).toMatchObject({ filename: "topic-image.png", other: { message_thread_id: 42 } });
    expect(photoCalls[0]?.other).not.toHaveProperty("caption");
    expect(photoCalls[1]?.other?.message_thread_id).toBeUndefined();
    expect(photoCalls[1]?.other).not.toHaveProperty("caption");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Done — the image is ready." });
    expect(await repos.files.listForMessage(latest!.id)).toMatchObject([{ id: file.id }]);
    await expect(repos.files.get(file.id)).resolves.toMatchObject({
      telegram_file_id: "topic-photo-id",
      telegram_file_unique_id: "topic-photo-unique",
    });
  });

  it("retries outbound media group sends without message_thread_id when Telegram rejects the topic", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 108, firstName: "MediaThread", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, 42, "Topic 42");
    const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-media-thread-"));
    tempDirs.push(fileDir);
    const firstPath = path.join(fileDir, "first.txt");
    const secondPath = path.join(fileDir, "second.txt");
    await fs.writeFile(firstPath, "first document content");
    await fs.writeFile(secondPath, "second document content");
    const first = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "first-topic-file.txt",
      path: firstPath,
      size: "first document content".length,
      contentMd: "first document content",
      summary: "first document content",
      isInline: true,
    });
    const second = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "second-topic-file.txt",
      path: secondPath,
      size: "second document content".length,
      contentMd: "second document content",
      summary: "second document content",
      isInline: true,
    });
    const mediaGroupCalls: Array<{
      media: Array<{ type?: string; filename?: string; caption?: string }>;
      other?: Record<string, unknown>;
    }> = [];
    const api = {
      raw: {
        sendRichMessage: async () => ({ message_id: 90, date: 1, chat: { id: user.tg_id, type: "private" } }),
      },
      sendDocument: async () => {
        throw new Error("multiple files should use sendMediaGroup");
      },
      sendMediaGroup: async (_chatId: number, media: Array<Record<string, unknown>>, other?: Record<string, unknown>) => {
        mediaGroupCalls.push({
          media: media.map((item) => ({
            type: item.type as string | undefined,
            filename: (item.media as { filename?: string } | undefined)?.filename,
            caption: item.caption as string | undefined,
          })),
          other,
        });
        if (other?.message_thread_id === 42) throw threadError();
        return media.map((_item, index) => ({
          message_id: 91 + index,
          date: 1,
          chat: { id: user.tg_id, type: "private" },
          document: { file_id: `topic-group-file-${index + 1}`, file_unique_id: `topic-group-unique-${index + 1}` },
        }));
      },
    };

    await sendFinal(
      {
        api: api as never,
        chatId: user.tg_id,
        messageThreadId: 42,
        config,
        db,
        repos,
        logger: createLogger(config),
        user,
        thread,
        text: "question",
        t: (key) => key,
      },
      "",
      "answer with grouped documents",
      0,
      [
        {
          fileId: first.id,
          type: "txt",
          name: first.name,
          path: first.path,
          size: first.size,
          caption: "First caption",
          inline: true,
          card: "first document content",
        },
        {
          fileId: second.id,
          type: "txt",
          name: second.name,
          path: second.path,
          size: second.size,
          caption: "Second caption",
          inline: true,
          card: "second document content",
        },
      ],
    );

    expect(mediaGroupCalls).toHaveLength(2);
    expect(mediaGroupCalls[0]?.other?.message_thread_id).toBe(42);
    expect(mediaGroupCalls[1]?.other?.message_thread_id).toBeUndefined();
    expect(mediaGroupCalls[1]?.media[0]).toMatchObject({
      type: "document",
      filename: "first-topic-file.txt",
    });
    expect(mediaGroupCalls[1]?.media[0]?.caption).toContain("[Topic 42]");
    expect(mediaGroupCalls[1]?.media[0]?.caption).toContain("First caption");
    expect(mediaGroupCalls[1]?.media[1]).toMatchObject({
      type: "document",
      filename: "second-topic-file.txt",
      caption: "Second caption",
    });
    const latest = await repos.messages.latest(thread.id);
    expect(await repos.files.listForMessage(latest!.id)).toMatchObject([{ id: first.id }, { id: second.id }]);
    await expect(repos.files.get(first.id)).resolves.toMatchObject({
      telegram_file_id: "topic-group-file-1",
      telegram_file_unique_id: "topic-group-unique-1",
    });
    await expect(repos.files.get(second.id)).resolves.toMatchObject({
      telegram_file_id: "topic-group-file-2",
      telegram_file_unique_id: "topic-group-unique-2",
    });
  });

  it("detects provider context length errors inside nested response bodies", () => {
    expect(
      isContextLengthError({
        responseBody: {
          error: {
            message: "This request exceeds the maximum allowed tokens for the model.",
          },
        },
      }),
    ).toBe(true);
    expect(isContextLengthError(new Error("temporary upstream failure"))).toBe(false);
  });
});

function parseError(): GrammyError {
  return new GrammyError(
    "Call to sendRichMessage failed",
    { ok: false, error_code: 400, description: "Bad Request: can't parse rich markdown" },
    "sendRichMessage",
    {},
  );
}

function threadError(): GrammyError {
  return new GrammyError(
    "Call to sendRichMessage failed",
    { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    "sendRichMessage",
    {},
  );
}

function fakeEmbedder() {
  return {
    embed: async (texts: string[]) => texts.map((text) => new Float32Array([text.length, 1])),
  };
}

function pngBytes(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axw7NAAAAAASUVORK5CYII=",
    "base64",
  );
}

function richMarkdownOf(payload: unknown): string {
  return ((payload as Record<string, Record<string, string>>).rich_message).markdown ?? "";
}

function testT(key: string, params?: Record<string, string | number>): string {
  switch (key) {
    case "thinking-placeholder":
      return "💭 Thinking...";
    case "thinking-done":
      return "✅ Done.";
    case "image-generated-done":
      return "Done — the image is ready.";
    case "image-generated-ready":
      return "Done — the image is ready.";
    case "thinking-summary-running":
      return `🧠 Thinking for ${params?.time}`;
    case "thinking-summary-generating-image":
      return `🖼️ Generating image for ${params?.time}`;
    case "thinking-summary-final":
      return `🧠 Thought for ${params?.time}`;
    case "thinking-final-tool-calls":
      return `Tool calls: ${params?.count}`;
    case "thinking-final-reasoning":
      return `Reasoning blocks: ${params?.count}`;
    case "thinking-final-tools":
      return "Tools:";
    case "thinking-final-files":
      return `Files sent: ${params?.count}`;
    case "thinking-final-files-capped":
      return `Files sent: ${params?.sent} of ${params?.requested} (limit ${params?.limit})`;
    case "show-more":
      return "Show more";
    case "error-generic":
      return "⚠️ Something went wrong.";
    case "empty-answer":
      return "⚠️ No final answer returned.";
    case "ctx-limit":
      return "🧠 This chat is close to the model context limit.";
    case "btn-compact":
      return "🗜 Compact";
    default:
      return key;
  }
}

class ScriptedCodexTransport implements CodexTransport {
  readonly incoming = new AsyncQueue<JsonRpcMessage>();
  readonly sent: JsonRpcMessage[] = [];

  constructor(private readonly parts: unknown[]) {}

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
    if (message.method === "initialize") {
      queueMicrotask(() => this.emit({ id: message.id, result: {} }));
    } else if (message.method === "thread/start") {
      queueMicrotask(() => this.emit({ id: message.id, result: { thread: { id: "thread-1" } } }));
    } else if (message.method === "turn/start") {
      queueMicrotask(() => {
        this.emit({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
        void this.emitParts().then(() => {
          this.emit({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
        });
      });
    }
  }

  emit(message: JsonRpcMessage): void {
    this.incoming.push(message);
  }

  close(): void {
    this.incoming.close();
  }

  private async emitParts(): Promise<void> {
    let toolId = 0;
    for (const part of this.parts) {
      const record = part as Record<string, unknown> & { type?: string };
      if (record.type === "delay") {
        await delay(Number(record.ms ?? 0));
      } else if (record.type === "text-delta") {
        this.emit({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: String(record.text ?? record.delta ?? "") },
        });
      } else if (record.type === "text-final") {
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: String(record.itemId ?? "msg-final"),
              type: "agentMessage",
              text: String(record.text ?? ""),
            },
          },
        });
      } else if (record.type === "reasoning-delta") {
        this.emit({
          method: "item/reasoning/summaryTextDelta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: String(record.text ?? record.delta ?? ""), summaryIndex: 0 },
        });
      } else if (record.type === "tool-call") {
        toolId += 1;
        this.emit({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: `tool-${toolId}`,
              type: "dynamicToolCall",
              tool: String(record.toolName ?? "tool"),
              arguments: record.input ?? record.args ?? {},
            },
          },
        });
      } else if (record.type === "tool-result") {
        toolId += 1;
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: `tool-${toolId}`,
              type: "dynamicToolCall",
              tool: String(record.toolName ?? "tool"),
              contentItems: [{ type: "inputText", text: safeJson(record.output ?? record.result ?? {}) }],
            },
          },
        });
      } else if (record.type === "server-tool-call") {
        toolId += 1;
        const requestId = 1000 + toolId;
        this.emit({
          id: requestId,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: `tool-${toolId}`,
            namespace: "telegram",
            tool: String(record.toolName ?? "tool"),
            arguments: record.input ?? record.args ?? {},
          },
        });
        await this.waitForResponse(requestId);
      }
    }
  }

  private async waitForResponse(id: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.sent.some((message) => message.id === id && (message.result !== undefined || message.error !== undefined))) return;
      await delay(0);
    }
    throw new Error(`timed out waiting for tool response ${id}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("timed out waiting for condition");
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
