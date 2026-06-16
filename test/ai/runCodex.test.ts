import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { runTurn } from "../../src/ai/run.js";
import {
  setCodexTransportFactoryForTests,
  type CodexTransport,
  type JsonRpcMessage,
} from "../../src/ai/codexAppServer.js";

describe("runTurn with Codex app-server inference", () => {
  let db: AppDatabase;
  let repos: Repos;
  let transport: ScriptedCodexTransport;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
    transport = new ScriptedCodexTransport();
    setCodexTransportFactoryForTests(() => transport);
  });

  afterEach(async () => {
    setCodexTransportFactoryForTests(undefined);
    await db.destroy();
  });

  it("runs local tools, edits status, persists the final answer, and stores OpenRouter embeddings", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 510, firstName: "Codex", lang: "en" });
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "alpha searchable detail" },
      textPlain: "alpha searchable detail",
    });

    const sentTexts: string[] = [];
    const editedTexts: string[] = [];
    const richPayloads: unknown[] = [];
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
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 20, date: 1, chat: { id: user.tg_id, type: "private" } };
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
      text: "find alpha",
      embedder: fakeEmbedder(),
      t: testT,
    });

    expect(sentTexts).toEqual(["💭 Thinking..."]);
    expect(editedTexts).toContain("💭 Thinking...\n\n💬 Searching chat <code>alpha</code>");
    expect(editedTexts.some((text) => text.includes("💬 Searching chat <code>alpha</code> ("))).toBe(true);
    expect(editedTexts.at(-1)).toContain("✅ Done.\n\n💬 Searching chat <code>alpha</code>");
    expect(JSON.stringify(richPayloads)).toContain("Codex found alpha.");

    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Codex found alpha." });
    expect(latest?.thinking).toContain("💬 Searching chat <code>alpha</code>");
    const embeddings = await repos.embeddings.list("message", [latest!.id]);
    expect(embeddings[0]?.model).toBe(config.OPENROUTER_EMBEDDING_MODEL);
    expect(embeddings[0]?.decoded[0]).toBe("Codex found alpha.".length);
  }, 30_000);
});

class ScriptedCodexTransport implements CodexTransport {
  readonly incoming = new AsyncQueue<JsonRpcMessage>();
  readonly sent: JsonRpcMessage[] = [];

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
    if (message.method === "initialize") {
      queueMicrotask(() => this.emit({ id: message.id, result: {} }));
    } else if (message.method === "thread/start") {
      queueMicrotask(() => this.emit({ id: message.id, result: { thread: { id: "thread-1" } } }));
    } else if (message.method === "turn/start") {
      queueMicrotask(() => {
        this.emit({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
        this.emit({
          id: 900,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            namespace: "telegram",
            tool: "search_thread",
            arguments: { query: "alpha", limit: 5 },
          },
        });
      });
    } else if (message.id === 900 && message.result) {
      queueMicrotask(() => {
        this.emit({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Codex found alpha." },
        });
        this.emit({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
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

function fakeEmbedder() {
  return {
    model: "openrouter-test-embedding",
    embed: async (texts: string[]) => texts.map((text) => new Float32Array([text.length, 1])),
  };
}

function testT(key: string): string {
  switch (key) {
    case "thinking-placeholder":
      return "💭 Thinking...";
    case "thinking-done":
      return "✅ Done.";
    case "empty-answer":
      return "⚠️ No final answer returned.";
    case "error-generic":
      return "Something went wrong.";
    default:
      return key;
  }
}
