import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadTestConfig } from "../../src/config.js";
import {
  codexAppServerConfigArgs,
  setCodexTransportFactoryForTests,
  streamCodexTurn,
  type CodexTransport,
  type JsonRpcMessage,
} from "../../src/ai/codexAppServer.js";
import type { BotToolRegistry } from "../../src/ai/tools/index.js";

describe("Codex app-server client", () => {
  let transport: FakeCodexTransport;

  beforeEach(() => {
    transport = new FakeCodexTransport();
    setCodexTransportFactoryForTests(() => transport);
  });

  afterEach(() => {
    setCodexTransportFactoryForTests(undefined);
  });

  it("builds process-level app-server config overrides for reasoning summaries", () => {
    expect(codexAppServerConfigArgs(loadTestConfig())).toEqual([
      "-c",
      'model_verbosity="high"',
      "-c",
      'model_reasoning_summary="none"',
    ]);
    expect(codexAppServerConfigArgs(loadTestConfig({
      REASONING_SUMMARY: "detailed",
    }))).toEqual([
      "-c",
      'model_verbosity="high"',
      "-c",
      'model_reasoning_summary="detailed"',
    ]);
  });

  it("passes the summary level through thread and turn start", async () => {
    const config = loadTestConfig({
      CODEX_MODEL: "gpt-5.5",
      REASONING_SUMMARY: "detailed",
    });
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "hello",
    }).fullStream);

    const initialize = await waitForSent(transport, (message) => message.method === "initialize");
    transport.emit({ id: initialize.id, result: {} });
    await waitForSent(transport, (message) => message.method === "initialized");
    const threadStart = await waitForSent(transport, (message) => message.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "gpt-5.5",
      config: {
        model_verbosity: "high",
        model_reasoning_summary: "detailed",
      },
    });
    transport.emit({ id: threadStart.id, result: { thread: { id: "thread-1" } } });
    const turnStart = await waitForSent(transport, (message) => message.method === "turn/start");
    expect(turnStart.params).toMatchObject({ model: "gpt-5.5", summary: "detailed" });
    expect(turnStart.params).not.toHaveProperty("effort");
    transport.emit({ id: turnStart.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    transport.emit({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "summary reasoning", summaryIndex: 0 },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "reasoning-delta", text: "summary reasoning" },
    ]);
  });

  it("handshakes and sends ephemeral thread and turn payloads with dynamic tools", async () => {
    const config = loadTestConfig({
      CODEX_MODEL: "gpt-5.5",
      CODEX_SPEED_MODE: "fast",
    });
    const partsPromise = collect(streamCodexTurn({
      config,
      system: "system instructions",
      prompt: "hello",
      tools: simpleRegistry(),
    }).fullStream);

    const initialize = await waitForSent(transport, (message) => message.method === "initialize");
    expect(initialize.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    transport.emit({ id: initialize.id, result: {} });

    await waitForSent(transport, (message) => message.method === "initialized");
    const threadStart = await waitForSent(transport, (message) => message.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "gpt-5.5",
      serviceTier: "fast",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        model_verbosity: "high",
        model_reasoning_summary: "none",
      },
      baseInstructions: "system instructions",
      developerInstructions: null,
      ephemeral: true,
    });
    expect(toolSpecs(threadStart)[0]).toMatchObject({
      namespace: "telegram",
      name: "search_thread",
      description: "Search this Telegram thread memory.",
      exposeToContext: true,
    });
    expect(toolSpecs(threadStart)[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
    });
    transport.emit({ id: threadStart.id, result: { thread: { id: "thread-1" } } });

    const turnStart = await waitForSent(transport, (message) => message.method === "turn/start");
    expect(turnStart.params).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.5",
      serviceTier: "fast",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(turnStart.params).not.toHaveProperty("summary");
    transport.emit({ id: turnStart.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([]);
  });

  it("executes item/tool/call requests and collects summary, tool, and message events", async () => {
    const config = loadTestConfig({ REASONING_SUMMARY: "detailed" });
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "find alpha",
      tools: simpleRegistry(),
    }).fullStream);

    await completeHandshake();
    transport.emit({
      id: 99,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "telegram",
        tool: "search_thread",
        arguments: { query: "alpha" },
      },
    });
    const toolResponse = await waitForSent(transport, (message) => message.id === 99 && Boolean(message.result));
    expect(toolResponse.result).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ results: [{ snippet: "alpha result" }] }) }],
    });

    transport.emit({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "checking", summaryIndex: 0 },
    });
    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Alpha answer." },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "tool-call", toolName: "search_thread", input: { query: "alpha" } },
      { type: "tool-result", toolName: "search_thread", output: { results: [{ snippet: "alpha result" }] } },
      { type: "reasoning-delta", text: "checking" },
      { type: "text-delta", text: "Alpha answer." },
    ]);
  });

  it("uses completed agentMessage items as authoritative final text replacements", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "final replacement",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Partial" },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "msg-1", type: "agentMessage", text: "Complete final answer." },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "msg-1", type: "agentMessage", text: "Complete final answer." }],
        },
      },
    });

    await expect(partsPromise).resolves.toEqual([
      { type: "text-delta", text: "Partial" },
      { type: "text-final", text: "Complete final answer." },
    ]);
  });

  it("processes completed agentMessage items carried only by turn/completed", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "turn items final",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "msg-1", type: "agentMessage", text: "Final from completed turn items." }],
        },
      },
    });

    await expect(partsPromise).resolves.toEqual([
      { type: "text-final", text: "Final from completed turn items." },
    ]);
  });

  it("emits multiple completed agentMessage replacements in order", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "multiple final messages",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "msg-1", type: "agentMessage", text: "First completed answer." },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "msg-2", type: "agentMessage", text: "Second completed answer." },
      },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "text-final", text: "First completed answer." },
      { type: "text-final", text: "Second completed answer." },
    ]);
  });

  it("surfaces completed reasoning summaries when no summary delta was streamed", async () => {
    const config = loadTestConfig({ REASONING_SUMMARY: "detailed" });
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "completed reasoning",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reason-1", type: "reasoning", summary: ["completed summary"] },
      },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "reasoning-delta", text: "completed summary" },
    ]);
  });

  it("ignores summary events when summaries are disabled", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "hide reasoning summary",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "summary", summaryIndex: 0 },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([]);
  });

  it("ignores raw reasoning events and completed raw reasoning content", async () => {
    const config = loadTestConfig({ REASONING_SUMMARY: "detailed" });
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "ignore raw reasoning",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/reasoning/textDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "raw delta", contentIndex: 0 },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: Date.now(),
        item: {
          type: "reasoning",
          id: "reason-1",
          raw_content: ["raw completed"],
        },
      },
    });
    transport.emit({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          summary: [],
          raw_content: [{ type: "reasoning_text", text: "raw response item" }],
          encrypted_content: null,
        },
      },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([]);
  });

  it("splits large Codex text and reasoning deltas into smaller stream chunks", async () => {
    const config = loadTestConfig({ REASONING_SUMMARY: "detailed", STREAM_DELTA_CHARS: 5 });
    const partsPromise = collect(streamCodexTurn({
      config,
      prompt: "chunk deltas",
    }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "checking", summaryIndex: 0 },
    });
    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "AlphaBeta" },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "reasoning-delta", text: "check" },
      { type: "reasoning-delta", text: "ing" },
      { type: "text-delta", text: "Alpha" },
      { type: "text-delta", text: "Beta" },
    ]);
  });

  it("propagates failed turns", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({ config, prompt: "fail" }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "model failed" } } },
    });

    await expect(partsPromise).rejects.toThrow("model failed");
  });

  it("formats nested app-server error notifications", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({ config, prompt: "fail" }).fullStream);

    await completeHandshake();
    transport.emit({
      method: "error",
      params: { error: { message: "local provider unavailable" } },
    });

    await expect(partsPromise).rejects.toThrow("local provider unavailable");
  });

  it("does not fail the stream on transient retry notifications", async () => {
    const config = loadTestConfig();
    const partsPromise = collect(streamCodexTurn({ config, prompt: "retry" }).fullStream);

    await completeHandshake();
    transport.emit({ method: "error", params: { error: { message: "Reconnecting... 1/5" } } });
    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "answer after retry" },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await expect(partsPromise).resolves.toEqual([
      { type: "text-delta", text: "answer after retry" },
    ]);
  });

  async function completeHandshake(): Promise<void> {
    const initialize = await waitForSent(transport, (message) => message.method === "initialize");
    transport.emit({ id: initialize.id, result: {} });
    const threadStart = await waitForSent(transport, (message) => message.method === "thread/start");
    transport.emit({ id: threadStart.id, result: { thread: { id: "thread-1" } } });
    const turnStart = await waitForSent(transport, (message) => message.method === "turn/start");
    transport.emit({ id: turnStart.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
  }
});

function simpleRegistry(): BotToolRegistry {
  return {
    search_thread: {
      description: "Search this Telegram thread memory.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ results: [{ snippet: `${query} result` }] }),
    },
  };
}

function toolSpecs(message: JsonRpcMessage): Array<Record<string, unknown>> {
  return ((message.params as Record<string, unknown>).dynamicTools ?? []) as Array<Record<string, unknown>>;
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

async function waitForSent(
  transport: FakeCodexTransport,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  for (let i = 0; i < 200; i += 1) {
    const message = transport.sent.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for sent message; saw ${JSON.stringify(transport.sent)}`);
}

class FakeCodexTransport implements CodexTransport {
  readonly incoming = new AsyncQueue<JsonRpcMessage>();
  readonly sent: JsonRpcMessage[] = [];

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
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
