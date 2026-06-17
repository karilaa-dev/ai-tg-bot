import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
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

  beforeEach(async () => {
    codexParts = [];
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
    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "⚠️ No final answer returned." });
    expect(latest?.thinking).toContain("📄 Searching file <code>chapter-notes.txt</code> (0 results)");
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
    expect(latest?.thinking).toContain("🔎 Searching web <code>alpha</code> (5 results)");
    expect(latest?.thinking).toContain("🔎 Searching web <code>beta</code> (2 results)");
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
    expect(latest?.thinking).toContain("> I will calculate this first, then verify it.");
    expect(latest?.thinking).toContain("🐚 Running bash");
    expect(latest?.thinking).toContain("(exit 0)");
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

function richMarkdownOf(payload: unknown): string {
  return ((payload as Record<string, Record<string, string>>).rich_message).markdown ?? "";
}

function testT(key: string, params?: Record<string, string | number>): string {
  switch (key) {
    case "thinking-placeholder":
      return "💭 Thinking...";
    case "thinking-done":
      return "✅ Done.";
    case "thinking-summary-running":
      return `🧠 Thinking for ${params?.time}`;
    case "thinking-summary-final":
      return `🧠 Thought for ${params?.time}`;
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
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
