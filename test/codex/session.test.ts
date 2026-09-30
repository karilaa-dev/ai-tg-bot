import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import type { AgentSessionEvent } from "../../src/ai/runtime.js";
import { inferenceUsageFromEntries } from "../../src/ai/usage.js";
import { TurnBudget } from "../../src/ai/turnBudget.js";
import type { CodexClient, RpcNotification, RpcRequest } from "../../src/codex/appServer.js";
import { CodexSession, type CodexSessionInput } from "../../src/codex/session.js";
import type { ThreadBridge } from "../../src/codex/threadBridge.js";
import type { OpenRouterTurnInput, OpenRouterTurnResult } from "../../src/codex/openrouter.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../src/codex/tools.js", () => ({
  executeBotTool: mocks.execute,
  dynamicToolSpecs: () => [{ name: "finish_response", description: "Finish", inputSchema: { type: "object" } }],
}));

class MockClient implements CodexClient {
  notifications = new Set<(event: RpcNotification) => void>();
  handlers = new Set<(event: RpcRequest) => Promise<unknown>>();
  disconnects = new Set<() => void>();
  requests: Array<{ method: string; params: unknown }> = [];
  turn = 0;
  run: (id: string) => void | Promise<void> = () => {};
  rollbackFails = false;
  initialize = async () => {};
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "turn/start") {
      const id = `turn-${++this.turn}`;
      queueMicrotask(() => { this.emit("turn/started", { turn: { id, status: "inProgress" } }); void this.run(id); });
      return { turn: { id, status: "inProgress" } } as T;
    }
    if (method === "turn/interrupt") {
      const turnId = String((params as { turnId: string }).turnId);
      this.emit("turn/completed", { turn: { id: turnId, status: "interrupted" } });
    }
    if (method === "thread/rollback" && this.rollbackFails) throw new Error("App-server disconnected.");
    return {} as T;
  }
  emit(method: string, params: Record<string, unknown> = {}): void {
    for (const listener of this.notifications) listener({ method, params: { threadId: "thread-1", ...params } });
  }
  async call(params: Record<string, unknown>): Promise<unknown> {
    for (const handler of this.handlers) {
      const result = await handler({ id: "call-rpc", method: "item/tool/call", params: { threadId: "thread-1", ...params } });
      if (result !== undefined) return result;
    }
    return undefined;
  }
  onNotification(listener: (event: RpcNotification) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest(listener: (event: RpcRequest) => Promise<unknown>): () => void { this.handlers.add(listener); return () => { this.handlers.delete(listener); }; }
  onDisconnect(listener: () => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  dispose = async () => {};
}

function usage(inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningOutputTokens = 0) {
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens };
}

function bridge(): ThreadBridge {
  return {
    user: { tg_id: 42 }, thread: { id: 7 },
    currentTurnSessionContext: () => "Conversation files are restored automatically.",
    currentTurnSystemPrompt: () => "Telegram assistant instructions.",
    currentTurnBudget: () => undefined,
    selectedContextFileIds: () => new Set<number>(),
    repos: { files: { listByIds: vi.fn(async () => []) } },
    resolveImage: vi.fn(async () => ({ bytes: Buffer.from("image"), mimeType: "image/png" })),
    registerNativeArtifact: vi.fn(), prepareCommandFiles: vi.fn(),
    holdCommandActivity: vi.fn(),
  } as unknown as ThreadBridge;
}

function fallbackResult(text = "Fallback answer"): OpenRouterTurnResult {
  return { text, model: "fallback-model", messages: [{ role: "assistant", content: text }], usage: {
    inputTokens: 30, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 45, cacheReadRatio: 0.1429,
    calls: [{ provider: "openrouter", model: "fallback-model", inputTokens: 30, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }],
  } };
}

describe("Codex conversation sessions", () => {
  const sessions: CodexSession[] = [];
  afterEach(async () => { for (const session of sessions.splice(0)) await session.dispose(); mocks.execute.mockReset(); });

  function setup(overrides: Partial<CodexSessionInput> = {}) {
    const client = new MockClient();
    const connection = bridge();
    const succeeded = vi.fn();
    const unavailable = vi.fn(() => true);
    const finished = vi.fn(async () => {});
    const delivered = vi.fn(async () => {});
    const input: CodexSessionInput = { client, bridge: connection, config: loadTestConfig(), ensureThread: async () => "thread-1", chooseCodex: async () => true, codexSucceeded: succeeded, codexUnavailable: unavailable, onTurnFinished: finished, onDelivery: delivered, ...overrides };
    const session = new CodexSession(input);
    sessions.push(session);
    return { session, client, bridge: connection, succeeded, unavailable, finished, delivered };
  }

  it("streams native events, preserves exact per-response usage, and selects the target environment on every turn", async () => {
    const config = loadTestConfig({ CODEX_FAST_MODE: true });
    const { session, client, succeeded, finished, delivered } = setup({ config });
    const events: AgentSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    client.run = id => {
      client.emit("item/reasoning/summaryTextDelta", { turnId: id, delta: "I checked it." });
      client.emit("item/agentMessage/delta", { turnId: id, delta: "Looking up the answer." });
      client.emit("rawResponse/completed", { turnId: id, responseId: "response-1", usage: usage(100, 60, 20, 5) });
      client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total: usage(100, 60, 20), last: usage(100, 60, 20) } });
      client.emit("item/started", { turnId: id, item: { type: "webSearch", id: "search", action: { query: "question" } } });
      client.emit("item/completed", { turnId: id, item: { type: "webSearch", id: "search", status: "completed" } });
      client.emit("item/agentMessage/delta", { turnId: id, delta: "Final answer." });
      client.emit("rawResponse/completed", { turnId: id, responseId: "response-2", usage: usage(120, 70, 30, 7) });
      client.emit("item/completed", { turnId: id, item: { type: "agentMessage", id: "final", text: "Final answer.", phase: "final_answer" } });
      client.emit("turn/completed", { turn: { id, status: "completed" } });
    };
    await session.prompt("Question");
    expect(session.isStreaming).toBe(false);
    expect(succeeded).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith("thread-1");
    const started = client.requests.find(request => request.method === "turn/start")!.params;
    expect(started).toMatchObject({ serviceTier: "priority", environments: [{ environmentId: "telegram:42:7", cwd: "/home/user/workspace" }], input: [{ type: "text", text: expect.stringContaining("Question") }] });
    expect(events).toContainEqual({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "I checked it." } });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolName: "web_search" }));
    const entries = session.sessionManager.getEntries();
    expect(entries[0]?.id).toBe("codex:turn-1");
    expect(inferenceUsageFromEntries(entries)).toMatchObject({ inputTokens: 90, cacheReadTokens: 130, outputTokens: 50, totalTokens: 270 });
    expect(inferenceUsageFromEntries(entries).calls).toHaveLength(2);
    const last = entries.at(-1);
    expect(last?.type === "message" && last.message.role === "assistant" && last.message.content).toContainEqual({ type: "text", text: "Final answer." });
    await session.acknowledgeDelivery(99);
    expect(delivered).toHaveBeenCalledWith(99);
  });

  it("uses only the current response's token delta when resuming a conversation without raw usage", async () => {
    const { session, client } = setup();
    client.run = id => {
      client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total: usage(1_000, 600, 200), last: usage(100, 60, 20) } });
      client.emit("item/completed", { turnId: id, item: { type: "agentMessage", text: "Resumed answer", phase: "final_answer" } });
      client.emit("turn/completed", { turn: { id, status: "completed" } });
    };
    await session.prompt("Continue");
    expect(session.getSessionStats().tokens).toEqual({ input: 40, output: 20, cacheRead: 60, cacheWrite: 0, total: 120 });
  });

  it("releases earlier tool preview payloads between turns while keeping lifetime stats and current usage accurate", async () => {
    const { session, client } = setup();
    const preview = "large-preview-base64-payload".repeat(1_000);
    mocks.execute.mockResolvedValue({ content: [{ type: "image", mimeType: "image/png", data: preview }], details: { preview }, isError: false });
    client.run = async id => {
      if (id === "turn-1") await client.call({ turnId: id, callId: "preview", tool: "inspect_workspace_images", arguments: { paths: ["/preview.png"] } });
      client.emit("rawResponse/completed", { turnId: id, responseId: id, usage: usage(100, 30, 20) });
      client.emit("turn/completed", { turn: { id, status: "completed" } });
    };
    await session.prompt("First request");
    expect(JSON.stringify(session.sessionManager.getEntries())).toContain(preview);
    const firstStats = session.getSessionStats();
    await session.prompt("Second request");
    const currentEntries = session.sessionManager.getEntries();
    expect(JSON.stringify(currentEntries)).not.toContain(preview);
    expect(currentEntries.every(entry => entry.id === "codex:turn-2")).toBe(true);
    expect(inferenceUsageFromEntries(currentEntries).totalTokens).toBe(120);
    const secondStats = session.getSessionStats();
    expect(secondStats.totalMessages).toBe(firstStats.totalMessages + currentEntries.length);
    expect(secondStats.tokens.total).toBe(240);
  });

  it("returns finish_response before interrupting and keeps its successful result last for delivery", async () => {
    const { session, client, bridge } = setup();
    let returned = false;
    const order: string[] = [];
    mocks.execute.mockResolvedValue({ content: [{ type: "text", text: "Done" }], details: { completed: true, text: "Ready for Telegram" }, isError: false, completed: true });
    const request = client.request.bind(client);
    client.request = async <T,>(method: string, params: unknown): Promise<T> => {
      if (method === "turn/interrupt") { expect(returned).toBe(true); order.push("interrupt"); }
      return request<T>(method, params);
    };
    client.run = async id => {
      client.emit("rawResponse/completed", { turnId: id, responseId: "finish-response", usage: usage(100, 30, 20) });
      const response = await client.call({ turnId: id, callId: "finish", tool: "finish_response", arguments: { text: "Ready for Telegram" } });
      expect(response).toEqual({ contentItems: [{ type: "inputText", text: "Done" }], success: true });
      returned = true; order.push("response");
    };
    await session.prompt("Simple question");
    expect(order).toEqual(["response", "interrupt"]);
    const last = session.sessionManager.getEntries().at(-1);
    expect(last).toMatchObject({ id: "codex:turn-1", message: { role: "toolResult", toolName: "finish_response", isError: false, details: { completed: true, text: "Ready for Telegram" } } });
    expect(bridge.prepareCommandFiles).not.toHaveBeenCalled();
  });

  it.each(["rawResponse/completed", "thread/tokenUsage/updated"])("waits for %s after an early terminal tool call so interruption preserves usage", async event => {
    const { session, client } = setup();
    mocks.execute.mockResolvedValue({ content: [{ type: "text", text: "Done" }], details: { completed: true, text: "Done" }, isError: false, completed: true });
    let responseReturned = false;
    client.run = async id => {
      client.emit("item/started", { turnId: id, item: { type: "dynamicToolCall", id: "finish", tool: "finish_response" } });
      const response = client.call({ turnId: id, callId: "finish", tool: "finish_response", arguments: { text: "Done" } }).then(result => { responseReturned = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(responseReturned).toBe(false);
      expect(client.requests.some(request => request.method === "turn/interrupt")).toBe(false);
      if (event === "rawResponse/completed") client.emit(event, { turnId: id, responseId: "terminal-response", usage: usage(100, 30, 20) });
      else client.emit(event, { turnId: id, tokenUsage: { total: usage(100, 30, 20), last: usage(100, 30, 20) } });
      expect(await response).toMatchObject({ success: true });
    };
    await session.prompt("Simple question");
    expect(inferenceUsageFromEntries(session.sessionManager.getEntries()).totalTokens).toBe(120);
    expect(responseReturned).toBe(true);
    expect(client.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
    expect(session.sessionManager.getEntries().at(-1)).toMatchObject({ message: { role: "toolResult", toolName: "finish_response" } });
  });

  it("acknowledges resumed terminal calls immediately and interrupts when post-tool aggregate usage arrives", async () => {
    const { session, client } = setup({ nativeRawEventsEnabled: () => false });
    mocks.execute.mockResolvedValue({ content: [{ type: "text", text: "Done" }], details: { completed: true, text: "Done" }, isError: false, completed: true });
    client.run = async id => {
      client.emit("item/started", { turnId: id, item: { type: "dynamicToolCall", id: "finish", tool: "finish_response" } });
      const response = await client.call({ turnId: id, callId: "finish", tool: "finish_response", arguments: { text: "Done" } });
      expect(response).toMatchObject({ success: true });
      expect(client.requests.some(request => request.method === "turn/interrupt")).toBe(false);
      // Upstream only reports aggregate usage after the tool result is accepted.
      client.emit("item/completed", { turnId: id, item: { type: "dynamicToolCall", id: "finish", status: "completed", success: true } });
      client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total: usage(1_000, 600, 200), last: usage(100, 60, 20) } });
      expect(client.requests.some(request => request.method === "turn/interrupt")).toBe(true);
    };
    await session.prompt("Simple question");
    expect(inferenceUsageFromEntries(session.sessionManager.getEntries()).totalTokens).toBe(120);
    expect(session.sessionManager.getEntries().at(-1)).toMatchObject({ message: { role: "toolResult", toolName: "finish_response" } });
  });

  it.each([false, true])("enforces native model cycles with raw events enabled=%s without double counting aggregate updates", async rawEvents => {
    const config = loadTestConfig({ PI_MAX_MODEL_CYCLES: 2 });
    const connection = bridge();
    const budget = new TurnBudget({ maxModelCycles: 2, maxToolCalls: 0, maxConsecutiveToolFailures: 0, maxIdenticalToolFailures: 0 });
    connection.currentTurnBudget = () => budget;
    const { session, client, unavailable } = setup({ config, bridge: connection, nativeRawEventsEnabled: () => rawEvents });
    client.run = id => {
      for (let cycle = 1; cycle <= 3; cycle++) {
        const total = usage(cycle * 100, cycle * 30, cycle * 20);
        if (rawEvents) client.emit("rawResponse/completed", { turnId: id, responseId: `cycle-${cycle}`, usage: usage(100, 30, 20) });
        // Aggregate notifications sometimes repeat with unchanged totals.
        client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total, last: usage(100, 30, 20) } });
        client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total, last: usage(100, 30, 20) } });
        if (cycle === 2) expect(budget.snapshot()).toMatchObject({ modelCycles: 2, terminationReason: undefined });
      }
    };
    await expect(session.prompt("A repeated tool task")).resolves.toBeUndefined();
    expect(budget.snapshot()).toMatchObject({ modelCycles: 3, terminationReason: "model_cycle_limit" });
    expect(client.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
    expect(unavailable).not.toHaveBeenCalled();
    expect(inferenceUsageFromEntries(session.sessionManager.getEntries()).totalTokens).toBe(360);
    expect(session.sessionManager.getEntries().at(-1)).toMatchObject({ message: { role: "assistant", stopReason: "aborted" } });
  });

  it("preserves a successful terminal result when the resumed model cycle exceeds its limit", async () => {
    const config = loadTestConfig({ PI_MAX_MODEL_CYCLES: 1 });
    const connection = bridge();
    const budget = new TurnBudget({ maxModelCycles: 1, maxToolCalls: 0, maxConsecutiveToolFailures: 0, maxIdenticalToolFailures: 0 });
    connection.currentTurnBudget = () => budget;
    const { session, client } = setup({ config, bridge: connection, nativeRawEventsEnabled: () => false });
    mocks.execute.mockResolvedValue({ content: [{ type: "text", text: "Done" }], details: { completed: true, text: "Done" }, isError: false, completed: true });
    client.run = async id => {
      client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total: usage(100, 30, 20), last: usage(100, 30, 20) } });
      const response = await client.call({ turnId: id, callId: "finish", tool: "finish_response", arguments: { text: "Done" } });
      expect(response).toMatchObject({ success: true });
      client.emit("thread/tokenUsage/updated", { turnId: id, tokenUsage: { total: usage(200, 60, 40), last: usage(100, 30, 20) } });
    };
    await expect(session.prompt("Complete the task")).resolves.toBeUndefined();
    expect(budget.snapshot().terminationReason).toBe("model_cycle_limit");
    expect(session.sessionManager.getEntries().at(-1)).toMatchObject({ message: { role: "toolResult", toolName: "finish_response", isError: false, details: { completed: true } } });
    expect(inferenceUsageFromEntries(session.sessionManager.getEntries()).totalTokens).toBe(240);
  });

  it("registers native generated images and passes incoming images without starting a sandbox", async () => {
    const connection = bridge();
    connection.selectedContextFileIds = () => new Set([12]);
    vi.mocked(connection.repos.files.listByIds).mockResolvedValue([{ id: 12, type: "image" }] as never);
    const artifact = vi.fn();
    const { session, client } = setup({ bridge: connection, onArtifact: artifact });
    client.run = id => {
      client.emit("item/completed", { turnId: id, item: { type: "imageGeneration", id: "image", status: "completed", savedPath: "/data/codex/generated_images/thread-1/image.png" } });
      client.emit("turn/completed", { turn: { id, status: "completed" } });
    };
    await session.prompt("Edit this image");
    expect(connection.registerNativeArtifact).toHaveBeenCalledWith("/data/codex/generated_images/thread-1/image.png");
    expect(artifact).toHaveBeenCalledOnce();
    expect(connection.prepareCommandFiles).not.toHaveBeenCalled();
    expect(client.requests.find(request => request.method === "turn/start")?.params).toMatchObject({ input: [expect.anything(), { type: "image", url: "data:image/png;base64,aW1hZ2U=" }] });
  });

  it("falls back on an availability error, retains native usage, rolls back the failed input, and uses fallback entry ids", async () => {
    const runFallback = vi.fn(async (input: OpenRouterTurnInput) => { const result = fallbackResult(); await input.onText?.(result.text); await input.onUsage?.(result.usage); return result; });
    const { session, client, delivered } = setup({ runFallback });
    client.run = id => {
      client.emit("rawResponse/completed", { turnId: id, responseId: "failed-response", usage: usage(40, 10, 5) });
      client.emit("turn/completed", { turn: { id, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" } } });
    };
    await session.prompt("Continue my chat");
    expect(runFallback).toHaveBeenCalledOnce();
    expect(client.requests).toContainEqual({ method: "thread/rollback", params: { threadId: "thread-1", numTurns: 1 } });
    const entries = session.sessionManager.getEntries();
    expect(entries[0]?.id).toMatch(/^openrouter:/);
    expect(inferenceUsageFromEntries(entries)).toMatchObject({ inputTokens: 60, outputTokens: 15, cacheReadTokens: 15, totalTokens: 90 });
    expect(session.model.id).toBe(loadTestConfig().OPENROUTER_MAIN_MODEL);
    await session.acknowledgeDelivery(100);
    expect(delivered).not.toHaveBeenCalled();
  });

  it("marks uncertain native history when rollback fails but still provides the rare fallback", async () => {
    const uncertain = vi.fn();
    const runFallback = vi.fn(async () => fallbackResult());
    const { session, client } = setup({ runFallback, onNativeHistoryUncertain: uncertain });
    client.rollbackFails = true;
    client.run = id => client.emit("turn/completed", { turn: { id, status: "failed", error: { message: "Unauthorized" } } });
    await session.prompt("Question");
    expect(uncertain).toHaveBeenCalledOnce();
    expect(runFallback).toHaveBeenCalledOnce();
  });

  it("reports an initial native failure as an error before notifying subscribers", async () => {
    const { session, client } = setup({ codexUnavailable: () => false });
    const reasons: string[] = [];
    session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant") reasons.push(event.message.stopReason);
    });
    client.run = id => client.emit("turn/completed", { turn: { id, status: "failed", error: { message: "Invalid tool call ID" } } });
    await expect(session.prompt("Continue")).rejects.toThrow("Invalid tool call ID");
    expect(reasons).toEqual(["error"]);
  });

  it.each(["text", "tool"])("does not replay a native turn after %s activity", async kind => {
    const runFallback = vi.fn(async () => fallbackResult());
    const { session, client } = setup({ runFallback });
    client.run = id => {
      if (kind === "text") client.emit("item/agentMessage/delta", { turnId: id, delta: "Partial answer" });
      else client.emit("item/started", { turnId: id, item: { type: "commandExecution", id: "exec", command: "write important-file", cwd: "/home/user/workspace" } });
      client.emit("turn/completed", { turn: { id, status: "failed", error: { message: "Network disconnected" } } });
    };
    await expect(session.prompt("Do the work")).rejects.toThrow("Network disconnected");
    expect(runFallback).not.toHaveBeenCalled();
    expect(client.requests.some(request => request.method === "thread/rollback")).toBe(false);
  });

  it("holds sandbox activity for native execution without creating or materializing the sandbox", async () => {
    const { session, client, bridge } = setup();
    client.run = id => {
      client.emit("item/started", { turnId: id, item: { type: "commandExecution", id: "command", command: "pwd" } });
      client.emit("item/completed", { turnId: id, item: { type: "commandExecution", id: "command", command: "pwd", status: "completed", exitCode: 0 } });
      client.emit("turn/completed", { turn: { id, status: "completed" } });
    };
    await session.prompt("Run a command");
    expect(bridge.holdCommandActivity).toHaveBeenCalled();
    expect(bridge.prepareCommandFiles).not.toHaveBeenCalled();
  });

  it("filters other threads and turns, aborts the running turn, and removes subscriptions on disposal", async () => {
    const { session, client } = setup();
    const events: AgentSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const running = session.prompt("Wait");
    await vi.waitFor(() => expect(client.requests.some(request => request.method === "turn/start")).toBe(true));
    client.emit("item/agentMessage/delta", { threadId: "other-thread", turnId: "turn-1", delta: "Other conversation" });
    client.emit("item/agentMessage/delta", { turnId: "old-turn", delta: "Other turn" });
    await session.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(events.filter(event => event.type === "message_update")).toHaveLength(0);
    expect(session.isStreaming).toBe(false);
    await session.dispose();
    expect(client.notifications.size).toBe(0);
    expect(client.handlers.size).toBe(0);
  });
});
