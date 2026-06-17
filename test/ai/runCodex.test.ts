import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  let tempDirs: string[] = [];

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
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
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
    expect(latest?.thinking).toContain("Tool calls: 1");
    expect(latest?.thinking).toContain("- 💬 Searching chat: 1");
    expect(latest?.thinking).not.toContain("💬 Searching chat <code>alpha</code>");
    const embeddings = await repos.embeddings.list("message", [latest!.id]);
    expect(embeddings[0]?.model).toBe(config.OPENROUTER_EMBEDDING_MODEL);
    expect(embeddings[0]?.decoded[0]).toBe("Codex found alpha.".length);
  }, 30_000);

  it("exposes and executes the persistent bash tool with JS, Python, and curl through Codex app-server turns", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-run-codex-bash-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const pi100 = "3141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067";
    expect(pi100).toHaveLength(100);
    const rawApiUrl = "http://93.184.216.34/api/pi?start=0&numberOfDigits=100";
    const bashScript = [
      `js-exec -c 'console.log("${pi100}")' > js.txt`,
      `python3 -c 'print("${pi100}")' > py.txt`,
      `curl -fsSL '${rawApiUrl}' | jq -r .digits > curl.txt`,
      "python3 - <<'PY'",
      "import json",
      "js = open('js.txt').read().strip()",
      "py = open('py.txt').read().strip()",
      "curl = open('curl.txt').read().strip()",
      "print(json.dumps({'js': js, 'python': py, 'curl': curl, 'equal': js == py == curl, 'count': len(js)}, separators=(',', ':')))",
      "PY",
    ].join("\n");
    transport = new ScriptedCodexTransport({
      tool: "bash",
      arguments: { script: bashScript },
      finalDelta: "Pi verification used bash compact JSON.",
    });
    setCodexTransportFactoryForTests(() => transport);
    const user = await repos.users.ensure({ tgId: 511, firstName: "CodexBash", lang: "en" });
    const streamOffUser = await repos.users.toggleStream(user.tg_id);
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const sentTexts: string[] = [];
    const editedTexts: string[] = [];
    const richPayloads: unknown[] = [];
    const api = {
      sendMessage: async (_chatId: number, text: string) => {
        sentTexts.push(text);
        return { message_id: 30, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        editedTexts.push(text);
        return { message_id: 30, date: 1, chat: { id: user.tg_id, type: "private" } };
      },
      sendChatAction: async () => true,
      raw: {
        sendRichMessage: async (payload: unknown) => {
          richPayloads.push(payload);
          return { message_id: 40, date: 1, chat: { id: user.tg_id, type: "private" } };
        },
      },
    };

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (resource, init) => {
      fetchCalls += 1;
      expect(String(resource)).toBe(rawApiUrl);
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ digits: pi100 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await runTurn({
        api: api as never,
        chatId: user.tg_id,
        config,
        db,
        repos,
        logger: createLogger(config),
        user: streamOffUser,
        thread,
        text: "run bash",
        embedder: fakeEmbedder(),
        t: testT,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    expect(JSON.stringify((threadStart?.params as Record<string, unknown>)?.dynamicTools)).toContain('"name":"bash"');
    const toolResponse = transport.sent.find((message) => message.id === 900 && Boolean(message.result));
    const toolResultText = (((toolResponse?.result as Record<string, unknown>)?.contentItems as Array<Record<string, string>>)?.[0]?.text) ?? "";
    const bashResult = JSON.parse(toolResultText) as { stdout: string };
    expect(bashResult.stdout).toContain('"equal":true');
    expect(bashResult.stdout).toContain('"count":100');
    expect(transport.sent.some((message) => String(JSON.stringify(message.params)).includes('"tool":"web_extract"'))).toBe(false);
    expect(bashScript).not.toContain("pipefail");
    expect(fetchCalls).toBe(1);
    expect(sentTexts).toEqual(["💭 Thinking..."]);
    expect(editedTexts.join("\n")).toContain("🐚 Running bash <code>js-exec");
    expect(editedTexts.join("\n")).toContain("python3");
    expect(editedTexts.join("\n")).toContain("curl");
    expect(editedTexts.some((text) => text.includes("(exit 0)"))).toBe(true);
    expect(editedTexts.at(-1)).toContain("✅ Done.\n\n🐚 Running bash");
    expect(JSON.stringify(richPayloads)).toContain("Pi verification used bash compact JSON.");

    const latest = await repos.messages.latest(thread.id);
    expect(latest).toMatchObject({ role: "assistant", text_plain: "Pi verification used bash compact JSON." });
    expect(latest?.thinking).toContain("Tool calls: 1");
    expect(latest?.thinking).toContain("- 🐚 Running bash: 1");
    expect(latest?.thinking).not.toContain("🐚 Running bash <code>js-exec");
    expect(latest?.thinking).not.toContain("python3");
    expect(latest?.thinking).not.toContain("curl");
    expect(latest?.thinking).not.toContain("(exit 0)");
  }, 30_000);
});

class ScriptedCodexTransport implements CodexTransport {
  readonly incoming = new AsyncQueue<JsonRpcMessage>();
  readonly sent: JsonRpcMessage[] = [];

  constructor(
    private readonly script: {
      tool: string;
      arguments: Record<string, unknown>;
      finalDelta: string;
    } = {
      tool: "search_thread",
      arguments: { query: "alpha", limit: 5 },
      finalDelta: "Codex found alpha.",
    },
  ) {}

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
            tool: this.script.tool,
            arguments: this.script.arguments,
          },
        });
      });
    } else if (message.id === 900 && message.result) {
      queueMicrotask(() => {
        this.emit({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: this.script.finalDelta },
        });
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "msg-1", type: "agentMessage", text: this.script.finalDelta },
          },
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
    case "empty-answer":
      return "⚠️ No final answer returned.";
    case "error-generic":
      return "Something went wrong.";
    default:
      return key;
  }
}
