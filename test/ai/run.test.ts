import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { isContextLengthError, runTurn, sendFinal } from "../../src/ai/run.js";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

describe("runTurn", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    streamTextMock.mockReset();
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not duplicate an already persisted latest user message on retry", async () => {
    const config = loadTestConfig({ MODEL_CONTEXT_TOKENS_OVERRIDE: 10 });
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
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "text-delta", text: "Recovered answer." }]),
    });
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
    const config = loadTestConfig({ MODEL_CONTEXT_TOKENS_OVERRIDE: 10 });
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
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "tool-call", toolName: "search_in_file", input: { query: "chapter 5" } },
        { type: "tool-result", toolName: "search_in_file", output: { results: [] } },
      ]),
    });
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
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "⚠️ No final answer returned." });
    expect(latest?.thinking).toContain("📄Searching file(0)");
  });

  it("edits a regular status message with compact tool counts when streaming is off", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 97, firstName: "Status", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "tool-call", toolName: "web_search", input: { query: "alpha" } },
        { type: "tool-result", toolName: "web_search", output: { results: [{}, {}, {}, {}, {}] } },
        { type: "tool-call", toolName: "web_search", input: { query: "beta" } },
        { type: "tool-result", toolName: "web_search", output: { results: [{}, {}] } },
        { type: "text-delta", text: "Final answer." },
      ]),
    });
    const sentTexts: string[] = [];
    const editedTexts: string[] = [];
    const api = {
      sendMessage: async (_chatId: number, text: string) => {
        sentTexts.push(text);
        return { message_id: 10, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        editedTexts.push(text);
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

    expect(sentTexts).toEqual(["💭 Thinking..."]);
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎Searching web");
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎Searching web(5)");
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎Searching web x2(5)");
    expect(editedTexts).toContain("💭 Thinking...\n\n🔎Searching web x2(2)");
    expect(editedTexts.at(-1)).toBe("✅ Done.\n\n🔎Searching web x2(2)");
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Final answer." });
    expect(latest?.thinking).toContain("🔎Searching web x2(2)");
    expect(latest?.thinking).not.toContain("↳");
    expect(latest?.thinking).not.toContain("web_search");
    expect(latest?.thinking).not.toContain("query");
  });

  it("flushes the complete streaming draft before sending the final rich message", async () => {
    const config = loadTestConfig({ DRAFT_UPDATE_MS: 0 });
    const user = await repos.users.ensure({ tgId: 94, firstName: "Stream", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "text-delta", text: "First. Second. Third." }]),
    });
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
    expect(richMarkdownOf(draftPayloads[0])).toContain("First.");
    expect(richMarkdownOf(draftPayloads[0])).not.toContain("Second.");
    expect(richMarkdownOf(draftPayloads[1])).toContain("First. Second. Third.");
    expect(events.at(-1)?.startsWith("final:")).toBe(true);
    expect(events.findIndex((event) => event.startsWith("final:"))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith("draft:")),
    );
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "First. Second. Third." });
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

function fullStream(parts: unknown[]) {
  return (async function* stream() {
    for (const part of parts) yield part;
  })();
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
    case "thinking-summary":
      return `🧠 Thinking (${params?.steps} steps)`;
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
